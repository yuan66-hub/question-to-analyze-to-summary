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

---

## 十一、视频编辑器轨道场景下的逐帧处理

前面的章节聚焦于单一视频/图片的像素级处理。实际的视频编辑器场景要复杂得多——用户在画布上拖拽、缩放、旋转多个素材，时间轴上多轨道叠加，每一帧都是多图层合成的结果。

### 11.1 编辑器数据模型

```
┌──────────────────────────────────────────────────────────┐
│                     Timeline（时间轴）                     │
│                                                          │
│  Track 0 (文字层)  ▓▓▓▓▓▓▓▓░░░░░░▓▓▓▓▓▓▓▓▓▓░░░░░░░░░  │
│  Track 1 (贴纸层)  ░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░  │
│  Track 2 (图片层)  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │
│  Track 3 (视频层)  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │
│                                                          │
│  ──────────────────►  时间                                │
│              ▲ 播放头                                     │
└──────────────────────────────────────────────────────────┘
```

```ts
// 轨道上每个素材片段（Clip）的核心数据结构
interface Clip {
    id: string;
    type: 'video' | 'image' | 'text' | 'sticker';
    trackIndex: number;

    // 时间维度
    startTime: number;     // 在时间轴上的起始时间 (ms)
    duration: number;      // 持续时长 (ms)
    sourceOffset: number;  // 素材裁剪偏移

    // 空间维度（画布上的变换属性）
    transform: {
        x: number;          // 画布上的 X 坐标
        y: number;          // 画布上的 Y 坐标
        width: number;      // 渲染宽度
        height: number;     // 渲染高度
        rotation: number;   // 旋转角度 (deg)
        scaleX: number;     // 水平缩放
        scaleY: number;     // 垂直缩放
        opacity: number;    // 透明度 0-1
    };

    // 关键帧动画
    keyframes: Keyframe[];

    // 滤镜/特效链
    filters: Filter[];
}

interface Keyframe {
    time: number;                           // 相对于 clip startTime 的偏移
    property: keyof Clip['transform'];      // 变化的属性
    value: number;
    easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
}
```

### 11.2 单帧合成流水线

用户拖动播放头到某一时刻，或实时播放时，每一帧的渲染过程：

```
当前时间 currentTime
        │
        ▼
┌───────────────────┐
│ 1. 查询可见 Clips  │  遍历所有轨道，找出在 currentTime 区间内的 Clip
└────────┬──────────┘
         ▼
┌───────────────────┐
│ 2. 关键帧插值      │  根据 currentTime 计算每个 Clip 当前的 transform 值
└────────┬──────────┘
         ▼
┌───────────────────┐
│ 3. 逐层渲染        │  从底层 Track 到顶层，依次绘制到合成画布
│   ├─ 视频层：解码帧 + WASM 滤镜处理
│   ├─ 图片层：仿射变换（位移/缩放/旋转）
│   ├─ 贴纸层：带 Alpha 通道的叠加
│   └─ 文字层：文字栅格化 + 描边/阴影
└────────┬──────────┘
         ▼
┌───────────────────┐
│ 4. 最终合成输出     │  putImageData / drawImage 到预览画布
└───────────────────┘
```

```js
class FrameCompositor {
    constructor(canvas, wasmExports) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.wasm = wasmExports;

        // 合成用的离屏 Canvas（避免中间态闪烁）
        this.offscreen = new OffscreenCanvas(canvas.width, canvas.height);
        this.offCtx = this.offscreen.getContext('2d');
    }

    renderFrame(currentTime, tracks) {
        const { offCtx, offscreen } = this;
        offCtx.clearRect(0, 0, offscreen.width, offscreen.height);

        // 从底层轨道往上逐层绘制
        for (let i = tracks.length - 1; i >= 0; i--) {
            const clip = this.getActiveClip(tracks[i], currentTime);
            if (!clip) continue;

            // 计算当前帧的插值变换
            const transform = this.interpolateTransform(clip, currentTime);

            offCtx.save();
            offCtx.globalAlpha = transform.opacity;

            // 应用仿射变换：先移到中心点，再旋转/缩放
            offCtx.translate(
                transform.x + transform.width / 2,
                transform.y + transform.height / 2
            );
            offCtx.rotate(transform.rotation * Math.PI / 180);
            offCtx.scale(transform.scaleX, transform.scaleY);

            // 绘制素材（以中心点为原点偏移回来）
            this.drawClipContent(offCtx, clip, transform, currentTime);

            offCtx.restore();
        }

        // 离屏 → 主画布（单次 drawImage，避免闪烁）
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(offscreen, 0, 0);
    }

    getActiveClip(track, time) {
        return track.clips.find(c =>
            time >= c.startTime && time < c.startTime + c.duration
        );
    }
}
```

### 11.3 画布交互：拖拽移动与缩放

用户在画布区域对素材进行移动、缩放、旋转操作时，核心是**修改 Clip 的 transform 属性 → 触发当前帧重新合成**。

#### 拖拽移动

```js
class CanvasInteraction {
    constructor(compositor, clips) {
        this.compositor = compositor;
        this.clips = clips;
        this.dragging = null;
        this.resizing = null;

        this.bindEvents();
    }

    bindEvents() {
        const canvas = this.compositor.canvas;
        canvas.addEventListener('pointerdown', this.onPointerDown.bindI(this));
        canvas.addEventListener('pointermove', this.onPointerMove.bind(this));
        canvas.addEventListener('pointerup', this.onPointerUp.bind(this));
    }

    // 命中检测：判断点击落在哪个 Clip 上
    hitTest(x, y) {
        // 从顶层往下检测（上层优先）
        for (const clip of [...this.clips].reverse()) {
            const t = clip.transform;

            // 将点击坐标转换到 Clip 的局部坐标系
            const cx = t.x + t.width / 2;
            const cy = t.y + t.height / 2;
            const rad = -t.rotation * Math.PI / 180;

            const dx = x - cx;
            const dy = y - cy;
            const localX = dx * Math.cos(rad) - dy * Math.sin(rad) + t.width / 2;
            const localY = dx * Math.sin(rad) + dy * Math.cos(rad) + t.height / 2;

            if (localX >= 0 && localX <= t.width &&
                localY >= 0 && localY <= t.height) {
                // 检查是否命中边缘控制点（用于缩放）
                const handle = this.hitResizeHandle(localX, localY, t);
                return { clip, handle };
            }
        }
        return null;
    }

    // 检测是否命中四角/四边的缩放控制点
    hitResizeHandle(localX, localY, transform) {
        const { width, height } = transform;
        const handleSize = 10;
        const handles = [
            { name: 'nw', x: 0,     y: 0 },
            { name: 'ne', x: width,  y: 0 },
            { name: 'sw', x: 0,     y: height },
            { name: 'se', x: width,  y: height },
            { name: 'n',  x: width / 2, y: 0 },
            { name: 's',  x: width / 2, y: height },
            { name: 'w',  x: 0,         y: height / 2 },
            { name: 'e',  x: width,      y: height / 2 },
        ];

        for (const h of handles) {
            if (Math.abs(localX - h.x) < handleSize &&
                Math.abs(localY - h.y) < handleSize) {
                return h.name;
            }
        }
        return null;  // 非控制点区域 → 移动模式
    }

    onPointerDown(e) {
        const { x, y } = this.canvasCoords(e);
        const hit = this.hitTest(x, y);
        if (!hit) return;

        if (hit.handle) {
            this.resizing = { clip: hit.clip, handle: hit.handle, startX: x, startY: y,
                              original: { ...hit.clip.transform } };
        } else {
            this.dragging = { clip: hit.clip, offsetX: x - hit.clip.transform.x,
                              offsetY: y - hit.clip.transform.y };
        }
    }

    onPointerMove(e) {
        const { x, y } = this.canvasCoords(e);

        if (this.dragging) {
            const { clip, offsetX, offsetY } = this.dragging;
            clip.transform.x = x - offsetX;
            clip.transform.y = y - offsetY;
            this.requestRender();
        }

        if (this.resizing) {
            this.applyResize(x, y);
            this.requestRender();
        }
    }

    onPointerUp() {
        this.dragging = null;
        this.resizing = null;
    }

    canvasCoords(e) {
        const rect = this.compositor.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (this.compositor.canvas.width / rect.width),
            y: (e.clientY - rect.top) * (this.compositor.canvas.height / rect.height)
        };
    }

    // 节流：每帧最多渲染一次
    requestRender() {
        if (this._rafId) return;
        this._rafId = requestAnimationFrame(() => {
            this.compositor.renderFrame(this.currentTime, this.tracks);
            this._rafId = null;
        });
    }
}
```

#### 缩放/修改宽高

```js
applyResize(mouseX, mouseY) {
    const { clip, handle, startX, startY, original } = this.resizing;
    const dx = mouseX - startX;
    const dy = mouseY - startY;
    const t = clip.transform;

    // 根据控制点方向计算新尺寸
    switch (handle) {
        case 'se':  // 右下角：最常见的自由缩放
            t.width  = Math.max(20, original.width + dx);
            t.height = Math.max(20, original.height + dy);
            break;

        case 'nw':  // 左上角：宽高变化的同时需要移动原点
            t.width  = Math.max(20, original.width - dx);
            t.height = Math.max(20, original.height - dy);
            t.x = original.x + dx;
            t.y = original.y + dy;
            break;

        case 'e':   // 右边中点：只改宽度
            t.width = Math.max(20, original.width + dx);
            break;

        case 's':   // 下边中点：只改高度
            t.height = Math.max(20, original.height + dy);
            break;

        // ... 其他控制点类似
    }

    // 按住 Shift 等比缩放
    if (this.shiftKey && (handle === 'nw' || handle === 'ne' ||
                          handle === 'sw' || handle === 'se')) {
        const ratio = original.width / original.height;
        t.height = t.width / ratio;
    }
}
```

### 11.4 变换操作在 WASM 中的处理

画布上的移动/缩放有两种处理策略：

```
策略一：Canvas 2D API 处理变换（推荐用于实时预览）
  ctx.translate / ctx.scale / ctx.rotate + ctx.drawImage
  → 浏览器 GPU 加速，极快，但无法叠加像素级滤镜

策略二：WASM 处理变换（用于最终导出 / 需要像素级精确控制）
  → 在 WASM 中做仿射变换 + 双线性插值 + 滤镜，一步到位
  → 更慢但结果精确，适合离线渲染
```

#### WASM 仿射变换实现（缩放 + 旋转 + 平移）

```c
typedef struct {
    float a, b, c, d, tx, ty;  // 2x3 仿射矩阵
} AffineMatrix;

// 构建变换矩阵：平移 → 旋转 → 缩放
AffineMatrix build_transform(float x, float y, float w, float h,
                              float scaleX, float scaleY, float rotation_deg) {
    float rad = rotation_deg * 3.14159265f / 180.0f;
    float cosR = cosf(rad);
    float sinR = sinf(rad);
    float cx = x + w / 2.0f;  // 旋转中心
    float cy = y + h / 2.0f;

    // 组合矩阵：T(cx,cy) * R(θ) * S(sx,sy) * T(-cx,-cy)
    AffineMatrix m;
    m.a  = cosR * scaleX;
    m.b  = sinR * scaleX;
    m.c  = -sinR * scaleY;
    m.d  = cosR * scaleY;
    m.tx = cx - m.a * cx - m.c * cy;
    m.ty = cy - m.b * cx - m.d * cy;
    return m;
}

// 将源图像通过仿射变换绘制到目标画布
EMSCRIPTEN_KEEPALIVE
void affine_transform(
    uint8_t* src, int srcW, int srcH,
    uint8_t* dst, int dstW, int dstH,
    float a, float b, float c, float d, float tx, float ty
) {
    // 逆矩阵：从目标像素反推源像素坐标
    float det = a * d - b * c;
    float ia =  d / det, ib = -b / det;
    float ic = -c / det, id =  a / det;
    float itx = -(ia * tx + ic * ty);
    float ity = -(ib * tx + id * ty);

    for (int y = 0; y < dstH; y++) {
        for (int x = 0; x < dstW; x++) {
            // 目标像素 → 源坐标（浮点）
            float srcX = ia * x + ic * y + itx;
            float srcY = ib * x + id * y + ity;

            // 双线性插值采样
            int dstIdx = (y * dstW + x) * 4;
            if (srcX >= 0 && srcX < srcW - 1 && srcY >= 0 && srcY < srcH - 1) {
                bilinear_sample(src, srcW, srcX, srcY, &dst[dstIdx]);
            } else {
                // 超出边界 → 透明
                dst[dstIdx] = dst[dstIdx+1] = dst[dstIdx+2] = dst[dstIdx+3] = 0;
            }
        }
    }
}

// 双线性插值：亚像素精度采样，避免缩放锯齿
void bilinear_sample(uint8_t* src, int stride,
                      float x, float y, uint8_t* out) {
    int x0 = (int)x, y0 = (int)y;
    float fx = x - x0, fy = y - y0;

    int idx00 = (y0 * stride + x0) * 4;
    int idx10 = idx00 + 4;
    int idx01 = idx00 + stride * 4;
    int idx11 = idx01 + 4;

    for (int c = 0; c < 4; c++) {
        float v = src[idx00+c] * (1-fx) * (1-fy)
                + src[idx10+c] * fx     * (1-fy)
                + src[idx01+c] * (1-fx) * fy
                + src[idx11+c] * fx     * fy;
        out[c] = (uint8_t)(v + 0.5f);
    }
}
```

### 11.5 实时预览 vs 导出渲染的双模架构

```
┌─────────────────────────────────────────────────────────┐
│                   视频编辑器渲染架构                       │
│                                                         │
│  ┌─────────────────────┐  ┌──────────────────────────┐  │
│  │   实时预览模式        │  │   导出渲染模式             │  │
│  │                     │  │                          │  │
│  │  Canvas 2D API 变换  │  │  WASM 全量像素处理         │  │
│  │  ├ translate/scale  │  │  ├ 仿射变换 + 双线性插值    │  │
│  │  ├ drawImage 缩放   │  │  ├ 滤镜链逐像素处理        │  │
│  │  └ GPU 硬件加速      │  │  ├ Alpha 混合合成多图层    │  │
│  │                     │  │  └ 编码输出（WebCodecs）   │  │
│  │  目标：<16ms/帧      │  │                          │  │
│  │  精度：屏幕像素级足够  │  │  目标：质量优先           │  │
│  │                     │  │  精度：源素材分辨率         │  │
│  └─────────────────────┘  └──────────────────────────┘  │
│                                                         │
│  用户拖拽 → 预览模式（快）                                 │
│  点击导出 → 渲染模式（精确）                               │
└─────────────────────────────────────────────────────────┘
```

```js
class DualModeRenderer {
    constructor(canvas, wasmExports) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.wasm = wasmExports;
    }

    // 实时预览：用 Canvas 2D API 做变换，GPU 加速极快
    renderPreview(clip, sourceImage) {
        this.ctx.save();
        const t = clip.transform;

        this.ctx.globalAlpha = t.opacity;
        this.ctx.translate(t.x + t.width / 2, t.y + t.height / 2);
        this.ctx.rotate(t.rotation * Math.PI / 180);
        this.ctx.scale(t.scaleX, t.scaleY);

        // drawImage 自带缩放，浏览器内部做双线性/双三次插值
        this.ctx.drawImage(sourceImage,
            -t.width / 2, -t.height / 2, t.width, t.height);

        this.ctx.restore();
    }

    // 导出渲染：WASM 逐像素处理，精度最高
    renderExport(clip, sourcePixels, srcW, srcH, outputBuffer, outW, outH) {
        const t = clip.transform;
        const mem = new Uint8Array(this.wasm.memory.buffer);

        // 1. 源像素写入 WASM
        const srcPtr = this.wasm.malloc(sourcePixels.byteLength);
        mem.set(sourcePixels, srcPtr);

        // 2. 先做滤镜处理（在源分辨率上处理，质量最高）
        for (const filter of clip.filters) {
            this.wasm[filter.type](srcPtr, srcW, srcH, ...filter.params);
        }

        // 3. 仿射变换：缩放 + 旋转 + 定位到画布坐标
        const dstPtr = this.wasm.malloc(outW * outH * 4);
        this.wasm.affine_transform(
            srcPtr, srcW, srcH,
            dstPtr, outW, outH,
            t.scaleX, t.rotation, /* 矩阵参数 */
        );

        // 4. 读回结果
        outputBuffer.set(new Uint8Array(mem.buffer, dstPtr, outW * outH * 4));

        this.wasm.free(srcPtr);
        this.wasm.free(dstPtr);
    }
}
```

### 11.6 关键帧插值与动画

用户可以对素材设置关键帧（例如 0s 时在左侧，2s 时移动到右侧），播放时需要在每帧插值计算中间状态。

```js
class KeyframeInterpolator {
    // 根据当前时间插值 Clip 的 transform
    interpolate(clip, currentTime) {
        const localTime = currentTime - clip.startTime;
        const result = { ...clip.transform };

        // 按属性分组关键帧
        const grouped = this.groupByProperty(clip.keyframes);

        for (const [prop, frames] of Object.entries(grouped)) {
            if (frames.length === 0) continue;

            // 找到当前时间前后的两个关键帧
            const { prev, next } = this.findBracketFrames(frames, localTime);

            if (!prev && next)  { result[prop] = next.value; continue; }
            if (prev && !next)  { result[prop] = prev.value; continue; }
            if (!prev && !next) continue;

            // 计算插值进度 [0, 1]
            const t = (localTime - prev.time) / (next.time - prev.time);

            // 应用缓动函数
            const easedT = this.applyEasing(t, next.easing);

            // 线性插值
            result[prop] = prev.value + (next.value - prev.value) * easedT;
        }

        return result;
    }

    applyEasing(t, easing) {
        switch (easing) {
            case 'linear':     return t;
            case 'easeIn':     return t * t;
            case 'easeOut':    return t * (2 - t);
            case 'easeInOut':  return t < 0.5
                                   ? 2 * t * t
                                   : -1 + (4 - 2 * t) * t;
            default: return t;
        }
    }

    findBracketFrames(frames, time) {
        let prev = null, next = null;
        for (const f of frames) {
            if (f.time <= time) prev = f;
            if (f.time > time && !next) next = f;
        }
        return { prev, next };
    }

    groupByProperty(keyframes) {
        const groups = {};
        for (const kf of keyframes) {
            (groups[kf.property] ||= []).push(kf);
        }
        // 每组按时间排序
        for (const arr of Object.values(groups)) {
            arr.sort((a, b) => a.time - b.time);
        }
        return groups;
    }
}
```

### 11.7 脏区检测：只重绘变化的区域

用户拖拽单个素材时，不需要重绘整个画布。脏区检测可以大幅减少 WASM 处理量。

```js
class DirtyRegionTracker {
    constructor(canvasWidth, canvasHeight) {
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;
        this.dirtyRects = [];
    }

    // 素材变换变化时，标记旧位置和新位置都为脏区
    markDirty(oldTransform, newTransform) {
        this.dirtyRects.push(this.getBoundingRect(oldTransform));
        this.dirtyRects.push(this.getBoundingRect(newTransform));
    }

    // 计算旋转后的 AABB 包围盒
    getBoundingRect(t) {
        const cx = t.x + t.width / 2;
        const cy = t.y + t.height / 2;
        const rad = t.rotation * Math.PI / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));

        // 旋转后的包围盒尺寸
        const bw = t.width * cos + t.height * sin;
        const bh = t.width * sin + t.height * cos;

        return {
            x: Math.floor(cx - bw / 2),
            y: Math.floor(cy - bh / 2),
            width: Math.ceil(bw),
            height: Math.ceil(bh)
        };
    }

    // 合并所有脏区为一个最小包围矩形
    getMergedDirtyRect() {
        if (this.dirtyRects.length === 0) return null;

        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        for (const r of this.dirtyRects) {
            minX = Math.min(minX, r.x);
            minY = Math.min(minY, r.y);
            maxX = Math.max(maxX, r.x + r.width);
            maxY = Math.max(maxY, r.y + r.height);
        }

        // 裁剪到画布范围
        return {
            x: Math.max(0, minX),
            y: Math.max(0, minY),
            width: Math.min(this.canvasWidth, maxX) - Math.max(0, minX),
            height: Math.min(this.canvasHeight, maxY) - Math.max(0, minY)
        };
    }

    clear() {
        this.dirtyRects = [];
    }
}

// 使用脏区优化渲染
function optimizedRender(compositor, dirtyTracker, currentTime, tracks) {
    const dirtyRect = dirtyTracker.getMergedDirtyRect();
    if (!dirtyRect) return; // 无变化，跳过渲染

    const ctx = compositor.ctx;

    // 只清除脏区
    ctx.clearRect(dirtyRect.x, dirtyRect.y, dirtyRect.width, dirtyRect.height);

    // 设置裁剪区域，只渲染脏区范围内的内容
    ctx.save();
    ctx.beginPath();
    ctx.rect(dirtyRect.x, dirtyRect.y, dirtyRect.width, dirtyRect.height);
    ctx.clip();

    // 在裁剪区域内重绘所有图层
    compositor.renderFrame(currentTime, tracks);

    ctx.restore();
    dirtyTracker.clear();
}
```

### 11.8 多图层 Alpha 混合合成（WASM 实现）

导出时多个轨道素材需要在 WASM 中逐像素合成：

```c
// Porter-Duff Source Over 混合模式
// dst = src * srcAlpha + dst * (1 - srcAlpha)
EMSCRIPTEN_KEEPALIVE
void composite_over(
    uint8_t* dst,     // 已有的合成结果（底层）
    uint8_t* src,     // 当前层（上层）
    int width, int height,
    float globalAlpha  // 图层整体透明度
) {
    int total = width * height * 4;
    for (int i = 0; i < total; i += 4) {
        float srcA = (src[i + 3] / 255.0f) * globalAlpha;
        float dstA = dst[i + 3] / 255.0f;
        float outA = srcA + dstA * (1.0f - srcA);

        if (outA > 0.001f) {
            for (int c = 0; c < 3; c++) {
                dst[i + c] = (uint8_t)(
                    (src[i + c] * srcA + dst[i + c] * dstA * (1.0f - srcA))
                    / outA
                );
            }
        }
        dst[i + 3] = (uint8_t)(outA * 255.0f);
    }
}

// 多图层合成入口
EMSCRIPTEN_KEEPALIVE
void composite_layers(
    uint8_t** layers,       // 各图层像素数组
    float* opacities,       // 各图层透明度
    int layerCount,
    int width, int height,
    uint8_t* output         // 输出合成结果
) {
    // 清空输出缓冲
    memset(output, 0, width * height * 4);

    // 从底层到顶层逐层合成
    for (int i = 0; i < layerCount; i++) {
        composite_over(output, layers[i], width, height, opacities[i]);
    }
}
```

### 11.9 完整帧处理时序

以用户在画布上拖拽移动图片为例，一次拖拽操作的完整时序：

```
用户操作                   JS 层                          渲染层
  │                         │                              │
  │  pointerdown            │                              │
  ├────────────────────────→│                              │
  │                         │  hitTest() 命中检测           │
  │                         │  确定操作目标 + 模式           │
  │                         │                              │
  │  pointermove (高频)     │                              │
  ├────────────────────────→│                              │
  │                         │  更新 clip.transform.x/y     │
  │                         │  markDirty(old, new)         │
  │                         │  requestAnimationFrame()     │
  │                         │         │                    │
  │  pointermove            │         │                    │
  ├────────────────────────→│         │                    │
  │                         │  更新 transform（合并）       │
  │                         │  已有 rAF，跳过               │
  │                         │         │                    │
  │                         │         ▼ rAF 回调           │
  │                         │  ┌──────────────────────┐    │
  │                         │  │ 1. 获取脏区            │    │
  │                         │  │ 2. clip 裁剪范围       │    │
  │                         │  │ 3. 逐层 drawImage     │───→│ GPU 渲染
  │                         │  │ 4. 清除脏区标记         │    │
  │                         │  └──────────────────────┘    │
  │                         │                              │
  │  pointerup              │                              │
  ├────────────────────────→│                              │
  │                         │  记录操作到 undo 栈           │
  │                         │  dragging = null             │
```

关键点：
- **pointermove 事件合并**：浏览器一帧内可能触发多次 pointermove，通过 rAF 节流确保一帧只渲染一次
- **预览用 Canvas API**：拖拽过程中用 `drawImage` + `translate/scale`，纯 GPU 操作，16ms 内完成
- **WASM 仅在导出时介入**：导出视频时才切换到 WASM 逐像素处理模式，保证精度

---

## 十二、总结：视频编辑器 WASM 帧处理分层架构

```
┌───────────────────────────────────────────────────────────┐
│                     用户交互层                              │
│  画布拖拽 / 缩放 / 旋转 / 时间轴拖动 / 关键帧编辑            │
└───────────────────────┬───────────────────────────────────┘
                        │ 修改 Clip transform / keyframes
┌───────────────────────▼───────────────────────────────────┐
│                     数据模型层                              │
│  Timeline → Track[] → Clip[] → { transform, keyframes }   │
└───────────────────────┬───────────────────────────────────┘
                        │ 当前帧数据
┌───────────────────────▼───────────────────────────────────┐
│                     合成引擎层                              │
│                                                           │
│   ┌─────────────────┐        ┌──────────────────────┐     │
│   │  预览模式（快）    │        │  导出模式（精确）       │     │
│   │  Canvas 2D API  │        │  WASM 逐像素          │     │
│   │  GPU 硬件加速    │        │  仿射变换 + 滤镜       │     │
│   │  脏区局部重绘    │        │  Alpha 合成多图层      │     │
│   │  <16ms / 帧     │        │  WebCodecs 编码输出   │     │
│   └─────────────────┘        └──────────────────────┘     │
└───────────────────────────────────────────────────────────┘
```
