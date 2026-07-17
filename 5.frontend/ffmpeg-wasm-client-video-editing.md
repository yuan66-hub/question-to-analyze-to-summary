# FFmpeg.wasm 客户端视频剪辑：拼接预览、转场、特效与裁剪

> 从"能不能做"到"该怎么做"：厘清 FFmpeg.wasm 在浏览器端做视频拼接、转场、特效、裁剪的能力边界，给出**预览/导出双引擎**的工程架构与可落地实现。

---

## 目录

1. [核心结论](#1-核心结论)
2. [FFmpeg.wasm 是什么、边界在哪](#2-ffmpegwasm-是什么边界在哪)
3. [逐功能拆解](#3-逐功能拆解)
   - 3.1 [两段视频拼接（concat）](#31-两段视频拼接concat)
   - 3.2 [转场（transition）](#32-转场transition)
   - 3.3 [特效（filters）](#33-特效filters)
   - 3.4 [裁剪（trim / crop）](#34-裁剪trim--crop)
4. [关键架构：预览 / 导出双引擎](#4-关键架构预览--导出双引擎)
   - 4.1 [为什么不能用 FFmpeg.wasm 做实时预览](#41-为什么不能用-ffmpegwasm-做实时预览)
   - 4.2 [预览引擎设计](#42-预览引擎设计)
   - 4.3 [导出引擎设计](#43-导出引擎设计)
   - 4.4 [编辑态数据模型（EDL）](#44-编辑态数据模型edl)
5. [工程落地要点](#5-工程落地要点)
   - 5.1 [加载与包体积](#51-加载与包体积)
   - 5.2 [多线程与 COOP/COEP](#52-多线程与-coopcoep)
   - 5.3 [内存与 OOM](#53-内存与-oom)
   - 5.4 [虚拟文件系统与大文件](#54-虚拟文件系统与大文件)
   - 5.5 [进度、取消与 Worker 隔离](#55-进度取消与-worker-隔离)
6. [性能对比与选型建议](#6-性能对比与选型建议)
7. [WebCodecs 补位：更快的预览与导出](#7-webcodecs-补位更快的预览与导出)
8. [常见坑速查表](#8-常见坑速查表)
9. [面试问答速记](#9-面试问答速记)

---

## 1. 核心结论

**FFmpeg.wasm 功能上几乎等同于命令行 FFmpeg**，拼接、转场、特效、裁剪都能做。但它是"离线渲染"模型而非"逐帧播放器"，因此：

- ✅ 适合当作**浏览器端的导出/渲染引擎**（隐私敏感、无后端、离线可用）。
- ❌ 不适合当作**实时预览引擎**（拖动进度条会卡死）。
- ⚙️ 工程正解：**预览走 Canvas/WebGL/WebCodecs，导出走 FFmpeg.wasm（或后端原生 FFmpeg）**，两套引擎共用一份编辑态数据模型。

| 维度 | FFmpeg.wasm 表现 |
|---|---|
| 功能完整度 | ✅ 极高，命令行能做的基本都能做 |
| 处理速度 | ❌ 比原生慢 3~10 倍（软编、SIMD/多线程受限） |
| 实时预览 | ❌ 不擅长，离线渲染模型 |
| 包体积 | ⚠️ core 约 25~30MB，需按需懒加载 |
| 内存 | ⚠️ 受 wasm32 地址空间（约 2~4GB）限制，长视频易 OOM |
| 隐私/离线 | ✅ 视频不出浏览器，纯前端可用 |

---

## 2. FFmpeg.wasm 是什么、边界在哪

FFmpeg.wasm（`@ffmpeg/ffmpeg` + `@ffmpeg/core`）是把 FFmpeg 用 Emscripten 编译成 WebAssembly，在浏览器主线程之外（Worker）运行的一套库。你写的仍然是熟悉的 FFmpeg CLI 参数，只是 I/O 走的是内存里的**虚拟文件系统（MEMFS）**。

它的能力边界由三件事决定：

1. **core 构建时编进了哪些库**：默认 core 未必带 `libx264`（受专利/体积影响，官方核心通常带，但字幕 `libass`、部分编码器可能缺失）。特效多时可能要用自定义 flag 重新构建 core。
2. **没有硬件加速**：全程 CPU 软编软解，这是它比原生慢的根因。
3. **wasm32 地址空间**：单个模块可寻址内存有上限（历史约 2GB，现代约 4GB），决定了能处理多大/多长的视频。

```
┌───────────────────────── 浏览器页面 ─────────────────────────┐
│  主线程 UI                                                    │
│    │ writeFile / exec / readFile （postMessage）              │
│    ▼                                                          │
│  Web Worker                                                   │
│    ┌──────────────────────────────────────────┐              │
│    │   FFmpeg.wasm (Emscripten)                 │              │
│    │   ┌────────────┐   ┌──────────────────┐    │              │
│    │   │  MEMFS 虚拟  │   │  libavcodec/     │    │              │
│    │   │  文件系统    │◀─▶│  libavfilter ... │    │              │
│    │   └────────────┘   └──────────────────┘    │              │
│    └──────────────────────────────────────────┘              │
└───────────────────────────────────────────────────────────────┘
```

---

## 3. 逐功能拆解

以下命令在 wasm 里的用法都是：`writeFile` 写入输入 → `exec([...args])` 执行 → `readFile` 取出结果。

### 3.1 两段视频拼接（concat）

**情况 A：编码/分辨率/帧率完全一致** → 用 concat demuxer，`-c copy` 不重编码，**最快**（几乎瞬时）：

```bash
# list.txt 内容：file 'a.mp4'  \n  file 'b.mp4'
ffmpeg -f concat -safe 0 -i list.txt -c copy output.mp4
```

**情况 B：参数不一致** → 用 concat filter，需先统一分辨率/帧率再拼，会重编码：

```bash
ffmpeg -i a.mp4 -i b.mp4 -filter_complex \
  "[0:v]scale=1280:720,fps=30,setsar=1[v0]; \
   [1:v]scale=1280:720,fps=30,setsar=1[v1]; \
   [v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" output.mp4
```

> 拼接是最"划算"的场景：只要能走情况 A，wasm 也很快。

### 3.2 转场（transition）

用 `xfade`（视频）+ `acrossfade`（音频）。`xfade` 内置 50+ 种转场：`fade / wipeleft / slideup / circleopen / dissolve / pixelize` 等。

```bash
# a 时长 5s，转场 1s，从第 4s 开始交叠
ffmpeg -i a.mp4 -i b.mp4 -filter_complex \
  "[0:v][1:v]xfade=transition=fade:duration=1:offset=4[v]; \
   [0:a][1:a]acrossfade=d=1[a]" \
  -map "[v]" -map "[a]" output.mp4
```

要点：
- `offset` = 前一段时长 − 转场时长，算错会黑屏或跳帧。
- 转场**必须重编码**，wasm 下最慢的环节之一。
- 多段转场要串多个 `xfade`，注意每段 `offset` 累加（要减去已消耗的转场时长）。

### 3.3 特效（filters）

| 特效 | 滤镜 | 示例 |
|---|---|---|
| 调色 | `eq` | `eq=brightness=0.1:contrast=1.2:saturation=1.3` |
| 模糊 | `gblur` / `boxblur` | `gblur=sigma=8` |
| 缩放/旋转 | `scale` / `rotate` | `scale=1280:-2`、`rotate=PI/6` |
| 水印/画中画 | `overlay` | `[0][1]overlay=W-w-10:10` |
| 文字 | `drawtext` | 需 core 带 freetype |
| 字幕 | `subtitles` / `ass` | 需 core 带 libass |
| 变速 | `setpts` / `atempo` | `setpts=0.5*PTS`（2×快放）+ `atempo=2.0` |
| 淡入淡出 | `fade` | `fade=in:0:30,fade=out:270:30` |

⚠️ `drawtext`/`subtitles` 依赖 core 是否编进 freetype/libass，默认核心可能没有，需自定义构建或改用 Canvas 叠字。

### 3.4 裁剪（trim / crop）

**时间裁剪**（截取时间段）：

```bash
# -ss 放在 -i 前是快速 seek（关键帧对齐）；放在后面是精确 seek（更慢）
ffmpeg -ss 5 -to 20 -i input.mp4 -c copy cut.mp4      # 不重编码，快但只能切到关键帧
ffmpeg -ss 5 -to 20 -i input.mp4 out.mp4              # 重编码，帧级精确
```

**画面裁剪**（裁掉画面区域）：

```bash
ffmpeg -i input.mp4 -vf "crop=w:h:x:y" cropped.mp4    # 从 (x,y) 裁出 w×h
```

---

## 4. 关键架构：预览 / 导出双引擎

### 4.1 为什么不能用 FFmpeg.wasm 做实时预览

FFmpeg 的模型是"输入文件 → 滤镜图 → 编码输出文件"，**它不是随机访问的播放器**。想预览拖动到第 12 秒的转场效果，用 wasm 得把那一段完整渲染成文件再播放——每拖一次卡几秒，交互体验崩塌。同时软编不占 GPU，帧率上不去。

结论：**预览与导出是两个不同的性能约束问题，必须用两套引擎。**

```
┌─────────────────────────────────────────────────────────┐
│                   编辑器 UI（时间线 / 轨道）               │
│                          │                                │
│                单一数据源 EDL（编辑决策列表）             │
│                  /                    \                   │
│      ┌──────────────────┐      ┌──────────────────────┐  │
│      │  预览引擎（实时）  │      │   导出引擎（离线）     │  │
│      │  <video> + Canvas │      │   FFmpeg.wasm         │  │
│      │  WebGL / WebCodecs│      │   或后端原生 FFmpeg    │  │
│      │  shader 做转场特效 │      │   高质量最终合成       │  │
│      └──────────────────┘      └──────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 4.2 预览引擎设计

目标：拖动、播放流畅（≥30fps），效果与最终导出**视觉一致**。

- **解码源**：多个 `<video>` 元素分别持有片段；或用 **WebCodecs `VideoDecoder`** 逐帧解码（硬件加速，性能远超 wasm）。
- **合成**：每帧把当前时间轴对应片段的画面画到 **Canvas / WebGL**。
- **转场/特效**：用 **GLSL shader** 实时计算（crossfade 就是两张纹理按 `mix(a, b, t)` 混合），特效如调色/模糊也用 shader，帧级实时。
- **驱动**：`requestVideoFrameCallback` 或 `requestAnimationFrame` 逐帧驱动，按时间轴映射决定"当前该画哪个片段的哪一帧"。

关键是**时间轴映射**：全局时间 `t` → 落在哪个 clip 的哪个本地时间 → 是否处于转场区间（需要同时取两个 clip 的帧做混合）。

### 4.3 导出引擎设计

目标：高质量、参数可控、结果确定。用户点"导出"时才触发。

- **纯前端**：把 EDL 翻译成一条 `filter_complex`，交给 FFmpeg.wasm 一次性渲染。适合短视频、隐私敏感、无后端场景。
- **后端**：把 EDL（+ 原始文件或已上传的素材）发给服务端，用**原生 FFmpeg（可上 GPU）**渲染，快 10 倍、无内存上限。适合长视频、高频、专业剪辑。
- **混合**：预览始终前端；导出根据视频时长/分辨率自动决定走 wasm 还是回落到后端。

### 4.4 编辑态数据模型（EDL）

预览和导出共用一份声明式数据，避免"预览和导出效果对不上"：

```ts
interface EDL {
  resolution: { width: number; height: number };
  fps: number;
  clips: Clip[];
  transitions: Transition[];
}

interface Clip {
  id: string;
  source: string;           // 素材引用
  inPoint: number;          // 源内起点（秒）
  outPoint: number;         // 源内终点（秒）
  timelineStart: number;    // 时间轴上的起点（秒）
  crop?: { x: number; y: number; w: number; h: number };
  effects?: Effect[];       // 调色/模糊/变速等
}

interface Transition {
  fromClip: string;
  toClip: string;
  type: 'fade' | 'wipeleft' | 'dissolve' | string; // 对应 xfade 名称
  duration: number;         // 秒
}
```

- **预览引擎**读它 → 决定每帧画什么、shader 用什么参数。
- **导出引擎**读它 → 生成 `filter_complex` 字符串喂给 FFmpeg。

这层抽象是整个架构的地基：**一份数据，两处消费，保证所见即所得。**

---

## 5. 工程落地要点

### 5.1 加载与包体积

- core 约 25MB+，**绝不能打进主包**。用 `@ffmpeg/util` 的 `toBlobURL` 从 CDN 懒加载，用户真正要导出时才下载。
- 用 `load()` 的进度回调给用户明确的下载反馈。
- 对内网/离线场景，把 core 文件自托管并配长缓存（immutable + 指纹）。

### 5.2 多线程与 COOP/COEP

多线程版（`core-mt`）依赖 `SharedArrayBuffer`，页面必须响应以下头，否则退回单线程（慢一倍以上）：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

代价：所有跨域资源（CDN、图片、字体）都要带 CORP/CORS，否则被拦。开发期可用单线程 core 规避。

### 5.3 内存与 OOM

- wasm32 地址空间上限决定了处理能力，1080p 长视频、4K 素材容易 OOM。
- 对策：预览用低分辨率代理（proxy）素材；导出时分段渲染再拼接；限制单次输入体积并给用户降级提示。

### 5.4 虚拟文件系统与大文件

- 所有 I/O 走 MEMFS，`writeFile` 会把整个文件读进内存 → 大文件直接吃满内存。
- 大文件建议用 `WORKERFS`（挂载 `File` 对象，惰性读取）或分片处理，避免一次性 `writeFile` 全量拷贝。
- 处理完及时 `deleteFile` 释放虚拟 FS 里的中间产物。

### 5.5 进度、取消与 Worker 隔离

- FFmpeg.wasm 本身跑在 Worker，但**大文件的 `writeFile`/`readFile` 拷贝仍可能卡主线程**，注意用 transferable 或分块。
- 监听 `ffmpeg.on('progress', ...)` 和 `on('log', ...)` 输出进度（progress 对拼接类操作不总是准确，可结合日志里的 `time=` 解析）。
- 取消：0.12 版可 `ffmpeg.terminate()` 终止 Worker 再重新 `load()`，实现"取消导出"。

---

## 6. 性能对比与选型建议

| 场景 | 推荐方案 | 理由 |
|---|---|---|
| 简单拼接/裁剪，无转场特效 | ✅ FFmpeg.wasm，`-c copy` | 不重编码，接近瞬时 |
| 轻量剪辑工具，导出偶发 | ✅ wasm 导出 + Canvas/WebCodecs 预览 | 无后端成本，体验够用 |
| 隐私敏感 / 视频不上传 | ✅ 全 wasm | 数据不出浏览器 |
| 长视频 / 高频 / 专业剪辑 | ⚠️ 预览前端，**导出走后端原生 FFmpeg** | 快 10×、能上 GPU、无内存上限 |
| 需要极致预览体验 | ✅ WebCodecs + WebGL 预览 | 硬件解码，帧级流畅 |

一句话选型：**能 `-c copy` 就纯前端；要重编码且视频不长，wasm 导出；视频长或量大，导出回落后端。**

---

## 7. WebCodecs 补位：更快的预览与导出

WebCodecs（Chrome/Edge 已支持）提供 `VideoDecoder` / `VideoEncoder`，**直接调用浏览器底层硬件编解码**：

- **预览**：`VideoDecoder` 逐帧解码 → 画到 Canvas/WebGL，比 wasm 解码快数倍，是现代编辑器预览首选。
- **导出**：`VideoEncoder` + `mp4box.js`/`mp4-muxer` 封装，可做硬件加速导出。但**复杂 filter_complex（转场/滤镜图）仍是 FFmpeg 的强项**，WebCodecs 需要自己用 shader 实现合成逻辑。

实践组合：**WebCodecs 负责解码 + 编码（快），shader 负责合成/转场/特效，FFmpeg.wasm 负责 WebCodecs 覆盖不到的复杂容器/滤镜处理。** 兼容性兜底仍回落到 FFmpeg.wasm。

---

## 8. 常见坑速查表

| 现象 | 原因 | 对策 |
|---|---|---|
| 拼接后音画不同步/跳帧 | 两段参数不一致却用了 concat demuxer | 改用 concat filter 先统一 scale/fps/sar |
| 转场处黑屏 | `xfade` 的 `offset` 算错 | offset = 前段时长 − 转场时长，多段需累减 |
| `drawtext`/字幕报错 | core 没编 freetype/libass | 自定义构建 core，或改用 Canvas 叠字 |
| 页面卡死 | 大文件 `writeFile` 全量入内存 | 用 WORKERFS 惰性挂载 / 分片 |
| 多线程不生效 | 缺 COOP/COEP 头 | 配响应头或用单线程 core |
| 导出到一半崩溃 | OOM，视频太长/太大 | 降分辨率代理、分段渲染、回落后端 |
| 首屏加载慢 | core 打进主包 | `toBlobURL` 懒加载 + 长缓存 |
| 预览和导出效果不一致 | 两套引擎逻辑各写一份 | 统一 EDL，shader 与 xfade 参数一一对应 |

---

## 9. 面试问答速记

**Q：FFmpeg.wasm 能做客户端剪辑吗？**
A：能。拼接、转场（xfade）、特效（eq/overlay/gblur 等）、裁剪（trim/crop）功能上等同命令行 FFmpeg。但它是离线渲染模型、软编无 GPU，适合当导出引擎，不适合实时预览。

**Q：那预览怎么做？**
A：预览与导出分离两套引擎。预览用 `<video>`/WebCodecs 解码 + Canvas/WebGL shader 实时合成转场特效；导出才用 FFmpeg.wasm 或后端 FFmpeg 高质量渲染。两者共享一份 EDL 数据模型，保证所见即所得。

**Q：性能瓶颈和取舍？**
A：三大约束——软编慢（比原生慢 3~10×）、包体积大（core 25MB+，需懒加载）、内存上限（wasm32 ~2-4GB，长视频 OOM）。多线程要 COOP/COEP。长视频/高频场景导出应回落到后端原生 FFmpeg（可上 GPU）。

**Q：什么时候纯前端就够？**
A：能走 `-c copy` 的简单拼接/裁剪、短视频、隐私敏感（视频不上传）、无后端成本诉求的轻量工具场景。

> 配套可运行 Demo：见 [`demos/ffmpeg-wasm-editor/`](../demos/ffmpeg-wasm-editor/README.md)，演示两段视频拼接、实时 crossfade 预览、裁剪与 FFmpeg.wasm 导出。
