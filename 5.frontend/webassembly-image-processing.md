# WebAssembly 图像处理实战与应用场景

> 涵盖核心原理、Rust/C++ 实现方式、六大实用场景、性能对比与架构最佳实践。

---

## 目录

1. [核心原理](#1-核心原理)
2. [实现方式](#2-实现方式)
   - 2.1 [Rust + wasm-bindgen（主流方案）](#21-rust--wasm-bindgen主流方案)
   - 2.2 [JS 侧调用](#22-js-侧调用)
   - 2.3 [C/C++ + Emscripten](#23-cc--emscripten)
3. [六大实用场景](#3-六大实用场景)
4. [性能对比](#4-性能对比)
5. [架构最佳实践](#5-架构最佳实践)
6. [何时不该用 Wasm](#6-何时不该用-wasm)

---

## 1. 核心原理

WebAssembly 通过**接近原生的执行速度**处理计算密集型的像素操作，弥补 JavaScript 在数值计算上的性能短板。

**基本工作流：**

```
图像数据 (JS) → 共享内存 (ArrayBuffer) → Wasm 处理 → 回写内存 → Canvas 渲染
```

关键点：

- Wasm 操作的是**线性内存**（连续字节数组），天然适合像素 RGBA 数据的顺序访问
- 通过 `SharedArrayBuffer` 或 `Transferable Objects` 实现 JS ↔ Wasm 零拷贝数据传递
- 可复用 C/C++/Rust 生态中成熟的图像处理库（libvips、stb_image、image-rs 等）

---

## 2. 实现方式

### 2.1 Rust + wasm-bindgen（主流方案）

```rust
// lib.rs
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn grayscale(pixels: &mut [u8]) {
    // pixels 是 RGBA 格式，每 4 字节一个像素
    for chunk in pixels.chunks_exact_mut(4) {
        let r = chunk[0] as f32;
        let g = chunk[1] as f32;
        let b = chunk[2] as f32;
        let gray = (0.299 * r + 0.587 * g + 0.114 * b) as u8;
        chunk[0] = gray;
        chunk[1] = gray;
        chunk[2] = gray;
        // chunk[3] alpha 不变
    }
}

#[wasm_bindgen]
pub fn gaussian_blur(pixels: &mut [u8], width: u32, height: u32, radius: u32) {
    // 高斯模糊的 O(n*r²) 计算在 Wasm 中比 JS 快 5-20 倍
    // ... 卷积核实现
}
```

**工具链：** `wasm-pack build --target web` 自动生成 `.wasm` + JS 胶水代码。

### 2.2 JS 侧调用

```javascript
import init, { grayscale } from './pkg/image_processor.js';

async function processImage(canvas) {
    await init(); // 加载 wasm 模块

    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // 直接操作像素数组，零拷贝传递
    grayscale(imageData.data);

    ctx.putImageData(imageData, 0, 0);
}
```

### 2.3 C/C++ + Emscripten

```c
// 编译: emcc resize.c -O3 -s WASM=1 -s EXPORTED_FUNCTIONS='["_resize"]'
#include <emscripten.h>

EMSCRIPTEN_KEEPALIVE
void resize(uint8_t* src, int srcW, int srcH,
            uint8_t* dst, int dstW, int dstH) {
    // 双线性插值缩放
    for (int y = 0; y < dstH; y++) {
        for (int x = 0; x < dstW; x++) {
            float srcX = x * (float)srcW / dstW;
            float srcY = y * (float)srcH / dstH;
            // ... 插值计算
        }
    }
}
```

**适用场景：** 将已有 C/C++ 图像库（OpenCV、stb_image）直接编译为 Wasm 复用。

---

## 3. 六大实用场景

### 场景一：客户端图片压缩上传

```
用户选择图片 → Wasm 缩放/压缩 → 减小体积 → 上传服务器
```

- **优势：** 减少服务器计算压力，节省带宽
- **案例：** Squoosh（Google 开源的在线图片压缩工具，核心用 Wasm 实现多种编解码器）

### 场景二：实时滤镜 / 特效

```
摄像头帧 → Wasm 实时处理 → Canvas 渲染（30fps+）
```

- **应用：** 视频会议虚拟背景、直播美颜、AR 特效
- **关键：** JS 逐像素操作无法达到实时帧率，Wasm 可以

### 场景三：浏览器端 AI 推理

```
图片 → Wasm (ONNX Runtime / TFLite) → 目标检测 / 分类结果
```

- **应用：** 人脸检测、OCR、图片分类
- **案例：** MediaPipe（Google）在浏览器中运行 ML 模型

### 场景四：隐私敏感的图像处理

```
图片始终在本地 → Wasm 处理 → 结果不离开浏览器
```

- **应用：** 证件照处理、医学影像预览、敏感文档编辑
- **优势：** 数据不上传，满足 GDPR / 合规要求

### 场景五：批量图片处理工具

```
批量选择图片 → Wasm 并行处理（Web Workers）→ 打包下载
```

- **应用：** 批量加水印、格式转换（WebP ↔ PNG ↔ AVIF）、尺寸统一
- **案例：** libvips 编译为 Wasm 在浏览器中使用

### 场景六：游戏 / 编辑器中的纹理处理

- 地图瓦片拼接、精灵图生成
- 实时地形高度图计算
- 纹理压缩（ASTC / ETC2）在浏览器端解码

---

## 4. 性能对比

| 操作 | JS (ms) | Wasm (ms) | 加速比 |
|------|---------|-----------|--------|
| 灰度化 (4K 图) | ~45 | ~8 | ~5.6x |
| 高斯模糊 (r=5) | ~320 | ~35 | ~9x |
| 图片缩放 | ~180 | ~25 | ~7x |
| 卷积滤波 | ~500 | ~40 | ~12x |

> 数据为近似值，具体取决于硬件和实现。**计算越密集，Wasm 优势越大。**

性能差距来源：

- **类型确定性：** Wasm 使用固定宽度整数/浮点，无装箱拆箱开销
- **内存布局：** 连续线性内存，缓存命中率高
- **无 GC 停顿：** 手动内存管理，无垃圾回收中断
- **SIMD 支持：** Wasm SIMD 128-bit 指令集可并行处理多个像素

---

## 5. 架构最佳实践

```
┌─────────────────────────────────────┐
│           JS 主线程                  │
│  UI 交互 / 文件读取 / Canvas 渲染    │
└──────────┬──────────────────────────┘
           │ postMessage (Transferable)
┌──────────▼──────────────────────────┐
│         Web Worker                   │
│  ┌────────────────────────────┐     │
│  │       Wasm 模块             │     │
│  │  - 像素处理                 │     │
│  │  - 卷积 / 变换              │     │
│  │  - 编解码                   │     │
│  └────────────────────────────┘     │
└─────────────────────────────────────┘
```

### 关键原则

| 原则 | 说明 |
|------|------|
| **Worker 隔离** | Wasm 重计算放 Web Worker 中，不阻塞 UI 线程 |
| **Transferable Objects** | 用 `ArrayBuffer` 传递像素数据实现零拷贝 |
| **多 Worker 并行** | `SharedArrayBuffer` + 多 Worker 对大图分块并行处理 |
| **流式管线** | 视频帧用 `requestAnimationFrame` + Wasm 管线逐帧处理 |
| **懒加载 Wasm** | 首屏不加载 Wasm 模块，用户触发操作时按需 `init()` |
| **Streaming Compilation** | 使用 `WebAssembly.instantiateStreaming()` 边下载边编译 |

### Worker 通信模式

```javascript
// main.js
const worker = new Worker('image-worker.js');

// 使用 Transferable 传递 ArrayBuffer，零拷贝
const buffer = imageData.data.buffer;
worker.postMessage({ type: 'grayscale', buffer }, [buffer]);

worker.onmessage = (e) => {
    const processed = new ImageData(
        new Uint8ClampedArray(e.data.buffer),
        width, height
    );
    ctx.putImageData(processed, 0, 0);
};
```

```javascript
// image-worker.js
import init, { grayscale } from './pkg/image_processor.js';

let wasmReady = init();

self.onmessage = async (e) => {
    await wasmReady;
    const pixels = new Uint8Array(e.data.buffer);
    grayscale(pixels);
    self.postMessage({ buffer: pixels.buffer }, [pixels.buffer]);
};
```

---

## 6. 何时不该用 Wasm

| 场景 | 更好的选择 | 原因 |
|------|-----------|------|
| 简单滤镜（亮度 / 对比度） | CSS `filter` | GPU 加速，零 JS 开销 |
| 大规模并行卷积 | WebGL / WebGPU 着色器 | GPU 并行度远高于 CPU |
| 少量像素（缩略图等） | 原生 JS | Wasm 初始化 + 数据传递的固定开销不值得 |
| 标准格式转换 | `<canvas>.toBlob()` | 浏览器内置编码器已足够 |

**总结：** Wasm 图像处理的最佳定位是 —— **CPU 密集、逻辑复杂、需要复用 C/Rust 生态库**的场景。简单变换用 CSS/Canvas API，大规模并行用 WebGPU，Wasm 填补中间的性能空白。
