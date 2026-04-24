# ZPL-Image + Canvas 双渲染架构方案

## 一、背景与目标

在标签编辑器、条码打印编辑器、POD 标签模板系统这类场景中，前端通常会同时面对两类要求：

1. 编辑态要求高交互、低延迟、可拖拽、可吸附、可多选、可实时预览
2. 输出态要求高保真、可预测，并尽可能接近打印机最终解释 ZPL 后的结果

这两类要求天然冲突：

- 只用 `Canvas`，交互体验好，但浏览器图形语义不等于打印语义
- 只用 `ZPL` 或打印机预览图，结果更接近真实打印，但几乎不适合作为高频交互编辑层

因此，`ZPL-Image + Canvas` 双渲染架构的核心目标不是“多渲染一次”，而是把同一份标签数据拆分为两条职责不同的渲染链路：

- `Canvas Renderer` 负责编辑态渲染与交互反馈
- `ZPL/Image Renderer` 负责打印态表达与结果校验

其本质是：

**用一份统一中间模型，同时支撑“高频交互视图”和“高保真打印视图”。**

---

## 二、它到底在解决什么问题

如果没有双渲染，系统通常会落入两类问题。

### 2.1 只用 Canvas 的问题

`Canvas` 适合做图形编辑，但它表达的是浏览器绘图语义，而不是打印机语义。常见偏差包括：

- 浏览器字体度量和打印机内建字体度量不一致
- 条码、二维码在前端渲染尺寸正确，但生成 ZPL 后打印尺寸偏差
- 坐标原点、锚点、旋转中心在前端和打印机端不同
- 物理单位换算不严格，`px / mm / inch / dpi` 之间容易出现累计误差
- 前端看上去“差不多”，实际打印边距、截断、换行、缩放都可能出问题

### 2.2 只用 ZPL 预览链路的问题

如果直接围绕 ZPL 做编辑：

- 交互能力很弱，很难做对象级拖拽和命中测试
- 每次移动都重新生成 ZPL 或远端预览，时延高
- 很难实现辅助线、控制点、吸附、选区框、多选变换
- 不适合构建现代编辑器的操作体验

### 2.3 双渲染要解决的核心矛盾

双渲染要同时解决以下四类工程问题：

1. **交互性能问题**：拖拽、缩放、框选不能依赖重型打印渲染链路
2. **打印一致性问题**：编辑态结果不能只靠浏览器绘制来“猜”打印结果
3. **职责混乱问题**：编辑层、输出层、预览层混在一起会导致模型难维护
4. **结果校验问题**：需要一种比 Canvas 更接近打印结果的校验视图

---

## 三、总体架构

推荐采用“统一模型 + 双渲染投影 + 调度器”的分层方案。

```text
┌────────────────────────────────────────────────────┐
│                    UI Layer                        │
│  工具栏 / 属性面板 / 图层面板 / 模板管理 / 操作栏  │
└────────────────────────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────┐
│                Label Editor Model                  │
│  统一标签 DSL / Scene JSON / 单位系统 / 约束规则    │
│  - objects                                          │
│  - page size                                        │
│  - dpi                                              │
│  - safe area                                        │
│  - print options                                    │
└────────────────────────────────────────────────────┘
              │                         │
              │                         │
              ▼                         ▼
┌───────────────────────┐    ┌────────────────────────┐
│   Canvas Renderer     │    │    ZPL Generator       │
│  编辑态投影与交互层     │    │  打印态表达生成层        │
│                       │    │                        │
│ - 拖拽/缩放/旋转       │    │ - JSON -> ZPL          │
│ - 命中测试             │    │ - 字体/条码映射         │
│ - 控制点/辅助线         │    │ - 单位换算              │
│ - 快速局部重绘         │    │ - 位置与尺寸固化        │
└───────────────────────┘    └────────────────────────┘
              │                         │
              │                         ▼
              │              ┌────────────────────────┐
              │              │  ZPL Image Renderer    │
              │              │  打印结果预览/校验层      │
              │              │                        │
              │              │ - ZPL -> PNG/Bitmap    │
              │              │ - 本地或远端预览服务      │
              │              │ - 与打印结果语义一致      │
              │              └────────────────────────┘
              │                         │
              └──────────────┬──────────┘
                             ▼
                 ┌────────────────────────┐
                 │  Dual Render Controller │
                 │  调度、节流、一致性校验   │
                 └────────────────────────┘
```

### 3.1 分层原则

这套架构必须满足三个约束：

1. **统一模型是唯一事实源**
   `Canvas` 和 `ZPL` 都不能成为源数据，二者只是投影

2. **编辑态与输出态职责分离**
   编辑链路负责响应快，输出链路负责语义准

3. **双链路必须可比较**
   当 `Canvas` 预览与 `ZPL Image` 预览不一致时，系统要能定位偏差来自哪里

---

## 四、核心模块划分

### 4.1 Label Editor Model

这是整个系统的中心层，也是最关键的一层。

它至少要统一以下内容：

- 页面尺寸：宽、高、打印方向、单位
- 打印精度：`dpi`
- 对象列表：文字、图片、条码、二维码、线条、矩形等
- 布局属性：`x/y/width/height/rotation/anchor`
- 业务属性：字体名、条码类型、纠错级别、缩放规则、裁剪规则
- 导出规则：是否允许转图片、是否使用打印机字库、是否内嵌资源

推荐数据结构示例：

```ts
type Unit = 'px' | 'mm' | 'inch' | 'dot';

interface LabelDocument {
  id: string;
  page: {
    width: number;
    height: number;
    unit: Unit;
    dpi: number;
    background?: string;
  };
  safeArea?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
    unit: Unit;
  };
  objects: LabelObject[];
  printOptions: {
    density?: number;
    mirror?: boolean;
    rotate?: 0 | 90 | 180 | 270;
  };
}

type LabelObject =
  | TextObject
  | ImageObject
  | BarcodeObject
  | QrCodeObject
  | RectObject
  | LineObject;

interface BaseObject {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  unit?: Unit;
  visible?: boolean;
}

interface TextObject extends BaseObject {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight?: 'normal' | 'bold';
  align?: 'left' | 'center' | 'right';
}

interface BarcodeObject extends BaseObject {
  type: 'barcode';
  symbology: 'code128' | 'ean13' | 'code39';
  value: string;
  humanReadable?: boolean;
}

interface QrCodeObject extends BaseObject {
  type: 'qrcode';
  value: string;
  errorCorrection?: 'L' | 'M' | 'Q' | 'H';
}
```

### 为什么这一层最重要

因为一旦模型层设计错误，后续会出现两个问题：

1. `Canvas` 能渲染但 `ZPL` 无法表达
2. `ZPL` 能表达但编辑器无法稳定交互

所以模型层不是简单存 UI 状态，而是要存一份可同时服务交互和打印的“中间表示”。

---

### 4.2 Canvas Renderer

`Canvas Renderer` 是编辑态渲染器，不直接承担打印准确性，而是承担“用户可操作”的职责。

它主要负责：

- 把统一模型投影成屏幕上的可交互对象
- 提供拖拽、缩放、旋转、多选、对齐吸附
- 绘制辅助线、控制点、选中边框、安全区域
- 在高频操作时保证帧率

其关键原则是：

**Canvas 负责“编辑体验”，不负责定义打印语义。**

推荐接口：

```ts
interface CanvasRenderer {
  mount(container: HTMLCanvasElement): void;
  render(doc: LabelDocument): void;
  setSelection(ids: string[]): void;
  hitTest(point: { x: number; y: number }): string | null;
  destroy(): void;
}
```

典型实现：

```ts
class EditorCanvasRenderer implements CanvasRenderer {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;

  mount(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  render(doc: LabelDocument) {
    this.clear();
    this.drawPage(doc.page);

    for (const obj of doc.objects) {
      if (!obj.visible) continue;
      this.drawObject(obj, doc.page.dpi);
    }

    this.drawSafeArea(doc.safeArea, doc.page);
    this.drawSelectionOverlay();
  }

  private clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private drawObject(obj: LabelObject, dpi: number) {
    switch (obj.type) {
      case 'text':
        this.drawText(obj, dpi);
        break;
      case 'barcode':
        this.drawBarcodePreview(obj, dpi);
        break;
      case 'qrcode':
        this.drawQrPreview(obj, dpi);
        break;
      default:
        this.drawShapeOrImage(obj, dpi);
    }
  }
}
```

### 这一层不应该做什么

不建议在 `Canvas Renderer` 内直接做以下事情：

- 生成最终 ZPL
- 存储打印机专属字段
- 维护打印资源下载逻辑
- 使用 Canvas 结果反向覆盖模型层

否则很容易把“编辑投影”和“打印表达”混成一层。

---

### 4.3 ZPL Generator

`ZPL Generator` 的职责是把统一模型转换为打印机可执行的表达。

它不是简单模板拼接器，而是一个规则转换层。主要负责：

- 坐标和单位换算
- 字体映射
- 条码命令映射
- 图片转位图或图像命令
- 旋转、锚点、对齐在打印语义下的重计算

推荐接口：

```ts
interface ZplGenerator {
  generate(doc: LabelDocument): string;
}
```

实现示例：

```ts
class ZebraZplGenerator implements ZplGenerator {
  generate(doc: LabelDocument): string {
    const lines: string[] = ['^XA'];

    for (const obj of doc.objects) {
      if (!obj.visible) continue;
      lines.push(this.objectToZpl(obj, doc));
    }

    lines.push('^XZ');
    return lines.join('\n');
  }

  private objectToZpl(obj: LabelObject, doc: LabelDocument): string {
    switch (obj.type) {
      case 'text':
        return this.textToZpl(obj, doc);
      case 'barcode':
        return this.barcodeToZpl(obj, doc);
      case 'qrcode':
        return this.qrToZpl(obj, doc);
      case 'image':
        return this.imageToZpl(obj, doc);
      default:
        return '';
    }
  }
}
```

### 关键工程点

这一层要严格处理“物理尺寸”和“打印点阵”之间的换算。

例如：

```ts
function mmToDot(mm: number, dpi: number): number {
  return Math.round((mm / 25.4) * dpi);
}

function pxToDot(px: number, sourceDpi: number, printerDpi: number): number {
  return Math.round((px / sourceDpi) * printerDpi);
}
```

如果系统没有明确单位系统，这一层几乎一定会积累偏差。

---

### 4.4 ZPL Image Renderer

这一层的职责是：

**把生成后的 ZPL 再解释成图像，形成接近真实打印结果的预览。**

这可以是：

- 本地 ZPL 解释器
- 服务端预览服务
- 第三方 ZPL 渲染服务
- 打印驱动或打印模拟器生成的位图

推荐接口：

```ts
interface ZplPreviewRenderer {
  render(zpl: string, options?: { dpi?: number }): Promise<string>;
}
```

其中返回值可以是：

- `data URL`
- 图片地址
- `Blob URL`
- `ImageBitmap`

示例：

```ts
class RemoteZplPreviewRenderer implements ZplPreviewRenderer {
  async render(zpl: string, options?: { dpi?: number }) {
    const response = await fetch('/api/zpl/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        zpl,
        dpi: options?.dpi ?? 203,
      }),
    });

    const data = await response.json();
    return data.imageUrl as string;
  }
}
```

### 这一层为什么不能省略

因为很多项目里，“导出 ZPL” 不等于 “用户相信结果正确”。

用户通常仍然需要看到一个接近打印结果的校验视图，用来回答这些问题：

- 字体是否错位
- 条码是否过窄
- 旋转后位置是否偏移
- 边距是否越界
- 某些对象是否超出可打印区域

因此它本质是“输出校验层”。

---

### 4.5 Dual Render Controller

这层是双渲染架构的调度中心，负责：

- 接收模型变化
- 立即刷新 `Canvas`
- 延迟刷新 `ZPL Image Preview`
- 做节流、防抖、并发取消
- 追踪当前预览是否过期

推荐接口：

```ts
class DualRenderController {
  constructor(
    private canvasRenderer: CanvasRenderer,
    private zplGenerator: ZplGenerator,
    private zplPreviewRenderer: ZplPreviewRenderer
  ) {}

  private previewJobId = 0;

  async update(doc: LabelDocument) {
    this.canvasRenderer.render(doc);
    this.schedulePreview(doc);
  }

  private schedulePreview(doc: LabelDocument) {
    const jobId = ++this.previewJobId;

    window.clearTimeout((this as any)._timer);
    (this as any)._timer = window.setTimeout(async () => {
      const zpl = this.zplGenerator.generate(doc);
      const imageUrl = await this.zplPreviewRenderer.render(zpl, {
        dpi: doc.page.dpi,
      });

      if (jobId !== this.previewJobId) return;
      this.commitPreview(imageUrl, zpl);
    }, 120);
  }

  private commitPreview(imageUrl: string, zpl: string) {
    previewStore.setState({
      imageUrl,
      zpl,
      status: 'ready',
    });
  }
}
```

### 调度层必须控制的几个问题

1. 高频拖拽不能频繁打爆预览服务
2. 较慢的旧预览结果不能覆盖较新的编辑状态
3. 预览失败时不能影响编辑器主链路
4. 预览状态必须可见，例如“更新中”“失败”“已同步”

---

## 五、核心数据流

推荐把整个系统的数据流拆成三条：

### 5.1 编辑链路

```text
用户操作
  -> 更新 Label Editor Model
  -> Canvas Renderer 立即重绘
  -> UI 返回即时反馈
```

这条链路要求快，目标是交互体验。

### 5.2 打印表达链路

```text
Label Editor Model
  -> ZPL Generator
  -> 生成 ZPL 字符串
```

这条链路要求准，目标是打印表达可执行。

### 5.3 打印校验链路

```text
ZPL 字符串
  -> ZPL Image Renderer
  -> 预览图
  -> 用户确认与校验
```

这条链路要求接近真实打印结果，目标是“所见接近所得”。

### 5.4 为什么不能直接用 Canvas 结果做打印

因为 `Canvas` 渲染结果只是编辑器的一种视觉投影，不一定满足：

- 打印机字体能力
- 条码命令能力
- 打印头点阵限制
- 真正的 ZPL 指令约束

在低要求场景里可以把 `Canvas` 导出为图片后再打印，但那实际上已经不是“结构化打印表达”了，而是“位图打印”。

---

## 六、典型场景分析

### 6.1 场景一：用户拖拽文字与图片

### 用户动作

用户把一个文本框从左上角拖到中间，并把一张 logo 图片缩小。

### 系统内部应该怎么工作

1. Pointer 事件命中 `Canvas` 中的对象
2. 交互层更新模型中的对象位置与尺寸
3. `Canvas Renderer` 立即重绘选中框、控制点和对象视觉位置
4. `DualRenderController` 做一次防抖
5. 停顿后重新生成 ZPL
6. 再异步刷新 ZPL 预览图

### 这一场景中双渲染解决了什么

- 拖拽过程流畅，因为主反馈来自 `Canvas`
- 打印预览可信，因为最终仍通过 `ZPL -> Image` 校验
- 即使远端预览慢，也不影响当前操作

如果只有单渲染：

- 只用 ZPL 预览会导致拖拽卡顿
- 只用 Canvas 又无法校验打印一致性

---

### 6.2 场景二：条码预览与实际打印一致性

### 用户动作

用户新建一个 `Code128` 条码，输入订单号，并手动调整宽高。

### 风险点

条码和普通图形不同，它不是“看起来像条码”就可以。实际打印时还涉及：

- 窄条宽度
- 高度
- 是否显示人类可读字符
- 扫码枪识别容错
- 打印机 DPI 对模块宽度的限制

### 推荐处理

在模型层只保留抽象语义：

```ts
{
  type: 'barcode',
  symbology: 'code128',
  value: 'ORDER-20260424',
  width: 42,
  height: 12,
  unit: 'mm',
  humanReadable: true
}
```

然后：

- `Canvas Renderer` 用浏览器条码库画出编辑态预览
- `ZPL Generator` 转成对应的 `^BC` 等命令
- `ZPL Image Renderer` 再把 ZPL 解释为真实预览图

### 这一场景中双渲染解决了什么

它把“用户编辑体验”和“条码打印正确性”解耦了。

前者由 `Canvas` 承担，后者由 `ZPL` 链路承担。

---

### 6.3 场景三：模板保存、再次打开、最终打印

### 用户动作

用户编辑好一张发货标签模板，保存后隔天再次打开，并发起正式打印。

### 推荐流程

1. 保存时持久化的是 `Label Editor Model`
2. 再次打开时，先根据模型恢复 `Canvas` 编辑态
3. 同时后台生成一份最新 ZPL
4. 打印前，以当前模型重新生成 ZPL，而不是依赖旧快照

### 为什么不能直接保存 Canvas 快照

因为 `Canvas` 快照只能恢复视觉结果，不能可靠恢复：

- 条码语义
- 打印选项
- 文本的打印机字体映射策略
- 结构化布局信息

所以真正应该保存的是“结构化中间模型”，而不是单纯位图。

---

## 七、关键实现建议

### 7.1 坐标和单位系统必须统一

这是整个方案中最容易被低估的地方。

建议统一规范：

- 模型内部统一使用一种主单位，例如 `mm`
- 编辑层按视口缩放成 `px`
- 输出层再根据 `dpi` 转成 `dot`

示例：

```ts
function modelToCanvasPx(value: number, zoom: number, dpi: number) {
  const pxPerMmAtBase = dpi / 25.4;
  return value * pxPerMmAtBase * zoom;
}

function modelToPrinterDot(valueMm: number, dpi: number) {
  return Math.round((valueMm / 25.4) * dpi);
}
```

如果这一层不统一，后续会出现：

- 画布中看起来对齐，但 ZPL 中偏移
- 旋转后中心点错位
- 条码尺寸与实际打印不一致

---

### 7.2 字体策略必须前置设计

文字是双渲染里最容易出现不一致的对象。

推荐优先明确三种策略中的哪一种：

1. **仅使用打印机内建字体**
   一致性高，但设计能力弱

2. **前端任意字体，输出时转图片**
   一致性强，但文本失去打印语义

3. **前端字体 + 打印机字体映射表**
   工程上最常见，但要接受一定差异

推荐模型中单独保留字体映射信息：

```ts
interface TextObject extends BaseObject {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  printerFont?: string;
  renderStrategy?: 'native-font' | 'bitmap-text';
}
```

---

### 7.3 图片资源要做缓存与去重

图片对象进入 ZPL 链路时，常常需要转位图或特殊编码。

建议做：

- 图片资源 hash
- 编码结果缓存
- 相同图片复用编码输出
- 预览图和打印图使用同一份资源版本

否则在模板复杂时，预览生成成本会明显升高。

---

### 7.4 调度层要有“版本号”概念

很多双渲染系统的 bug 并不出在渲染算法，而出在异步结果覆盖。

典型错误流程：

1. 用户改动 A，触发预览任务 1
2. 用户继续改动 B，触发预览任务 2
3. 任务 2 先返回
4. 任务 1 后返回并覆盖任务 2 的结果

因此调度层必须给每次模型变更分配版本号，并只提交最新版本的预览结果。

---

## 八、建议的工程目录

如果要把这套架构落到实际项目中，推荐目录边界如下：

```text
src/
  editor-model/
    label-document.ts
    unit-conversion.ts
    object-schema.ts

  canvas-renderer/
    canvas-renderer.ts
    selection-overlay.ts
    hit-testing.ts
    draw-text.ts
    draw-barcode-preview.ts

  zpl/
    zpl-generator.ts
    zpl-font-mapper.ts
    zpl-barcode-mapper.ts
    zpl-image-encoder.ts

  preview/
    zpl-preview-renderer.ts
    preview-cache.ts

  controller/
    dual-render-controller.ts
    render-job-manager.ts

  store/
    editor-store.ts
    preview-store.ts
```

这种拆法的重点是：

- 模型层独立
- `Canvas` 与 `ZPL` 解耦
- 预览服务层单独抽象
- 调度逻辑不要混进 UI 组件

---

## 九、适用边界

这套架构适合：

- 标签编辑器
- Zebra 打印模板系统
- 条码/二维码打印平台
- POD 中带结构化打印输出的场景
- 需要“编辑器体验 + 打印一致性”的系统

这套架构不一定适合：

- 只需要前端截图打印的小工具
- 没有结构化打印要求、直接导出图片即可的场景
- 简单静态模板，没有交互编辑器需求的页面

如果系统只需要“画完导出 PNG”，那么上双渲染通常是过度设计。

---

## 十、总结

`ZPL-Image + Canvas` 双渲染架构解决的不是单纯的渲染性能问题，也不是单纯的预览问题，而是：

**如何让一套标签编辑系统同时拥有现代编辑器的交互体验，以及接近真实打印结果的输出可信度。**

其关键不是“同时维护两个 UI”，而是建立下面这个稳定结构：

1. 用统一中间模型承载标签语义
2. 用 `Canvas` 负责编辑态投影
3. 用 `ZPL` 负责打印态表达
4. 用 `ZPL Image` 负责结果校验
5. 用调度层控制双链路同步、节流和版本一致性

当这几层边界清晰后，系统才能真正做到：

- 编辑时流畅
- 预览时可信
- 打印时可控
- 演进时可维护

---

## 附录：最小可运行伪代码串联

下面给出一段最小化串联示例，用来展示双渲染链路如何在工程中协同工作。

```ts
async function onDocumentChange(doc: LabelDocument) {
  // 1. 编辑态立即更新
  canvasRenderer.render(doc);

  // 2. 异步生成打印表达
  const zpl = zplGenerator.generate(doc);

  // 3. 生成打印预览图
  const imageUrl = await zplPreviewRenderer.render(zpl, {
    dpi: doc.page.dpi,
  });

  // 4. 更新预览面板
  previewStore.setState({
    imageUrl,
    zpl,
    updatedAt: Date.now(),
  });
}
```

如果需要进一步增强，这里还可以继续扩展：

- 增量渲染
- diff-based ZPL 更新
- 资源缓存
- 渲染任务取消
- Canvas 与打印预览差异对比

这些都应建立在前文的统一模型和双渲染边界之上，而不是在一个单体渲染器里不断打补丁。
