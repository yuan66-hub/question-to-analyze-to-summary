# AI 图像标注与处理端侧工程方案

> 面向浏览器端 AI 图像标注、检测、分割与图像处理场景，从推理工程、GPU/WASM 加速、调度、算法管线、性能优化到内存资源控制的完整方案设计。

---

## 目录

1. [方案目标与适用场景](#1-方案目标与适用场景)
2. [总体架构设计](#2-总体架构设计)
3. [任务抽象与模型适配](#3-任务抽象与模型适配)
4. [图像处理管线构建](#4-图像处理管线构建)
5. [端侧 AI 推理工程设计](#5-端侧-ai-推理工程设计)
6. [浏览器 GPU 计算加速](#6-浏览器-gpu-计算加速)
7. [WebAssembly 高性能计算加速](#7-webassembly-高性能计算加速)
8. [推理 Backend 调度设计](#8-推理-backend-调度设计)
9. [多线程推理调度与实时流处理](#9-多线程推理调度与实时流处理)
10. [模型工程优化](#10-模型工程优化)
11. [图像预处理与后处理算法](#11-图像预处理与后处理算法)
12. [推理性能优化](#12-推理性能优化)
13. [浏览器内存管理与资源控制](#13-浏览器内存管理与资源控制)
14. [参考落地架构](#14-参考落地架构)
15. [面试表达与方案亮点总结](#15-面试表达与方案亮点总结)

---

## 1. 方案目标与适用场景

这套方案的目标不是单点地“把模型跑起来”，而是在浏览器中构建一套可持续迭代的 **AI 图像标注与处理平台能力**，满足以下诉求：

- 支持本地图像标注、检测框、语义分割、实例分割、关键点、OCR 辅助标注等任务
- 支持图片上传、相机流、视频帧、批量文件的统一处理链路
- 在浏览器内完成模型推理、图像预处理、后处理、可视化渲染与结果导出
- 根据设备能力自动选择 `WebGL / WASM / CPU fallback`
- 在大图与实时流场景中兼顾吞吐、延迟、精度与资源占用
- 保障隐私数据不出端，满足离线运行与弱网场景

**典型应用场景：**

- 智能标注平台：目标检测框、分割蒙版、关键点辅助标注
- 图片审核与分类：端侧预筛选、低成本批处理
- 实时视觉应用：摄像头流检测、背景分割、交互式抠图
- 工业图像处理：大图缺陷检测、瓦片级推理、局部复检
- 医疗/隐私场景：本地图像处理，不上传原始数据

---

## 2. 总体架构设计

```
┌────────────────────────────────────────────────────────────────────┐
│                         应用层 (React / Vue)                       │
│ 文件输入 / 相机流 / 标注交互 / 图层渲染 / 结果导出 / 配置面板       │
├────────────────────────────────────────────────────────────────────┤
│                          调度编排层                                │
│ 任务队列 │ 帧调度 │ Tile 调度 │ Backend 选择 │ 内存回收 │ 降级策略   │
├────────────────────────────────────────────────────────────────────┤
│                         算法处理管线层                              │
│ 解码 → Resize → Normalize → Tensor 化 → Inference → NMS/Mask → 渲染 │
├────────────────────────────────────────────────────────────────────┤
│                         推理与计算引擎层                            │
│   ONNX Runtime Web / TFJS / MediaPipe / 自定义 WebGL / WASM Kernel │
├────────────────────────────────────────────────────────────────────┤
│                         浏览器能力层                                │
│ WebGL │ WebGPU │ WebAssembly │ Web Worker │ OffscreenCanvas │ SAB   │
├────────────────────────────────────────────────────────────────────┤
│                         硬件资源层                                  │
│       GPU (独显/集显)            CPU (x86/ARM)         NPU          │
└────────────────────────────────────────────────────────────────────┘
```

### 2.1 分层原则

- **UI 层不直接关心推理细节**：只负责输入、交互、渲染、结果展示
- **调度层负责“何时算、在哪算、算多少”**：统一控制优先级、并发度、资源预算
- **算法层负责“怎么算”**：封装预处理、推理、后处理算子
- **引擎层负责“用什么算”**：选择 WebGL、WASM 或 CPU
- **资源层负责“能不能长期稳定跑”**：控制 GPU/CPU/内存占用

### 2.2 核心设计目标

| 维度 | 目标 |
|------|------|
| 延迟 | 单帧推理延迟尽可能控制在 16ms~100ms 区间 |
| 吞吐 | 支持批量图像和连续视频帧处理 |
| 可用性 | 后端不可用时可自动降级 |
| 兼容性 | 覆盖 Chrome/Edge 主流环境，兼容低端设备 |
| 精度 | 尽量在量化与裁剪后维持可接受精度 |
| 可维护性 | 模型、Backend、前后处理可插拔 |

---

## 3. 任务抽象与模型适配

AI 图像标注与处理平台通常不是单一任务，而是多个任务复用同一条工程链路。

### 3.1 任务统一抽象

```ts
type VisionTask =
  | 'classification'
  | 'detection'
  | 'semantic-segmentation'
  | 'instance-segmentation'
  | 'pose-estimation'
  | 'ocr-assist';
```

### 3.2 通用输入输出约定

**输入：**

- 原始图片：`File / Blob / ImageBitmap / VideoFrame / HTMLVideoElement`
- 模型输入：`Tensor[N, C, H, W]` 或 `Tensor[N, H, W, C]`

**输出：**

- 分类：类别概率
- 检测：`boxes + scores + classIds`
- 语义分割：`mask[class, h, w]` 或 `argmax[h, w]`
- 实例分割：`boxes + masks + scores`
- 关键点：`keypoints[x, y, score]`

### 3.3 模型接入原则

- 优先选轻量模型：MobileNet、YOLO-nano、PP-LiteSeg、SAM-tiny 类变体
- 统一导出为 ONNX 或 TFJS 可消费格式
- 尽量减少不被浏览器端推理框架支持的算子
- 对动态 shape 做约束，避免过度灵活导致调度复杂
- 模型版本、输入尺寸、量化版本、后处理配置解耦管理

---

## 4. 图像处理管线构建

浏览器端的图像标注与处理必须按“流式处理管线”来设计，而不是把所有步骤揉在一个函数里。

### 4.1 标准处理链路

```
输入源
  ↓
解码与读取
  ↓
颜色空间统一 / alpha 处理 / EXIF 方向纠正
  ↓
Resize / Pad / Crop / Normalize
  ↓
Tensor 构建
  ↓
模型推理
  ↓
后处理（NMS / Argmax / Mask Restore / 坐标映射）
  ↓
可视化渲染（Canvas/WebGL）
  ↓
导出（JSON / PNG Mask / 标注结果）
```

### 4.2 管线拆分原则

- **解码阶段**：从 `File/Blob` 转成 `ImageBitmap`，减少主线程解码阻塞
- **预处理阶段**：尽量靠近推理引擎，避免中间格式多次拷贝
- **推理阶段**：输入输出 tensor 的生命周期必须可控
- **后处理阶段**：根据任务类型走不同算法分支
- **渲染阶段**：用独立图层绘制框、点、mask，避免频繁全量重绘

### 4.3 为什么必须做管线化

- 便于插拔不同模型
- 便于按设备切换不同 Backend
- 便于对单阶段做性能分析
- 便于大图分块和实时流复用
- 便于内存回收，不让中间 tensor 泄漏

---

## 5. 端侧 AI 推理工程设计

### 5.1 推理引擎选型建议

| 引擎 | 优点 | 局限 | 适用场景 |
|------|------|------|---------|
| ONNX Runtime Web | 工程成熟，支持多后端 | 算子支持受模型影响 | 通用推荐 |
| TensorFlow.js | 生态成熟，前端集成好 | 大模型性能一般 | 轻量模型、教学/demo |
| MediaPipe | 预置视觉任务强 | 自定义模型能力有限 | 人脸/手势/分割 |
| 自定义 WebGL/WASM Kernel | 性能可控 | 开发复杂 | 关键算子优化 |

### 5.2 工程层核心能力

- 模型加载器：负责模型下载、缓存、版本控制
- Session 工厂：按设备能力创建推理 session
- Backend 选择器：动态选择 `webgl / wasm / cpu`
- 算法注册中心：按任务注入前后处理逻辑
- 结果适配层：统一输出结构给 UI
- 生命周期管理器：集中释放 tensor、session、buffer、纹理

### 5.3 推理工程的关键原则

- 模型初始化异步化，避免阻塞首屏
- session 单例复用，避免重复创建
- 预热一次，规避首次推理抖动
- 输入尺寸受控，避免超大图直接进入模型
- 对不同任务设置最大并发与降级阈值

---

## 6. 浏览器 GPU 计算加速

浏览器端 GPU 加速的核心价值，不只是“跑得更快”，而是把张量并行计算、纹理采样、后处理算子和渲染链路打通。

### 6.1 GPU 在图像标注系统中的职责

- 承担卷积、矩阵运算等推理主计算
- 承担 Resize、颜色变换、mask 融合等图像处理算子
- 承担后处理中的并行操作，如 argmax、heatmap 解码
- 承担最终框、点、mask 的高效渲染

### 6.2 WebGL 加速思路

WebGL 虽然本质是图形渲染接口，但可以把 tensor 映射为纹理，通过 shader 实现并行计算。

**适合 WebGL 的任务：**

- 卷积、激活、逐像素映射
- 图像 resize、normalize、颜色通道变换
- mask 混合与可视化
- 检测结果框渲染

**优势：**

- 浏览器支持广
- 对图像处理与 shader 型计算足够成熟
- 与 Canvas/纹理渲染链路天然衔接

**限制：**

- 通用计算表达力弱于 WebGPU
- 调试复杂
- 某些模型算子映射不自然

### 6.3 WebGPU 的补充价值

如果环境允许，可把 WebGPU 作为增强路径：

- 更适合 Compute Shader
- 更适合大规模并行张量计算
- 更适合自定义后处理算子

但在兼容性策略上，不应把 WebGPU 作为唯一依赖，而应将其作为增强后端。

---

## 7. WebAssembly 高性能计算加速

WebAssembly 适合承担浏览器中的 CPU 密集型工作，是图像前后处理和 CPU fallback 的核心支撑。

### 7.1 Wasm 适合承接的计算

- Resize、Crop、Pad、颜色空间转换
- Normalize、布局变换（HWC → CHW）
- NMS、TopK、Argmax
- Mask 解码、mask restore、tile merge
- CPU 路径下的小模型推理

### 7.2 Wasm 的工程价值

- 比纯 JS 更适合数值密集计算
- 内存布局连续，更适合像素和 tensor 操作
- 可启用 SIMD 指令提升向量化吞吐
- 可配合 Threads + SharedArrayBuffer 做并行分块处理
- 便于复用 C/C++/Rust 图像算法库

### 7.3 Wasm 在整体架构中的定位

```
轻量预处理       → Wasm
复杂后处理       → Wasm
CPU fallback     → Wasm / JS
GPU 不可用时     → Wasm 顶上
主线程不宜计算   → Worker + Wasm
```

### 7.4 推荐的 Wasm 使用策略

- 只把重计算部分下沉到 Wasm，不要把整套业务逻辑塞进去
- 保持输入输出结构简单，降低 JS/Wasm 边界转换成本
- 尽量批量处理，减少频繁跨边界调用
- 配合 Worker 使用，避免阻塞 UI

---

## 8. 推理 Backend 调度设计

用户指定的核心要求之一，是能够在浏览器中做 `WebGL / WASM / CPU fallback` 的后端调度。

### 8.1 调度目标

- 自动适配设备能力
- 优先性能更好的后端
- 后端不可用时平滑降级
- 避免用户感知到明显卡顿或功能失效

### 8.2 推荐的优先级策略

```
优先级：
WebGL → WASM → CPU
```

如果项目允许引入更激进方案，可扩展为：

```
WebGPU → WebGL → WASM → CPU
```

### 8.3 Backend 选择维度

| 维度 | WebGL | WASM | CPU |
|------|-------|------|-----|
| 计算性能 | 高 | 中 | 低 |
| 兼容性 | 较高 | 高 | 最高 |
| 启动成本 | 中 | 中 | 低 |
| 大模型适配 | 较好 | 一般 | 差 |
| 自定义后处理 | 中 | 高 | 高 |
| 稳定 fallback | 中 | 高 | 最高 |

### 8.4 Backend 调度规则

- 首次启动做能力探测：WebGL context、Wasm SIMD、线程能力、内存预算
- 根据模型类型决定首选后端：检测/分割优先 WebGL，小模型和后处理优先 Wasm
- 当 GPU 初始化失败、纹理创建失败、显存不足时，自动切到 Wasm
- 当 Wasm SIMD/线程不可用时，自动退到单线程 Wasm 或纯 CPU
- 低端设备上可直接跳过 GPU 初始化，减少初始化成本

### 8.5 调度伪代码

```ts
async function selectBackend(capability: DeviceCapability, task: VisionTask) {
  if (capability.webgl && task !== 'ocr-assist') {
    return 'webgl';
  }

  if (capability.wasm) {
    return 'wasm';
  }

  return 'cpu';
}
```

### 8.6 调度不只是启动时行为

真正工程化的方案中，Backend 选择应该是动态的：

- 初次加载时选一次
- 模型切换时重新评估
- 处理大图时重新评估
- 连续掉帧时重新评估
- GPU OOM 或上下文丢失时重新评估

---

## 9. 多线程推理调度与实时流处理

### 9.1 为什么需要多线程

AI 图像标注与处理往往同时存在以下负载：

- 主线程：UI 交互、画布渲染、鼠标标注
- 解码线程：图片/视频帧解码
- 推理线程：模型执行
- 后处理线程：NMS、mask restore、tile merge
- 资源线程：缓存管理、预加载、回收

如果全部放在主线程，交互体验会迅速劣化。

### 9.2 推荐线程模型

```
主线程
  ├─ UI + Canvas 图层渲染
  ├─ 输入事件
  └─ 与 Worker 协调

推理 Worker
  ├─ 模型 session
  ├─ tensor 构建
  └─ 后端执行

图像处理 Worker
  ├─ resize / normalize
  ├─ tile 切分
  └─ mask merge

批量任务 Worker Pool
  └─ 多图并发处理
```

### 9.3 多线程调度策略

- **单帧优先**：交互式标注先保证当前帧延迟
- **批量让路**：批量离线任务在空闲时推进
- **推理串行、预处理并行**：避免 session 争抢，同时提高流水线利用率
- **视频帧丢帧保实时**：实时流中宁可跳帧，也不堆积历史帧
- **Tile 并行但受限并发**：并发数与 CPU 核数、内存预算绑定

### 9.4 实时流处理建议

对于摄像头或视频流：

- 不处理每一帧，按采样率控制推理频率
- 使用“最新帧覆盖旧帧”的队列策略，而非排队消费所有帧
- 渲染频率可高于推理频率，复用最近一次结果
- 对静止场景可降低推理频率，对场景变化大时提升频率

**推荐节奏：**

```
渲染 60fps
推理 10~30fps
结果复用 2~6 帧
```

---

## 10. 模型工程优化

端侧模型优化不是可选项，而是能否真正落地的前提。

### 10.1 模型量化

量化的目标是降低模型体积、带宽压力和计算成本。

| 类型 | 大小变化 | 精度影响 | 浏览器端价值 |
|------|----------|----------|--------------|
| FP32 → FP16 | 约 50% | 很小 | 首选压缩方式 |
| FP32 → INT8 | 约 75% | 中低 | 对轻量模型收益明显 |
| INT4 | 更激进 | 较高 | 需谨慎评估 |

**收益：**

- 模型下载更快
- 内存占用更低
- CPU/WASM 路径更受益
- 大图与多模型共存更稳定

### 10.2 模型裁剪

适合在训练后或蒸馏阶段做结构性简化：

- 通道裁剪
- 层裁剪
- 检测头精简
- 减少类别数和输出分支

裁剪要与真实场景绑定，不能只看理论参数量。

### 10.3 按需加速

按需加速的本质是“不是所有图、所有时刻、所有设备都走最高成本路径”。

**可落地策略：**

- 小图走单阶段推理，大图走 tile 模式
- 静态图片走高精度模型，实时视频走轻量模型
- 首次预览走低分辨率，点击细化时再高精度复检
- 框检测先粗筛，mask 分割只对候选区域二次推理

### 10.4 模型冷热分层

- 热路径模型：轻量、实时、常驻内存
- 冷路径模型：高精度、按需加载、短时驻留

例如：

- 预览阶段使用 `det-lite`
- 用户框选后再加载 `seg-high-precision`

---

## 11. 图像预处理与后处理算法

预处理与后处理决定了推理结果能否正确映射回原图，是端侧工程里最容易被低估、但最容易出 bug 的部分。

### 11.1 Resize

常见策略：

- 直接缩放：实现简单，但易形变
- 等比缩放 + padding：最常用，便于保持比例
- Center crop：适合特定任务
- Tile resize：适合超大图局部推理

### 11.2 Normalize

目标是让输入分布对齐训练时配置。

常见步骤：

- `uint8 -> float32`
- 除以 `255`
- 按通道减均值、除方差
- 从 `HWC` 转为 `CHW`

### 11.3 NMS

目标检测和实例分割常见后处理步骤：

1. 过滤低置信度框
2. 按类别分组
3. 按置信度排序
4. 基于 IoU 做抑制
5. 保留最终候选框

工程注意点：

- 类别维度是否共享 NMS
- IoU 阈值与 score 阈值要可配置
- 批量框数据尽量在 Wasm 中处理

### 11.4 Mask 还原

实例分割与语义分割的输出通常不是原图尺寸，需要把 mask 映射回原图坐标系。

**典型步骤：**

1. 取模型输出 mask
2. 去除 letterbox/padding 区域
3. 逆向 resize 到原图 ROI 或原图尺寸
4. 根据阈值二值化或软融合
5. 绘制到全局 mask 图层

### 11.5 坐标反变换

检测框、关键点、mask 都需要执行：

```
模型空间坐标
  ↓ 去 padding
  ↓ 按缩放比逆变换
  ↓ 回到原图坐标
  ↓ 回到当前画布显示坐标
```

如果这一层处理不好，标注框和 mask 会出现错位、漂移、拉伸。

### 11.6 推荐的后处理分工

| 后处理项 | 推荐执行位置 |
|----------|-------------|
| score threshold | JS / Wasm |
| NMS | Wasm |
| argmax | WebGL / Wasm |
| mask restore | Wasm |
| 坐标映射 | JS / Wasm |
| 最终绘制 | Canvas / WebGL |

---

## 12. 推理性能优化

### 12.1 大图推理

超大分辨率图片不能直接无脑送入模型，否则会遇到：

- 输入尺寸过大导致推理耗时飙升
- WebGL 纹理尺寸受限
- GPU/CPU 内存迅速增长
- 后处理耗时与中间 tensor 占用失控

**推荐方案：**

- 先缩略图做全局粗检测
- 对命中区域做局部高精度推理
- 对超大图启用 tile 分块策略

### 12.2 Tile 分块管理

```
原图
  ↓
按窗口切成 tiles
  ↓
每个 tile 单独预处理与推理
  ↓
局部结果坐标映射回全局
  ↓
去重与 merge
  ↓
输出全图结果
```

### 12.3 Tile 设计要点

- tile 之间保留 overlap，避免边界目标被截断
- tile 大小与模型输入尺寸匹配，降低额外 resize 损失
- 控制最大并发 tile 数，避免同时占满内存
- merge 时对框结果做全局 NMS，对 mask 做区域拼接

### 12.4 实时流推理优化

实时流不是只看单次推理速度，而是看系统是否能长期稳定。

**优化重点：**

- 动态降低输入分辨率
- 限制推理频率
- 帧跳过
- 复用上一帧结果
- 只对 ROI 做局部更新
- 检测与分割拆成不同频率

**示例策略：**

- 每 3 帧做一次检测
- 中间帧只做轻量跟踪或结果复用
- 用户交互触发时临时切换高精度模式

### 12.5 冷启动优化

- 懒加载模型
- streaming 下载与初始化
- session 预热
- 首次进入先显示低分辨率预览
- 利用 IndexedDB 缓存模型

---

## 13. 浏览器内存管理与资源控制

浏览器端 AI 系统常见问题不是“算不动”，而是“跑一会儿就越来越卡，最终崩掉”。

### 13.1 tensor 生命周期管理

必须显式管理以下对象的生命周期：

- 输入 tensor
- 中间 tensor
- 输出 tensor
- 推理 session
- ImageBitmap / VideoFrame
- WebGL 纹理 / Framebuffer / Buffer

### 13.2 生命周期原则

- 结果一旦消费完成，立即释放中间 tensor
- 避免把 tensor 长期挂在全局状态
- 不要在循环中反复创建短生命周期大对象
- 复用输入 buffer 和输出 buffer
- 页面隐藏或组件卸载时主动释放 session 与 GPU 资源

### 13.3 GPU 内存管理

GPU 路径中尤其要关注：

- 纹理对象是否复用
- FBO 是否复用
- 是否存在 GPU → CPU 大量回读
- 是否不断创建新 shader/program
- 是否在上下文丢失后执行了恢复逻辑

### 13.4 资源预算机制

建议为系统建立显式预算：

| 资源项 | 建议控制 |
|--------|----------|
| 模型总内存 | 按设备分级，例如 50MB / 100MB / 200MB |
| 单次输入尺寸 | 根据设备能力分档 |
| 最大并发 tile 数 | 与核数、内存联动 |
| Worker 数量 | 不超过 `hardwareConcurrency - 1` |
| GPU 纹理池 | 固定上限，可复用 |

### 13.5 常见泄漏点

- `ImageBitmap.close()` 未调用
- `VideoFrame.close()` 未调用
- WebGL 纹理和 buffer 未 delete
- 推理 session 重建后旧实例未释放
- Worker 中缓存数组无限增长
- 批量任务结果长期保留在内存

---

## 14. 参考落地架构

### 14.1 模块划分

```ts
src/
  core/
    capability-detector.ts
    backend-selector.ts
    scheduler.ts
    memory-manager.ts
  engines/
    onnx-engine.ts
    wasm-engine.ts
    cpu-engine.ts
  pipeline/
    decoder.ts
    preprocess.ts
    inference.ts
    postprocess.ts
    renderer.ts
  workers/
    inference.worker.ts
    image.worker.ts
  tasks/
    detection.ts
    segmentation.ts
    instance-segmentation.ts
```

### 14.2 核心模块职责

| 模块 | 主要职责 | 关键输入 | 关键输出 |
|------|----------|----------|----------|
| `capability-detector` | 探测 `WebGL / Wasm SIMD / Threads / 内存等级` | 浏览器环境 | 设备能力画像 |
| `backend-selector` | 按任务、设备、实时状态选择后端 | 任务类型、能力画像、运行状态 | `webgl / wasm / cpu` |
| `scheduler` | 管理任务优先级、并发度、帧丢弃、tile 调度 | 任务请求、资源预算 | 可执行任务队列 |
| `memory-manager` | 管理 tensor、buffer、纹理池、session 生命周期 | 分配/释放请求 | 资源句柄、回收记录 |
| `decoder` | 输入读取、解码、方向纠正、颜色空间统一 | `File / Blob / Frame` | `ImageBitmap` |
| `preprocess` | `resize / normalize / pad / tensorize` | `ImageBitmap`、模型配置 | 输入 tensor |
| `inference` | 执行 session run、监控耗时、做异常降级 | 输入 tensor、backend | 原始推理结果 |
| `postprocess` | `nms / argmax / mask restore / 坐标反变换` | 原始结果、scale 信息 | 标注结果 |
| `renderer` | 框、点、mask 图层绘制与结果叠加 | 标注结果、画布上下文 | 可视化输出 |
| `telemetry` | 记录延迟、FPS、内存、降级次数 | 各阶段指标 | 性能与稳定性数据 |

### 14.3 数据流参考

```ts
async function runVisionTask(input: InputSource, task: VisionTask) {
  const bitmap = await decodeToImageBitmap(input);
  const backend = await backendSelector.pick(task);

  const preprocessed = await preprocess(bitmap, task, backend);
  const rawOutput = await inferenceEngine.run(preprocessed, backend);
  const result = await postprocess(rawOutput, task, bitmap.width, bitmap.height);

  renderer.draw(result);
  resourceManager.release(preprocessed, rawOutput);

  return result;
}
```

### 14.4 调度器实现骨架

```ts
class VisionScheduler {
  private running = false;
  private latestRealtimeTask: VisionTaskRequest | null = null;
  private batchQueue: VisionTaskRequest[] = [];

  enqueue(task: VisionTaskRequest) {
    if (task.mode === 'realtime') {
      // 实时流只保留最新任务，避免历史帧堆积
      this.latestRealtimeTask = task;
      return;
    }

    this.batchQueue.push(task);
  }

  async tick() {
    if (this.running) return;
    this.running = true;

    try {
      const task = this.latestRealtimeTask ?? this.batchQueue.shift();
      this.latestRealtimeTask = null;

      if (!task) return;

      const backend = await backendSelector.pick(task.type);
      await pipeline.run(task, backend);
    } catch (error) {
      await fallbackController.handle(error);
    } finally {
      this.running = false;
    }
  }
}
```

### 14.5 Tile 大图推理伪代码

```ts
async function runTiledInference(bitmap: ImageBitmap, config: TileConfig) {
  const tiles = tileManager.split(bitmap, {
    tileWidth: config.tileWidth,
    tileHeight: config.tileHeight,
    overlap: config.overlap,
  });

  const partialResults: VisionResult[] = [];

  for (const chunk of chunkTiles(tiles, config.maxConcurrency)) {
    const results = await Promise.all(
      chunk.map(async (tile) => {
        const input = await preprocess(tile.bitmap, 'detection', tile.backendHint);
        const output = await inferenceEngine.run(input, tile.backendHint);
        return postprocessTile(output, tile.offsetX, tile.offsetY, tile.scale);
      })
    );

    partialResults.push(...results);
  }

  return resultMerger.merge(partialResults);
}
```

### 14.6 实时流处理伪代码

```ts
async function processRealtimeStream(video: HTMLVideoElement) {
  let frameIndex = 0;

  while (streamController.active) {
    const frame = await frameGrabber.getLatestFrame(video);

    // 每 3 帧做一次完整推理，其余帧复用或轻量更新
    if (frameIndex % 3 === 0) {
      const result = await runVisionTask(frame, 'instance-segmentation');
      cache.setLatest(result);
    } else {
      renderer.draw(cache.getLatest());
    }

    frame.close?.();
    frameIndex++;
    await nextAnimationFrame();
  }
}
```

### 14.7 Backend 降级控制骨架

```ts
class FallbackController {
  async handle(error: unknown) {
    if (isGpuContextLost(error) || isGpuOutOfMemory(error)) {
      backendSelector.forceDowngrade('wasm');
      return;
    }

    if (isWasmUnavailable(error)) {
      backendSelector.forceDowngrade('cpu');
      return;
    }

    throw error;
  }
}
```

### 14.8 资源管理骨架

```ts
class ResourceManager {
  private tensors = new Set<Disposable>();
  private bitmaps = new Set<ImageBitmap>();

  trackTensor(tensor: Disposable) {
    this.tensors.add(tensor);
    return tensor;
  }

  trackBitmap(bitmap: ImageBitmap) {
    this.bitmaps.add(bitmap);
    return bitmap;
  }

  release(...resources: Array<unknown>) {
    for (const resource of resources) {
      if (typeof (resource as Disposable)?.dispose === 'function') {
        (resource as Disposable).dispose();
        this.tensors.delete(resource as Disposable);
      }

      if (typeof (resource as ImageBitmap)?.close === 'function') {
        (resource as ImageBitmap).close();
        this.bitmaps.delete(resource as ImageBitmap);
      }
    }
  }

  releaseAll() {
    for (const tensor of this.tensors) tensor.dispose();
    for (const bitmap of this.bitmaps) bitmap.close();
    this.tensors.clear();
    this.bitmaps.clear();
  }
}
```

### 14.9 推荐的工程分阶段落地

**第一阶段：**

- 打通图片输入
- 打通单模型推理
- 完成检测/分割结果渲染

**第二阶段：**

- 接入 `WebGL / WASM / CPU fallback`
- 引入 Worker 和资源管理
- 完成常见前后处理封装

**第三阶段：**

- 接入大图 tile 推理
- 接入实时流推理
- 做模型缓存与性能监控

**第四阶段：**

- 做模型量化、裁剪、双模型协同
- 做设备分级策略和动态调度
- 做可观测性与异常恢复

---

## 15. 面试表达与方案亮点总结

如果这是面试方案题，可以把回答组织成下面这套逻辑：

### 15.1 一句话方案

我会把浏览器端 AI 图像标注系统拆成 **图像处理管线、推理引擎、Backend 调度、多线程调度、模型优化、内存控制** 六层，通过 `WebGL + WASM + CPU fallback` 保证不同设备都能稳定运行。

### 15.2 面试官通常想听到的关键点

- 不是只会“调个模型”，而是知道完整工程链路
- 知道前处理、后处理、渲染、调度是同等重要的环节
- 知道大图和实时流要用不同策略
- 知道 GPU 不稳定时要可降级
- 知道 tensor、纹理、Worker 都需要生命周期管理
- 知道模型优化不只是量化，还包括裁剪、双模型协同和按需加速

### 15.3 可总结成的工程亮点

1. **Backend 自适应调度**：根据设备能力在 `WebGL / WASM / CPU` 之间切换
2. **管线化设计**：预处理、推理、后处理、渲染各自独立，方便优化
3. **多线程与实时策略**：避免主线程阻塞，视频流优先保实时
4. **大图分块能力**：通过 tile 解决超大图输入限制
5. **资源控制体系**：显式管理 tensor 与 GPU 内存，避免长时间运行崩溃

### 15.4 最后的落地判断标准

一个浏览器端 AI 图像标注系统是否成熟，不只看模型精度，还要看：

- 首次加载是否可接受
- 低端设备是否能跑
- 连续运行 10 分钟是否稳定
- 大图是否能处理
- 实时视频是否能控制延迟
- 结果是否能正确映射回原图

如果这些问题都被系统性解决，这个方案才算真正具备工程落地价值。
