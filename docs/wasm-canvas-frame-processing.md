# WebAssembly SDK 在 Canvas 逐帧图片处理技术方案

## 一、整体架构

```
Canvas/Video → 逐帧提取像素 → 传入 WASM → WASM 处理 → 写回 Canvas
                    ↓                ↓              ↓
             getImageData()    LinearMemory    putImageData()
```

核心链路分三步：**帧提取 → 内存搬运 → WASM 计算 → 回写渲染**，瓶颈在 GPU↔CPU 数据搬运和 JS↔WASM 内存拷贝。

---

## 二、帧数据提取

### 2.1 从 Canvas 获取像素

```js
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// RGBA 格式，每像素 4 字节
const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
const pixels = imageData.data; // Uint8ClampedArray
```

### 2.2 从 Video 逐帧提取

```js
const video = document.getElementById('video');

function captureFrame() {
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
```

### 2.3 getImageData 的性能开销

```
getImageData 做了什么：
  1. GPU → CPU 回读（readPixels），触发 GPU 管线刷新
  2. 像素格式转换（GPU 内部格式 → RGBA uint8）
  3. 分配 JS 堆内存，拷贝像素数据

1080p 单帧数据量 = 1920 × 1080 × 4 = 8,294,400 字节 ≈ 7.9 MB
60fps 理论带宽需求 = 7.9 MB × 60 = 474 MB/s
```

这一步是整条链路中最大的性能瓶颈，后面会讨论如何通过 OffscreenCanvas 和 WebGPU 规避。

---

## 三、JS ↔ WASM 内存交互

### 3.1 WASM 线性内存模型

```
┌────────────────────────────────────────────┐
│              WASM Linear Memory            │
│  ┌──────────┬──────────┬────────────────┐  │
│  │  Stack   │  Heap    │  Free Space    │  │
│  │  (固定)   │ (malloc) │               │  │
│  └──────────┴──────────┴────────────────┘  │
│  0x0000                          memory.grow│
└────────────────────────────────────────────┘
```

WASM 线性内存是一段连续的 `ArrayBuffer`，JS 侧通过 `WebAssembly.Memory` 访问，两端共享同一块内存。

### 3.2 像素数据传入 WASM

```js
// WASM 实例导出的内存和分配函数
const memory = wasmInstance.exports.memory;
const malloc = wasmInstance.exports.malloc;
const free = wasmInstance.exports.free;

// 在 WASM 堆上分配空间
const byteLength = pixels.byteLength;
const ptr = malloc(byteLength);

// 将像素拷贝到 WASM 内存
new Uint8Array(memory.buffer).set(pixels, ptr);
```

### 3.3 处理结果读回 JS

```js
// WASM 原地修改后，从同一指针读回
const result = new Uint8ClampedArray(memory.buffer, ptr, byteLength);
imageData.data.set(result);
ctx.putImageData(imageData, 0, 0);

free(ptr);
```

### 3.4 为什么不能直接传 JS 数组

```
JS 堆 和 WASM 线性内存 是两块独立的地址空间：
  - JS 的 Uint8Array 在 V8 GC 堆上，地址可能被 GC 移动
  - WASM 只能访问自己的线性内存（沙箱隔离）
  - 因此必须 拷贝（set）或 共享（SharedArrayBuffer）
```

---

## 四、WASM 侧处理实现

### 4.1 C 实现示例（灰度化）

```c
#include <emscripten.h>
#include <stdint.h>

EMSCRIPTEN_KEEPALIVE
void grayscale(uint8_t* pixels, int width, int height) {
    int total = width * height * 4;
    for (int i = 0; i < total; i += 4) {
        uint8_t gray = (uint8_t)(
            pixels[i]     * 0.299 +   // R
            pixels[i + 1] * 0.587 +   // G
            pixels[i + 2] * 0.114     // B
        );
        pixels[i]     = gray;
        pixels[i + 1] = gray;
        pixels[i + 2] = gray;
        // Alpha 不变
    }
}
```

### 4.2 Rust 实现示例（wasm-bindgen）

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn grayscale(pixels: &mut [u8], width: u32, height: u32) {
    for chunk in pixels.chunks_exact_mut(4) {
        let gray = (chunk[0] as f32 * 0.299
                  + chunk[1] as f32 * 0.587
                  + chunk[2] as f32 * 0.114) as u8;
        chunk[0] = gray;
        chunk[1] = gray;
        chunk[2] = gray;
    }
}
```

### 4.3 SIMD 加速（C intrinsics）

```c
#include <wasm_simd128.h>

EMSCRIPTEN_KEEPALIVE
void grayscale_simd(uint8_t* pixels, int total_bytes) {
    // 权重向量：R=0.299 G=0.587 B=0.114
    v128_t wr = wasm_f32x4_splat(0.299f);
    v128_t wg = wasm_f32x4_splat(0.587f);
    v128_t wb = wasm_f32x4_splat(0.114f);

    for (int i = 0; i < total_bytes; i += 16) {  // 4 像素一组
        // 加载 4 个像素 (R0G0B0A0 R1G1B1A1 R2G2B2A2 R3G3B3A3)
        v128_t rgba = wasm_v128_load(&pixels[i]);

        // 解包为 float 通道并计算灰度
        // 实际实现需要 shuffle + 类型转换，此处简化示意
        // gray = R*0.299 + G*0.587 + B*0.114

        // 写回（保留 Alpha）
        wasm_v128_store(&pixels[i], result);
    }
}
```

SIMD 可将像素处理吞吐量提升 **2-4 倍**，对 1080p 实时处理至关重要。

---

## 五、完整逐帧处理循环

### 5.1 基础版本

```js
async function initProcessor() {
    const { instance } = await WebAssembly.instantiateStreaming(
        fetch('image_filter.wasm'),
        { env: { /* imports */ } }
    );
    const { memory, malloc, free, grayscale } = instance.exports;

    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const video = document.getElementById('video');

    const frameSize = canvas.width * canvas.height * 4;

    // 预分配内存池，避免每帧 malloc/free
    const inputPtr = malloc(frameSize);

    function processFrame() {
        // 1. 视频帧 → Canvas
        ctx.drawImage(video, 0, 0);

        // 2. Canvas → ImageData
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // 3. JS 堆 → WASM 内存
        new Uint8Array(memory.buffer).set(imageData.data, inputPtr);

        // 4. WASM 处理
        grayscale(inputPtr, canvas.width, canvas.height);

        // 5. WASM 内存 → JS 堆 → Canvas
        imageData.data.set(
            new Uint8ClampedArray(memory.buffer, inputPtr, frameSize)
        );
        ctx.putImageData(imageData, 0, 0);

        requestAnimationFrame(processFrame);
    }

    video.addEventListener('play', () => requestAnimationFrame(processFrame));
}
```

### 5.2 双缓冲流水线

```js
class DoubleBufferProcessor {
    constructor(wasmExports, width, height) {
        const { memory, malloc } = wasmExports;
        this.wasm = wasmExports;
        this.frameSize = width * height * 4;

        // 分配两块 WASM 内存：一块在处理，一块在写入
        this.bufferA = malloc(this.frameSize);
        this.bufferB = malloc(this.frameSize);
        this.currentInput = this.bufferA;
        this.currentOutput = this.bufferB;
    }

    process(imageData) {
        const mem = new Uint8Array(this.wasm.memory.buffer);

        // 写入当前输入缓冲
        mem.set(imageData.data, this.currentInput);

        // WASM 处理：input → output
        this.wasm.process(this.currentInput, this.currentOutput,
                          imageData.width, imageData.height);

        // 从输出缓冲读回
        imageData.data.set(
            new Uint8ClampedArray(this.wasm.memory.buffer,
                                  this.currentOutput, this.frameSize)
        );

        // 交换缓冲
        [this.currentInput, this.currentOutput] =
            [this.currentOutput, this.currentInput];

        return imageData;
    }
}
```

---

## 六、性能优化策略

### 6.1 内存池预分配

```js
// ❌ 每帧分配释放（GC 压力大，碎片化）
function badProcess(imageData) {
    const ptr = malloc(imageData.data.byteLength);
    // ... 处理 ...
    free(ptr);
}

// ✅ 启动时一次性分配，全程复用
const frameSize = width * height * 4;
const ptr = malloc(frameSize);
// 整个生命周期内复用 ptr
```

### 6.2 Web Worker + OffscreenCanvas

将整个处理管线从主线程移出，避免阻塞 UI：

```js
// 主线程
const canvas = document.getElementById('canvas');
const offscreen = canvas.transferControlToOffscreen();

const worker = new Worker('processor-worker.js');
worker.postMessage({
    canvas: offscreen,
    wasmUrl: 'image_filter.wasm',
    width: canvas.width,
    height: canvas.height
}, [offscreen]);
```

```js
// processor-worker.js
self.onmessage = async ({ data }) => {
    const { canvas, wasmUrl, width, height } = data;
    const ctx = canvas.getContext('2d');

    const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl));
    const { memory, malloc, grayscale } = instance.exports;

    const frameSize = width * height * 4;
    const ptr = malloc(frameSize);

    function processLoop() {
        const imageData = ctx.getImageData(0, 0, width, height);
        new Uint8Array(memory.buffer).set(imageData.data, ptr);

        grayscale(ptr, width, height);

        imageData.data.set(
            new Uint8ClampedArray(memory.buffer, ptr, frameSize)
        );
        ctx.putImageData(imageData, 0, 0);

        requestAnimationFrame(processLoop);
    }
    processLoop();
};
```

### 6.3 SharedArrayBuffer 零拷贝

需要设置跨域隔离响应头：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

```js
// 主线程和 Worker 共享同一块内存
const sharedMemory = new WebAssembly.Memory({
    initial: 256,
    maximum: 512,
    shared: true   // 使用 SharedArrayBuffer
});

// 主线程写入像素数据 → Worker 中的 WASM 直接读取
// 无需 postMessage 传递数据，真正的零拷贝
```

### 6.4 帧率自适应

```js
class AdaptiveProcessor {
    constructor(targetFPS = 30) {
        this.targetInterval = 1000 / targetFPS;
        this.lastFrameTime = 0;
        this.processingTime = 0;
        this.skipFrames = false;
    }

    shouldProcess(timestamp) {
        const elapsed = timestamp - this.lastFrameTime;

        // 处理时间超过目标间隔 → 自动降帧
        if (this.processingTime > this.targetInterval) {
            this.skipFrames = !this.skipFrames;
            if (this.skipFrames) return false;
        }

        if (elapsed < this.targetInterval) return false;

        this.lastFrameTime = timestamp;
        return true;
    }

    process(timestamp, callback) {
        if (!this.shouldProcess(timestamp)) {
            requestAnimationFrame(t => this.process(t, callback));
            return;
        }

        const start = performance.now();
        callback();
        this.processingTime = performance.now() - start;

        requestAnimationFrame(t => this.process(t, callback));
    }
}
```

---

## 七、与 WebGPU Compute Shader 对比

| 维度 | WASM + Canvas 2D | WebGPU Compute Shader |
|------|-------------------|-----------------------|
| **数据路径** | GPU → CPU → WASM → CPU → GPU | GPU → GPU（全程显存） |
| **瓶颈** | getImageData/putImageData 回读 | Shader 编译、管线切换 |
| **适用场景** | 复杂算法（ML推理、编解码） | 纯像素级滤镜、并行计算 |
| **兼容性** | 所有现代浏览器 | Chrome 113+，Safari 18+ |
| **编程模型** | C/C++/Rust 迁移成本低 | WGSL Shader 学习曲线 |
| **多帧延迟** | 1 帧（同步处理） | 可能 1-2 帧（异步提交） |

### 7.1 何时选 WASM

- 需要复杂逻辑（条件分支、循环、状态机）
- 已有 C/C++/Rust 图像处理库需要移植
- 需要访问非像素数据（音频、文件、网络）
- 需要最大兼容性

### 7.2 何时选 WebGPU

- 纯像素级并行运算（滤镜、色彩空间转换）
- 帧率要求极高（4K 60fps）
- 处理结果直接用于 WebGPU 渲染管线
- 可以接受有限的浏览器支持

---

## 八、编译工具链

### 8.1 Emscripten（C/C++）

```bash
# 编译命令
emcc filter.c -O3 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_grayscale","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -msimd128 \
  -o filter.js

# 关键编译参数说明：
# -O3              最高优化等级
# -msimd128        启用 WASM SIMD
# ALLOW_MEMORY_GROWTH  允许运行时扩展内存
```

### 8.2 wasm-pack（Rust）

```bash
# 安装工具链
cargo install wasm-pack

# 编译
wasm-pack build --target web --release

# Cargo.toml 配置
[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"

[profile.release]
opt-level = 3
lto = true
```

### 8.3 产物大小优化

```
原始编译产物:    ~150 KB
wasm-opt -O3:   ~80 KB    (Binaryen 优化)
gzip 压缩后:    ~30 KB    (传输大小)

优化手段：
  - wasm-opt -O3 --strip-debug
  - 移除未使用的导出函数
  - 使用 wee_alloc 替代默认分配器（Rust）
  - LTO (Link Time Optimization)
```

---

## 九、数据流全景图

```
┌─────────────────────────────────────────────────────────────┐
│                      主线程 / Worker                         │
│                                                             │
│  ┌─────────┐  drawImage  ┌─────────┐  getImageData          │
│  │  Video   │ ──────────→│  Canvas  │──────────────┐         │
│  │ Element  │            │  2D Ctx  │              ↓         │
│  └─────────┘            └─────────┘      ┌──────────────┐   │
│                                          │  ImageData    │   │
│                                          │ Uint8Clamped  │   │
│                                          │  (JS 堆)      │   │
│                                          └──────┬───────┘   │
│                                                 │ .set()    │
│  ┌──────────────────────────────────────────────▼────────┐  │
│  │              WASM Linear Memory                       │  │
│  │  ┌──────────┬──────────────────┬───────────────────┐  │  │
│  │  │  Stack   │  Buffer A (帧)   │  Buffer B (帧)    │  │  │
│  │  └──────────┴────────┬─────────┴───────────────────┘  │  │
│  │                      │ process_frame()                 │  │
│  │                      ↓                                 │  │
│  │              SIMD / 标量计算                             │  │
│  │              (灰度/模糊/边缘检测...)                      │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │ 读回                               │
│                  ┌──────▼───────┐                            │
│                  │  ImageData    │                            │
│                  └──────┬───────┘                            │
│                         │ putImageData                       │
│                  ┌──────▼───────┐                            │
│                  │   Canvas      │  → 最终渲染到屏幕           │
│                  └──────────────┘                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 十、性能优化总结

| 优化手段 | 效果 | 实现复杂度 |
|---------|------|-----------|
| 内存池预分配 | 消除每帧 GC 抖动 | 低 |
| WASM SIMD | 像素处理提速 2-4× | 中 |
| Web Worker + OffscreenCanvas | 主线程零阻塞 | 中 |
| SharedArrayBuffer | 减少一次内存拷贝 | 中（需跨域头） |
| 双缓冲 | 处理/渲染流水线化 | 低 |
| 帧率自适应 | 低端设备不卡顿 | 低 |
| 降采样处理 | 减少像素总量 | 低 |
| WebGPU 替换 | 消除 GPU↔CPU 回读 | 高 |
