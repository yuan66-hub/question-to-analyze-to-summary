# 画布中 `transform` 偏移问题技术方案

## 一、背景

在画布、白板、流程图编辑器、节点拖拽器这类前端交互系统中，`transform` 偏移是高频问题。典型现象包括：

- 鼠标点在 A 点，节点却落在 B 点
- 缩放后拖拽越来越偏
- 容器滚动后命中区域不准确
- 节点拖拽过程中抖动、跳动、吸附异常
- 连线锚点、框选区域、实际节点位置彼此不一致

这类问题看起来像“拖拽不准”或“画布有偏移”，但根因通常不是单点 Bug，而是多个坐标系混用后没有统一。

---

## 二、核心结论

### 2.1 本质问题

`transform` 偏移的本质是：

**视觉坐标系、事件坐标系、数据坐标系没有对齐。**

常见的三套坐标系如下：

| 坐标系 | 来源 | 常见值 | 作用 |
|--------|------|--------|------|
| 视觉坐标系 | DOM/CSS 渲染 | `translate` / `scale` / `rotate` | 决定元素“看起来”在哪里 |
| 事件坐标系 | Pointer/Mouse 事件 | `clientX` / `clientY` | 决定交互输入从哪里来 |
| 数据坐标系 | 画布内部模型 | `node.x` / `node.y` / `worldX` | 决定真正绘制、命中和存储的位置 |

只要这三套坐标系没有统一，偏移问题就会持续出现。

### 2.2 关于幽灵节点的结论

幽灵节点（ghost node / drag preview）**可以优化拖拽体验，但不能替代坐标修正**。

它适合解决的问题：

- 拖拽过程中的抖动
- 真实节点参与布局导致的位置跳变
- 复杂拖拽时的视觉跟手反馈

它不能根治的问题：

- 鼠标坐标取错
- `canvas.width/height` 与 CSS 尺寸不一致
- 父容器 `transform` 后未做逆变换
- 世界坐标和屏幕坐标混用

因此推荐方案不是“只上幽灵节点”，而是：

**先统一坐标换算，再用幽灵节点优化拖拽链路。**

---

## 三、问题分类与根因分析

| 现象 | 常见根因 | 幽灵节点是否能解决 | 推荐处理 |
|------|----------|-------------------|----------|
| 点击落点偏一截 | 直接使用 `clientX/clientY`，未换算到本地坐标 | 否 | 使用统一的 `pointerToLocal()` |
| 缩放后偏移越来越明显 | `canvas` 实际像素尺寸与 CSS 尺寸不一致，或未处理 `devicePixelRatio` | 否 | 修正内部尺寸与 CSS 尺寸映射 |
| 拖拽中节点跳动、抖动 | 真实节点频繁参与布局、命中和重绘 | 是，通常有效 | 引入幽灵节点承接拖拽反馈 |
| 父容器缩放后命中错位 | 父层 `transform` 生效，但未做逆矩阵换算 | 部分缓解，不能根治 | 用矩阵逆变换做 `screenToWorld()` |
| 重绘后偏移越来越大 | `ctx.translate/scale` 多次叠加，未重置 transform | 否 | 每次绘制前 `resetTransform()` 或 `setTransform()` |

---

## 四、推荐技术方案

### 4.1 方案分层

推荐把方案拆成两层：

#### 第一层：统一坐标映射

目标是建立唯一可信的坐标入口，确保所有交互都从同一套换算逻辑进入。

建议统一抽象：

- `pointerToLocal(event, element)`
- `localToWorld(point, viewport)`
- `screenToWorld(event, element, viewport)`

所有点击、拖拽、框选、吸附、连线锚点计算，都使用这套映射，不允许每个事件处理函数各自修一遍坐标。

#### 第二层：幽灵节点隔离拖拽反馈

目标是把“用户看到的拖拽过程”和“系统真实提交的数据状态”分开。

推荐做法：

1. `dragstart` 时记录起点与节点原始位置
2. 创建幽灵节点，只负责视觉反馈
3. `dragmove` 时只更新幽灵节点位置
4. `drop` 时将最终世界坐标一次性提交给真实节点

这样可以显著减少：

- 拖拽过程中的节点跳动
- 真实节点重复参与布局和命中检测
- 复杂交互下的 rerender 抖动

### 4.2 推荐结论

对于大多数画布编辑器、流程图编辑器、白板类交互系统，推荐方案是：

**统一坐标换算 + 幽灵节点承接拖拽反馈 + drop 时提交真实状态**

---

## 五、实施细节

### 5.1 统一屏幕坐标到本地坐标

这是最基础的一步，适用于原始 `canvas` 或简单容器。

```js
function pointerToCanvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}
```

### 代码分析

这段代码解决的是“视口坐标到画布本地坐标”的一阶映射问题。

它依赖两个关键点：

1. `getBoundingClientRect()` 获取的是元素当前在视口中的真实显示尺寸
2. `canvas.width / rect.width` 反映的是“内部像素尺寸”和“外部显示尺寸”的比例

如果缺少这一步，点击位置和实际绘制位置很容易偏移。

### 5.2 统一本地坐标到世界坐标

如果编辑器存在缩放和平移，不能直接把本地坐标当作节点坐标，而要进一步映射到世界坐标。

```js
function localToWorld(point, viewport) {
  return {
    x: (point.x - viewport.translateX) / viewport.scale,
    y: (point.y - viewport.translateY) / viewport.scale,
  };
}

function pointerToWorld(event, canvas, viewport) {
  const local = pointerToCanvasPoint(event, canvas);
  return localToWorld(local, viewport);
}
```

### 代码分析

这里的核心思想是：

- `point` 是当前屏幕或本地可见区域中的点
- `viewport.translateX/Y` 表示当前视口平移
- `viewport.scale` 表示当前缩放倍数

通过“先减平移，再除以缩放”，才能还原出真实世界坐标。

如果跳过这一步，节点在缩放后拖动基本一定会偏。

### 5.3 父容器存在 CSS `transform` 时的处理

如果外层 DOM 还有 `scale()`、`rotate()`、`translate()`，建议不要再手写多组 if/else 修正，而是维护一份统一矩阵，使用逆矩阵做反投影。

思路如下：

```js
function screenToWorldByMatrix(clientPoint, inverseMatrix) {
  return {
    x:
      inverseMatrix.a * clientPoint.x +
      inverseMatrix.c * clientPoint.y +
      inverseMatrix.e,
    y:
      inverseMatrix.b * clientPoint.x +
      inverseMatrix.d * clientPoint.y +
      inverseMatrix.f,
  };
}
```

更完整的工程实现里，通常会直接使用 `DOMMatrix` 或图形库提供的投影/反投影 API。

### 代码分析

这个方案适合：

- 白板编辑器
- SVG 编辑器
- 多层缩放容器
- 流程图和节点编排系统

因为此时已经不是简单的线性宽高比问题，而是完整的坐标变换链问题。

### 5.4 幽灵节点的标准用法

```js
function onDragStart(node, pointer) {
  dragState = {
    nodeId: node.id,
    startPointer: pointer,
    startNodePos: { x: node.x, y: node.y },
    ghostVisible: true,
  };
}

function onDragMove(pointer) {
  const dx = pointer.x - dragState.startPointer.x;
  const dy = pointer.y - dragState.startPointer.y;

  ghost.style.transform = `translate(${dragState.startNodePos.x + dx}px, ${dragState.startNodePos.y + dy}px)`;
}

function onDragEnd(pointer) {
  const dx = pointer.x - dragState.startPointer.x;
  const dy = pointer.y - dragState.startPointer.y;

  updateNode(dragState.nodeId, {
    x: dragState.startNodePos.x + dx,
    y: dragState.startNodePos.y + dy,
  });

  dragState = null;
}
```

### 代码分析

这段代码的重点不是“怎么移动节点”，而是“拖拽时不要立刻改真实节点”。

其好处包括：

- 拖拽中视觉更稳定
- 真实节点不会在拖动期间反复触发布局和重绘
- 命中测试、连线刷新、吸附计算可以延后到提交阶段

需要注意的是，这里的 `pointer` 必须已经是统一换算后的本地坐标或世界坐标；如果输入坐标本身就是错的，幽灵节点也会跟着一起错。

### 5.5 处理高 DPI 与内部尺寸同步

```js
function setupCanvas(canvas, cssWidth, cssHeight, ctx) {
  const dpr = window.devicePixelRatio || 1;

  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
}
```

### 代码分析

这一步解决的是“画布显示尺寸”和“内部像素尺寸”不一致的问题。

如果只改了样式宽高，没有同步内部尺寸，常见后果有：

- 点击位置不准
- 绘制位置偏移
- 高清屏下文字和线条模糊

---

## 六、不同场景下的方案选择

### 6.1 纯 HTML Canvas 绘图板

#### 常见问题

- 点位偏移
- 画笔落点不准确
- 缩放后绘制坐标错位

#### 优先方案

优先修正：

- `getBoundingClientRect()`
- `canvas.width/height`
- CSS 尺寸
- `devicePixelRatio`
- `viewport` 坐标映射

#### 是否需要幽灵节点

通常不需要。纯 Canvas 的核心问题多数是坐标和尺寸映射，而不是拖拽架构。

### 6.2 SVG / 白板编辑器

#### 常见问题

- 缩放后命中区域错位
- 连线锚点偏移
- 框选区域与实际元素位置不一致

#### 优先方案

优先建立统一的 `screenToWorld()`，必要时基于矩阵逆变换实现。

#### 是否需要幽灵节点

可选。若拖拽元素较多、交互复杂，可以引入，但不是首要修复项。

### 6.3 流程图 / 节点编辑器

#### 常见问题

- 拖拽抖动
- 连线刷新异常
- 节点吸附、框选、命中范围不一致

#### 优先方案

必须先有世界坐标抽象，再考虑拖拽链路优化。

推荐模型：

```text
screen point -> local point -> world point -> node model
```

在此基础上，使用幽灵节点承接拖拽视觉反馈。

#### 是否需要幽灵节点

强烈建议。这类系统最容易受布局、命中和渲染链路叠加影响。

### 6.4 普通 DOM 拖拽列表

#### 常见问题

- 父级 `transform` 后拖拽跟手误差
- 滚动容器中的拖拽位置不准
- CSS 过渡导致元素视觉跳动

#### 优先方案

建议引入统一拖拽层和幽灵节点，同时将坐标换算收口到单一入口。

#### 是否需要幽灵节点

建议使用，收益通常较高。

### 6.5 使用现成图形库的场景

比如：

- React Flow
- Konva
- Fabric.js
- PixiJS

#### 优先方案

优先使用库提供的坐标投影/反投影 API，不要绕开库自己重新算一套。

#### 是否需要幽灵节点

按库的推荐模式决定。如果库本身已经有 drag preview 或 world transform 能力，应优先复用。

---

## 七、注意事项与常见反模式

### 7.1 在每个事件里临时修坐标

#### 问题

逻辑分散，后续引入缩放、滚动、嵌套容器后容易漏改。

#### 建议

统一通过 `screenToWorld()` 或 `pointerToLocal()` 收口。

### 7.2 同时使用 DOM `transform` 和 `ctx.scale`

#### 问题

两套变换叠加后，排查难度会快速上升。

#### 建议

只保留一套主变换源。若必须共存，也要有统一的世界坐标抽象。

### 7.3 拖拽中持续写真实数据

#### 问题

会导致：

- 频繁 rerender
- 真实节点反复参与布局
- 命中区域不稳定
- 连线和吸附链路噪音增多

#### 建议

拖拽中更新幽灵节点，提交时再写真实模型。

### 7.4 依赖 `offsetLeft/offsetTop`

#### 问题

一旦遇到滚动、嵌套定位、`transform`，这些值很容易不再可信。

#### 建议

优先使用 `getBoundingClientRect()`。

### 7.5 多次 `translate/scale` 后不重置

#### 问题

偏移会在重绘中累计，问题往往越来越隐蔽。

#### 建议

每轮绘制前先：

```js
ctx.setTransform(1, 0, 0, 1, 0, 0);
```

或：

```js
ctx.resetTransform();
```

---

## 八、建议的工程落地顺序

建议按以下顺序推进修复：

1. 抽出统一的 `pointerToLocal()` / `screenToWorld()` 工具
2. 清理重复或分散的 transform 逻辑，确认唯一主坐标源
3. 修正 `canvas` 内部尺寸、CSS 尺寸和 `devicePixelRatio`
4. 对有复杂拖拽链路的场景引入幽灵节点
5. 为点击、拖拽、缩放、滚动建立回归用例

---

## 九、测试与验收建议

### 9.1 最低回归用例

至少覆盖以下场景：

1. 默认缩放下点击与拖拽是否准确
2. 125% / 150% / 200% 缩放下是否仍然准确
3. 容器滚动后命中是否准确
4. 高 DPI 屏幕下绘制与点击是否一致
5. 拖拽中节点是否抖动、跳变

### 9.2 验收标准

可以采用以下标准：

- 鼠标点击点与实际落点误差在可接受范围内
- 缩放和平移后，拖拽、命中、框选结果保持一致
- 拖拽过程中节点视觉稳定，无明显抖动
- 连线锚点、框选区域和节点位置使用同一坐标系

---

## 十、最终结论

`transform` 偏移问题，本质上不是“拖拽算法不准”，而是“坐标系统没有统一”。

工程上最可靠的做法是：

1. 先建立统一坐标映射
2. 再用幽灵节点隔离拖拽反馈
3. 最后通过回归用例保证缩放、滚动、DPI、拖拽链路的一致性

一句话总结：

**幽灵节点能优化拖拽体验，但不能修复错误坐标；真正要解决偏移，必须先统一坐标系。**
