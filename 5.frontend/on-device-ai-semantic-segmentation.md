# 端侧 AI 语义分割前端应用深度解析

> 从模型推理、推理加速、图像处理管线、推理调度、模型工程优化、性能优化到浏览器内存管理的多维度系统分析。

---

## 目录

1. [端侧推理工程全景架构](#1-端侧推理工程全景架构)
2. [语义分割模型选型与工程适配](#2-语义分割模型选型与工程适配)
3. [端侧模型推理引擎](#3-端侧模型推理引擎)
4. [推理加速策略](#4-推理加速策略)
5. [图像处理管线](#5-图像处理管线)
6. [推理调度架构](#6-推理调度架构)
7. [模型工程优化](#7-模型工程优化)
8. [推理性能优化](#8-推理性能优化)
9. [浏览器内存管理](#9-浏览器内存管理)
10. [端到端架构实战](#10-端到端架构实战)

---

## 1. 端侧推理工程全景架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        应用层 (React/Vue)                       │
│   相机输入 → 预处理 → 推理调度 → 后处理 → 蒙版渲染 → 合成输出    │
├─────────────────────────────────────────────────────────────────┤
│                      推理框架层                                  │
│  ONNX Runtime Web │ TensorFlow.js │ MediaPipe │ Transformers.js │
├─────────────────────────────────────────────────────────────────┤
│                      加速后端层                                  │
│      WebGPU        │    WebGL 2     │   WASM (SIMD + Threads)   │
├─────────────────────────────────────────────────────────────────┤
│                      浏览器运行时                                │
│  Web Worker │ OffscreenCanvas │ SharedArrayBuffer │ IndexedDB   │
├─────────────────────────────────────────────────────────────────┤
│                      硬件层                                      │
│         GPU (dGPU/iGPU)    │    CPU (x86/ARM)    │    NPU       │
└─────────────────────────────────────────────────────────────────┘
```

### 核心挑战

| 维度 | 云端推理 | 端侧浏览器推理 |
|------|---------|---------------|
| 算力 | A100/H100 GPU | 消费级 GPU / 集成显卡 |
| 内存 | 数十 GB VRAM | 浏览器标签页 ~4GB 上限 |
| 模型大小 | 不受限 | 需 < 50MB（理想 < 20MB） |
| 延迟 | 网络往返 50-200ms | 本地推理 10-100ms |
| 隐私 | 数据上传 | 数据不出端 |
| 可用性 | 依赖网络 | 离线可用 |

---

## 2. 语义分割模型选型与工程适配

### 2.1 模型架构对比

| 模型 | 参数量 | 输入分辨率 | mIoU (ADE20K) | 推理速度 (WebGPU) | 适用场景 |
|------|--------|-----------|---------------|-------------------|---------|
| **MobileNetV3 + DeepLabV3** | 2.1M | 512×512 | 60.3% | ~25ms | 实时人像分割 |
| **EfficientSeg (Lite)** | 1.5M | 256×256 | 55.8% | ~15ms | 移动端极速场景 |
| **SegFormer-B0** | 3.7M | 512×512 | 37.4% | ~40ms | 通用语义分割 |
| **PP-LiteSeg** | 1.8M | 512×512 | 58.1% | ~20ms | 工业级轻量分割 |
| **MediaPipe Selfie** | 0.3M | 256×256 | - | ~8ms | 人像/背景分割 |
| **SAM-Tiny (蒸馏)** | 5.0M | 1024×1024 | 62.5% | ~80ms | 交互式分割 |

### 2.2 模型适配工程

**从训练到端侧部署的转换链路：**

```
PyTorch 模型
    │
    ├─→ torch.onnx.export() ──→ ONNX ──→ ONNX Runtime Web
    │                            │
    │                            ├─→ onnxruntime 量化工具 ──→ INT8 ONNX
    │                            └─→ onnx-simplifier ──→ 优化图结构
    │
    ├─→ TFLite Converter ──→ .tflite ──→ TensorFlow.js (via TFJS converter)
    │
    └─→ TorchScript ──→ ONNX ──→ WebGPU 自定义 Shader
```

**ONNX 导出关键配置：**

```python
import torch

model = load_segmentation_model("mobilenet_v3_deeplabv3")
model.eval()

dummy_input = torch.randn(1, 3, 512, 512)

torch.onnx.export(
    model,
    dummy_input,
    "seg_model.onnx",
    opset_version=17,           # 高版本支持更多算子
    input_names=["image"],
    output_names=["mask"],
    dynamic_axes={               # 支持动态分辨率
        "image": {2: "height", 3: "width"},
        "mask": {2: "height", 3: "width"}
    }
)
```

### 2.3 语义分割输出解析

```
模型输出 Tensor: [1, num_classes, H, W]
    │
    ├─ argmax(dim=1) ──→ [1, H, W] 类别索引图
    │                      每个像素值 = 类别 ID (0=背景, 1=人, 2=车...)
    │
    └─ softmax(dim=1) ──→ [1, num_classes, H, W] 概率图
                           每个像素每个类别的置信度
```

---

## 3. 端侧模型推理引擎

### 3.1 ONNX Runtime Web（主流推荐）

```typescript
import * as ort from 'onnxruntime-web';

// 配置 WebGPU 后端
ort.env.wasm.numThreads = navigator.hardwareConcurrency;
ort.env.wasm.simd = true;

class SegmentationEngine {
    private session: ort.InferenceSession | null = null;

    async init(modelPath: string) {
        this.session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['webgpu', 'wasm'],  // 优先 WebGPU，回退 WASM
            graphOptimizationLevel: 'all',
            enableCpuMemArena: true,
            // WebGPU 特定配置
            preferredOutputLocation: 'gpu-buffer',   // 输出保留在 GPU 避免回读
        });
    }

    async infer(imageData: Float32Array, width: number, height: number) {
        const inputTensor = new ort.Tensor('float32', imageData, [1, 3, height, width]);
        const results = await this.session!.run({ image: inputTensor });
        return results.mask;  // [1, num_classes, H, W]
    }

    dispose() {
        this.session?.release();
    }
}
```

### 3.2 推理引擎后端对比

| 特性 | WebGPU | WebGL 2 | WASM (SIMD) |
|------|--------|---------|-------------|
| 并行计算 | Compute Shader，通用计算 | Fragment Shader，受限于渲染管线 | SIMD 128-bit 向量 |
| 内存管理 | 显式 Buffer 控制 | 纹理采样，尺寸受限 | 线性内存，可精确控制 |
| 精度 | FP32/FP16 | FP32（部分 FP16） | FP32/INT8 |
| 算子支持 | 灵活自定义 | 受限于纹理操作 | 完整 CPU 算子 |
| 兼容性 | Chrome 113+, Edge 113+ | 广泛支持 | 广泛支持 |
| 典型加速比 | 5-20× vs JS | 3-10× vs JS | 2-5× vs JS |
| 适用模型大小 | 中大型（> 5MB） | 中型 | 小型（< 5MB） |

### 3.3 WebGPU 自定义算子示例

对于推理框架不支持的后处理算子，可用 WebGPU Compute Shader 实现：

```typescript
// argmax Compute Shader —— 将 [1, C, H, W] 概率图转为 [H, W] 类别图
const argmaxShader = `
@group(0) @binding(0) var<storage, read> probs: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;

struct Params {
    num_classes: u32,
    width: u32,
    height: u32,
}
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= params.width || y >= params.height) { return; }

    let pixel_idx = y * params.width + x;
    var max_val: f32 = -1e10;
    var max_class: u32 = 0u;

    for (var c: u32 = 0u; c < params.num_classes; c = c + 1u) {
        let idx = c * params.height * params.width + pixel_idx;
        let val = probs[idx];
        if (val > max_val) {
            max_val = val;
            max_class = c;
        }
    }
    output[pixel_idx] = max_class;
}
`;
```

---

## 4. 推理加速策略

### 4.1 模型量化

```
FP32 (4B/param)  →  FP16 (2B/param)  →  INT8 (1B/param)  →  INT4 (0.5B/param)
   基准精度           几乎无损            mIoU 下降 < 1%       mIoU 下降 2-3%
   模型 8MB           模型 4MB            模型 2MB              模型 1MB
   推理 40ms          推理 22ms           推理 15ms             推理 12ms
```

**ONNX Runtime 动态量化：**

```python
from onnxruntime.quantization import quantize_dynamic, QuantType

quantize_dynamic(
    model_input="seg_model.onnx",
    model_output="seg_model_int8.onnx",
    weight_type=QuantType.QUInt8,
    per_channel=True,          # 逐通道量化，精度更高
    reduce_range=True,         # 适配 WASM 的 INT8 范围
)
```

**静态量化（精度更高，需校准数据）：**

```python
from onnxruntime.quantization import quantize_static, CalibrationDataReader

class SegCalibrationReader(CalibrationDataReader):
    def __init__(self, calibration_images):
        self.data = iter(calibration_images)

    def get_next(self):
        try:
            return {"image": next(self.data)}
        except StopIteration:
            return None

quantize_static(
    model_input="seg_model.onnx",
    model_output="seg_model_int8_static.onnx",
    calibration_data_reader=SegCalibrationReader(calib_images),
    quant_format=QuantFormat.QDQ,        # QDQ 格式更适合 GPU 后端
    per_channel=True,
    activation_type=QuantType.QUInt8,
    weight_type=QuantType.QInt8,
)
```

### 4.2 模型剪枝与蒸馏

```
知识蒸馏链路：
┌──────────────────┐        ┌──────────────────┐
│  Teacher Model   │        │  Student Model   │
│  SegFormer-B5    │  ───→  │  MobileNetV3     │
│  84.0 mIoU       │  KD    │  60.3 → 64.8 mIoU│
│  82M params      │        │  2.1M params     │
│  不可端侧部署     │        │  端侧 25ms       │
└──────────────────┘        └──────────────────┘

蒸馏 Loss = α × CE_Loss(student, label)
          + β × KL_Div(student_logits / T, teacher_logits / T)
          + γ × Feature_Loss(student_feat, teacher_feat)
```

### 4.3 图结构优化

```python
import onnx
from onnxsim import simplify

model = onnx.load("seg_model.onnx")

# 常量折叠 + 冗余算子消除 + 算子融合
optimized_model, check = simplify(model)
assert check, "Simplified model validation failed"

onnx.save(optimized_model, "seg_model_optimized.onnx")
```

**常见图优化策略：**

| 优化手段 | 效果 | 说明 |
|---------|------|------|
| 常量折叠 | 减少运行时计算 | 预计算静态子图 |
| 算子融合 | 减少内核启动开销 | Conv+BN+ReLU → 单一算子 |
| 冗余消除 | 减小模型体积 | 移除 Identity、Dropout 等 |
| 形状推断 | 避免动态 shape 开销 | 固定中间 tensor 维度 |
| 通道剪枝 | 减少计算量 30-50% | 移除不重要的卷积通道 |

### 4.4 WebGPU 推理加速技巧

```typescript
// 1. 使用 FP16 存储减少带宽
const fp16Buffer = device.createBuffer({
    size: tensorSize * 2,  // FP16: 2 bytes per element
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: false,
});

// 2. 利用 Workgroup Shared Memory 减少全局内存访问
const optimizedConvShader = `
    var<workgroup> tile: array<array<f32, 18>, 18>;  // 16+2 padding for 3x3 conv

    @compute @workgroup_size(16, 16)
    fn conv3x3(...) {
        // 协作加载 tile 到共享内存
        tile[local_y + 1][local_x + 1] = input[global_idx];
        workgroupBarrier();

        // 从共享内存读取，避免重复全局内存访问
        var sum: f32 = 0.0;
        for (var ky = 0; ky < 3; ky++) {
            for (var kx = 0; kx < 3; kx++) {
                sum += tile[local_y + ky][local_x + kx] * kernel[ky * 3 + kx];
            }
        }
        output[global_idx] = sum;
    }
`;

// 3. 管线预热 —— 避免首次推理编译延迟
async function warmupPipeline(device: GPUDevice, pipeline: GPUComputePipeline) {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(1, 1, 1);  // 最小调度触发编译
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
}
```

---

## 5. 图像处理管线

### 5.1 完整管线架构

```
Camera/Video Frame
    │
    ▼
┌─────────────────────────────────────────────────────┐
│                  预处理阶段 (Pre-processing)          │
│  ┌──────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ 解码  │→│ Resize    │→│ Normalize │→│ NCHW   │  │
│  │      │  │ (双线性)  │  │ mean/std  │  │ 转换   │  │
│  └──────┘  └──────────┘  └──────────┘  └────────┘  │
└───────────────────────┬─────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────┐
│                  推理阶段 (Inference)                 │
│        输入: [1, 3, H, W] float32 / float16         │
│        输出: [1, C, H, W] logits                    │
└───────────────────────┬─────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────┐
│                  后处理阶段 (Post-processing)         │
│  ┌────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐  │
│  │ argmax │→│ Resize    │→│ 颜色映射  │→│ 蒙版  │  │
│  │        │  │ 回原尺寸  │  │ 类别着色  │  │ 合成  │  │
│  └────────┘  └──────────┘  └──────────┘  └──────┘  │
└───────────────────────┬─────────────────────────────┘
                        ▼
                Canvas / WebGL 渲染
```

### 5.2 高性能预处理实现

```typescript
class ImagePreprocessor {
    private offscreenCanvas: OffscreenCanvas;
    private ctx: OffscreenCanvasRenderingContext2D;
    private resizeCanvas: OffscreenCanvas;
    private resizeCtx: OffscreenCanvasRenderingContext2D;

    // 预分配 buffer，避免每帧 GC
    private rgbBuffer: Float32Array;
    private inputWidth: number;
    private inputHeight: number;

    constructor(inputWidth: number, inputHeight: number) {
        this.inputWidth = inputWidth;
        this.inputHeight = inputHeight;
        this.offscreenCanvas = new OffscreenCanvas(inputWidth, inputHeight);
        this.ctx = this.offscreenCanvas.getContext('2d')!;
        this.resizeCanvas = new OffscreenCanvas(inputWidth, inputHeight);
        this.resizeCtx = this.resizeCanvas.getContext('2d')!;

        // 预分配: 3 通道 × H × W
        this.rgbBuffer = new Float32Array(3 * inputWidth * inputHeight);
    }

    /**
     * 将 VideoFrame / ImageBitmap 转换为模型输入 Tensor
     * 布局: [1, 3, H, W]，归一化到 [0, 1] 并做 ImageNet 标准化
     */
    preprocess(source: VideoFrame | ImageBitmap): Float32Array {
        // 1. Resize 到模型输入尺寸
        this.resizeCtx.drawImage(source, 0, 0, this.inputWidth, this.inputHeight);
        const imageData = this.resizeCtx.getImageData(
            0, 0, this.inputWidth, this.inputHeight
        );
        const pixels = imageData.data;  // RGBA Uint8ClampedArray

        // 2. RGBA → RGB + Normalize + NHWC → NCHW 转换（单次遍历）
        const mean = [0.485, 0.456, 0.406];
        const std = [0.229, 0.224, 0.225];
        const hw = this.inputWidth * this.inputHeight;

        for (let i = 0; i < hw; i++) {
            const rgbaIdx = i * 4;
            // NCHW 布局: R 通道连续存储，再 G 通道，再 B 通道
            this.rgbBuffer[i]          = (pixels[rgbaIdx]     / 255 - mean[0]) / std[0]; // R
            this.rgbBuffer[hw + i]     = (pixels[rgbaIdx + 1] / 255 - mean[1]) / std[1]; // G
            this.rgbBuffer[2 * hw + i] = (pixels[rgbaIdx + 2] / 255 - mean[2]) / std[2]; // B
        }

        return this.rgbBuffer;
    }
}
```

### 5.3 WebGPU 零拷贝预处理

```typescript
/**
 * GPU 端预处理：避免 CPU-GPU 数据往返
 * VideoFrame → GPU Texture → Compute Shader (Resize + Normalize + NCHW) → 推理输入
 */
class GPUPreprocessor {
    private device: GPUDevice;
    private pipeline: GPUComputePipeline;
    private outputBuffer: GPUBuffer;

    async preprocessOnGPU(frame: VideoFrame): Promise<GPUBuffer> {
        // 1. 直接从 VideoFrame 导入 GPU 纹理（零拷贝）
        const texture = this.device.importExternalTexture({
            source: frame as any,
        });

        // 2. Compute Shader 执行预处理
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.createBindGroup(texture, this.outputBuffer));
        pass.dispatchWorkgroups(
            Math.ceil(this.width / 16),
            Math.ceil(this.height / 16)
        );
        pass.end();

        this.device.queue.submit([encoder.finish()]);
        return this.outputBuffer;  // 数据始终在 GPU 上，不回读 CPU
    }
}
```

### 5.4 后处理与蒙版渲染

```typescript
class MaskRenderer {
    private canvas: HTMLCanvasElement;
    private gl: WebGL2RenderingContext;

    /**
     * 将分割蒙版与原图合成
     * 支持：背景替换、背景模糊、语义着色
     */
    renderComposite(
        originalFrame: VideoFrame,
        segMask: Uint8Array,       // [H, W] 类别索引
        mode: 'replace' | 'blur' | 'colorize'
    ) {
        // 使用 WebGL 片段着色器高效合成
        const fragmentShader = `
            precision highp float;
            uniform sampler2D u_original;
            uniform sampler2D u_mask;
            uniform sampler2D u_background;
            uniform int u_mode;
            varying vec2 v_texCoord;

            void main() {
                vec4 original = texture2D(u_original, v_texCoord);
                float mask = texture2D(u_mask, v_texCoord).r;
                float classId = mask * 255.0;

                if (u_mode == 0) {
                    // 背景替换：前景保留，背景用替换图
                    vec4 bg = texture2D(u_background, v_texCoord);
                    gl_FragColor = classId > 0.5 ? original : bg;
                } else if (u_mode == 1) {
                    // 背景模糊：用 mask 做 alpha 混合
                    // 模糊纹理已预处理（降采样再升采样）
                    vec4 blurred = texture2D(u_background, v_texCoord);
                    float alpha = smoothstep(0.4, 0.6, mask);
                    gl_FragColor = mix(blurred, original, alpha);
                }
            }
        `;
    }

    /**
     * 蒙版边缘平滑（消除锯齿）
     */
    smoothMaskEdges(mask: Uint8Array, width: number, height: number): Float32Array {
        const smoothed = new Float32Array(width * height);

        // 3×3 高斯模糊蒙版边缘
        const kernel = [1/16, 2/16, 1/16, 2/16, 4/16, 2/16, 1/16, 2/16, 1/16];

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                let sum = 0;
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const idx = (y + ky) * width + (x + kx);
                        const ki = (ky + 1) * 3 + (kx + 1);
                        sum += (mask[idx] > 0 ? 1.0 : 0.0) * kernel[ki];
                    }
                }
                smoothed[y * width + x] = sum;
            }
        }
        return smoothed;
    }
}
```

---

## 6. 推理调度架构

### 6.1 Web Worker 隔离推理

```
┌─────────────┐         ┌──────────────────────┐
│  主线程      │         │  推理 Worker          │
│             │         │                      │
│  UI 渲染    │ ──帧──→ │  预处理               │
│  事件处理   │         │  ↓                    │
│  帧率监控   │ ←结果── │  模型推理              │
│             │         │  ↓                    │
│  合成渲染   │         │  后处理               │
└─────────────┘         └──────────────────────┘
      ↑                          ↑
      │                          │
  不阻塞 UI                   独立线程池
  保持 60fps                  异步推理
```

```typescript
// inference.worker.ts
import * as ort from 'onnxruntime-web';

let session: ort.InferenceSession;
let preprocessor: ImagePreprocessor;

self.onmessage = async (e: MessageEvent) => {
    const { type, payload } = e.data;

    switch (type) {
        case 'init': {
            session = await ort.InferenceSession.create(payload.modelUrl, {
                executionProviders: ['webgpu', 'wasm'],
            });
            preprocessor = new ImagePreprocessor(payload.width, payload.height);
            self.postMessage({ type: 'ready' });
            break;
        }
        case 'infer': {
            const { imageData, width, height, frameId } = payload;
            const start = performance.now();

            // 预处理
            const input = preprocessor.preprocess(imageData);

            // 推理
            const tensor = new ort.Tensor('float32', input, [1, 3, height, width]);
            const results = await session.run({ image: tensor });

            // 后处理 (argmax)
            const mask = postprocessMask(results.mask);

            const elapsed = performance.now() - start;

            // Transferable 传输避免拷贝
            self.postMessage(
                { type: 'result', frameId, mask: mask.buffer, elapsed },
                [mask.buffer]  // Transfer ownership
            );
            break;
        }
    }
};
```

### 6.2 帧调度策略

```typescript
class InferenceScheduler {
    private worker: Worker;
    private pendingFrame: VideoFrame | null = null;
    private isProcessing = false;
    private frameId = 0;
    private lastResult: Uint8Array | null = null;

    // 策略 1: 丢帧调度 —— 始终处理最新帧
    scheduleFrame(frame: VideoFrame) {
        this.pendingFrame?.close();       // 释放旧的待处理帧
        this.pendingFrame = frame;

        if (!this.isProcessing) {
            this.processNextFrame();
        }
        // 如果正在处理，新帧会在当前推理完成后被处理
    }

    private async processNextFrame() {
        if (!this.pendingFrame) return;

        this.isProcessing = true;
        const frame = this.pendingFrame;
        this.pendingFrame = null;

        const id = ++this.frameId;
        this.worker.postMessage(
            { type: 'infer', imageData: frame, frameId: id },
            [frame]  // Transfer VideoFrame
        );
    }

    // 策略 2: 自适应帧率 —— 根据推理耗时动态调整
    private targetFps = 30;
    private inferenceTime = 30;  // 滑动平均

    adaptFrameRate(elapsed: number) {
        // EMA 平滑推理时间
        this.inferenceTime = 0.7 * this.inferenceTime + 0.3 * elapsed;

        // 推理帧率 = 1000 / 推理时间，但不超过目标帧率
        const achievableFps = 1000 / this.inferenceTime;
        const actualFps = Math.min(achievableFps, this.targetFps);

        // 动态降低采样率
        if (actualFps < 15) {
            this.setInputResolution(256, 256);   // 降分辨率保帧率
        } else if (actualFps < 24) {
            this.setInputResolution(384, 384);
        } else {
            this.setInputResolution(512, 512);
        }
    }

    // 策略 3: 帧插值 —— 非推理帧复用上次结果
    renderFrame(currentFrame: VideoFrame) {
        if (this.lastResult) {
            // 推理帧：用新蒙版
            // 非推理帧：复用上次蒙版 + 光流补偿（可选）
            this.renderer.composite(currentFrame, this.lastResult);
        } else {
            // 无蒙版时渲染原始帧
            this.renderer.drawOriginal(currentFrame);
        }
    }

    private setInputResolution(_w: number, _h: number) { /* ... */ }
}
```

### 6.3 多 Worker 流水线并行

```
帧 N:    [预处理 W1] ──→ [推理 W2] ──→ [后处理 W3] ──→ 渲染
帧 N+1:              [预处理 W1] ──→ [推理 W2] ──→ [后处理 W3] ──→ 渲染
帧 N+2:                           [预处理 W1] ──→ [推理 W2] ──→ ...

吞吐量 = max(预处理时间, 推理时间, 后处理时间) 的倒数
典型: max(3ms, 25ms, 5ms) → ~40 FPS 吞吐
```

```typescript
class PipelineScheduler {
    private preprocessWorker: Worker;
    private inferenceWorker: Worker;
    private postprocessWorker: Worker;
    private pipelineQueue: Map<number, PipelineStage> = new Map();

    async processPipeline(frame: VideoFrame, frameId: number) {
        // 阶段 1: 预处理 Worker
        const preprocessed = await this.sendToWorker(
            this.preprocessWorker, 'preprocess', frame
        );

        // 阶段 2: 推理 Worker（与下一帧的预处理并行）
        const inferenceResult = await this.sendToWorker(
            this.inferenceWorker, 'infer', preprocessed
        );

        // 阶段 3: 后处理 Worker（与下一帧的推理并行）
        const mask = await this.sendToWorker(
            this.postprocessWorker, 'postprocess', inferenceResult
        );

        return mask;
    }

    private sendToWorker(worker: Worker, type: string, data: any): Promise<any> {
        return new Promise(resolve => {
            const handler = (e: MessageEvent) => {
                worker.removeEventListener('message', handler);
                resolve(e.data.result);
            };
            worker.addEventListener('message', handler);
            worker.postMessage({ type, data }, [data.buffer || data]);
        });
    }
}
```

---

## 7. 模型工程优化

### 7.1 模型加载优化

```typescript
class ModelLoader {
    /**
     * 分片加载：将大模型拆分为多个小文件并行下载
     * 优势：利用 HTTP/2 多路复用，避免单文件下载超时
     */
    async loadSharded(shardUrls: string[]): Promise<ArrayBuffer> {
        const shards = await Promise.all(
            shardUrls.map(url => this.fetchWithProgress(url))
        );

        // 合并分片
        const totalSize = shards.reduce((s, b) => s + b.byteLength, 0);
        const merged = new ArrayBuffer(totalSize);
        const view = new Uint8Array(merged);
        let offset = 0;
        for (const shard of shards) {
            view.set(new Uint8Array(shard), offset);
            offset += shard.byteLength;
        }
        return merged;
    }

    /**
     * IndexedDB 缓存 + 版本校验
     */
    async loadWithCache(
        modelUrl: string,
        modelVersion: string
    ): Promise<ArrayBuffer> {
        const cacheKey = `model_${modelVersion}`;
        const db = await this.openDB();

        // 1. 检查缓存
        const cached = await this.getFromDB(db, cacheKey);
        if (cached) {
            console.log(`Model loaded from cache (${(cached.byteLength / 1e6).toFixed(1)} MB)`);
            return cached;
        }

        // 2. 下载并缓存
        const buffer = await this.fetchWithProgress(modelUrl);
        await this.saveToDB(db, cacheKey, buffer);

        // 3. 清理旧版本缓存
        await this.cleanOldVersions(db, modelVersion);

        return buffer;
    }

    /**
     * 流式加载 + 进度反馈
     */
    private async fetchWithProgress(url: string): Promise<ArrayBuffer> {
        const response = await fetch(url);
        const contentLength = Number(response.headers.get('Content-Length')) || 0;
        const reader = response.body!.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            this.onProgress?.(loaded / contentLength);
        }

        // 合并 chunks
        const result = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result.buffer;
    }

    private onProgress?: (ratio: number) => void;

    private async openDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('ModelCache', 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore('models');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    private async getFromDB(db: IDBDatabase, key: string): Promise<ArrayBuffer | null> {
        return new Promise((resolve) => {
            const tx = db.transaction('models', 'readonly');
            const req = tx.objectStore('models').get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    }

    private async saveToDB(db: IDBDatabase, key: string, data: ArrayBuffer): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('models', 'readwrite');
            tx.objectStore('models').put(data, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    private async cleanOldVersions(db: IDBDatabase, currentVersion: string): Promise<void> {
        const tx = db.transaction('models', 'readwrite');
        const store = tx.objectStore('models');
        const req = store.getAllKeys();
        req.onsuccess = () => {
            for (const key of req.result) {
                if (typeof key === 'string' && !key.includes(currentVersion)) {
                    store.delete(key);
                }
            }
        };
    }
}
```

### 7.2 模型预热与会话管理

```typescript
class SessionManager {
    private sessions: Map<string, ort.InferenceSession> = new Map();
    private warmupComplete = false;

    /**
     * 预热策略：应用启动时即加载模型并执行一次空推理
     * 目的：
     * 1. 触发 WASM 编译（首次调用会有 100-500ms 编译延迟）
     * 2. 触发 WebGPU Shader 编译
     * 3. 预分配 GPU Buffer
     */
    async warmup(modelUrl: string, inputShape: number[]) {
        const session = await this.getOrCreateSession(modelUrl);

        // 空推理触发编译
        const dummyInput = new Float32Array(inputShape.reduce((a, b) => a * b));
        const tensor = new ort.Tensor('float32', dummyInput, inputShape);
        await session.run({ image: tensor });

        this.warmupComplete = true;
    }

    /**
     * 多模型管理：按场景切换（人像分割 / 通用分割 / 实例分割）
     */
    async getOrCreateSession(modelUrl: string): Promise<ort.InferenceSession> {
        if (!this.sessions.has(modelUrl)) {
            const session = await ort.InferenceSession.create(modelUrl, {
                executionProviders: ['webgpu', 'wasm'],
                graphOptimizationLevel: 'all',
            });
            this.sessions.set(modelUrl, session);
        }
        return this.sessions.get(modelUrl)!;
    }

    /**
     * LRU 淘汰：内存压力时释放最久未用的模型
     */
    evictLRU(maxSessions: number = 2) {
        if (this.sessions.size <= maxSessions) return;

        // 按最后使用时间排序，释放最旧的
        const oldest = [...this.sessions.entries()][0];
        oldest[1].release();
        this.sessions.delete(oldest[0]);
    }
}
```

### 7.3 渐进式模型加载

```
用户体验优化的分级加载策略：

阶段 1: 即时响应（0-500ms）
  └─ 加载极轻量模型（< 1MB），如 MediaPipe Selfie
  └─ 提供基础分割能力，帧率 > 30fps

阶段 2: 质量提升（500ms-3s）
  └─ 后台加载中等模型（5-10MB），如 MobileNetV3
  └─ 无缝切换，分割质量明显提升

阶段 3: 高质量（可选）
  └─ WiFi 环境下加载高精度模型（20-50MB）
  └─ 用户确认后激活

代码示例：
```

```typescript
class ProgressiveLoader {
    private currentTier: 'lite' | 'standard' | 'premium' = 'lite';

    async loadProgressive(onTierReady: (tier: string) => void) {
        // Tier 1: 立即可用
        await this.loadModel('/models/selfie_lite_256.onnx');
        this.currentTier = 'lite';
        onTierReady('lite');

        // Tier 2: 后台加载
        const standardPromise = this.loadModel('/models/deeplabv3_mobilenet_512.onnx');

        // 判断网络条件
        const connection = (navigator as any).connection;
        const isHighBandwidth = !connection || connection.downlink > 5;

        const standardModel = await standardPromise;
        this.currentTier = 'standard';
        onTierReady('standard');

        // Tier 3: 仅在高带宽 + 高性能设备
        if (isHighBandwidth && navigator.hardwareConcurrency >= 8) {
            await this.loadModel('/models/segformer_b2_512.onnx');
            this.currentTier = 'premium';
            onTierReady('premium');
        }
    }

    private async loadModel(url: string) { /* ... */ }
}
```

---

## 8. 推理性能优化

### 8.1 内存复用与零拷贝

```typescript
class MemoryPool {
    private pool: Map<string, Float32Array[]> = new Map();

    /**
     * 对象池：避免每帧分配 Tensor Buffer
     * 语义分割 512×512 模型：
     *   输入: 3 × 512 × 512 × 4 bytes = 3MB
     *   输出: 21 × 512 × 512 × 4 bytes = 21MB
     * 每帧分配 24MB 会导致频繁 GC
     */
    acquire(key: string, size: number): Float32Array {
        const available = this.pool.get(key);
        if (available && available.length > 0) {
            return available.pop()!;
        }
        return new Float32Array(size);
    }

    release(key: string, buffer: Float32Array) {
        if (!this.pool.has(key)) {
            this.pool.set(key, []);
        }
        const arr = this.pool.get(key)!;
        if (arr.length < 3) {  // 最多缓存 3 个同 key buffer
            arr.push(buffer);
        }
    }

    clear() {
        this.pool.clear();
    }
}

// 使用示例
const pool = new MemoryPool();

function processFrame(frame: ImageData) {
    const inputBuffer = pool.acquire('input', 3 * 512 * 512);
    const outputBuffer = pool.acquire('output', 21 * 512 * 512);

    try {
        preprocess(frame, inputBuffer);
        infer(inputBuffer, outputBuffer);
        return postprocess(outputBuffer);
    } finally {
        pool.release('input', inputBuffer);
        pool.release('output', outputBuffer);
    }
}
```

### 8.2 Transferable Objects 数据传输

```typescript
// 主线程与 Worker 间传输大型 ArrayBuffer
// 关键：使用 Transferable 转移所有权而非拷贝

// ❌ 拷贝传输（512×512 RGBA = 1MB，逐帧拷贝开销大）
worker.postMessage({ imageData: pixels });

// ✅ 零拷贝传输（转移 ArrayBuffer 所有权）
worker.postMessage(
    { imageData: pixels.buffer },
    [pixels.buffer]  // Transferable list
);
// 注意：传输后主线程不能再访问 pixels.buffer

// ✅ SharedArrayBuffer（多 Worker 共享，需 COOP/COEP 头）
const shared = new SharedArrayBuffer(3 * 512 * 512 * 4);
const inputView = new Float32Array(shared);
// 无需传输，多个 Worker 直接读写（需 Atomics 同步）
```

### 8.3 性能监控与自适应

```typescript
class PerformanceMonitor {
    private metrics: {
        preprocessMs: number[];
        inferenceMs: number[];
        postprocessMs: number[];
        totalMs: number[];
        fps: number;
    } = { preprocessMs: [], inferenceMs: [], postprocessMs: [], totalMs: [], fps: 0 };

    private frameCount = 0;
    private lastFpsTime = performance.now();

    record(stage: 'preprocess' | 'inference' | 'postprocess', elapsed: number) {
        const arr = this.metrics[`${stage}Ms`];
        arr.push(elapsed);
        if (arr.length > 60) arr.shift();  // 保留最近 60 帧
    }

    tick() {
        this.frameCount++;
        const now = performance.now();
        const delta = now - this.lastFpsTime;
        if (delta >= 1000) {
            this.metrics.fps = (this.frameCount / delta) * 1000;
            this.frameCount = 0;
            this.lastFpsTime = now;
        }
    }

    getReport() {
        const avg = (arr: number[]) =>
            arr.length ? arr.reduce((a, b) => a + b) / arr.length : 0;
        const p95 = (arr: number[]) => {
            if (!arr.length) return 0;
            const sorted = [...arr].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length * 0.95)];
        };

        return {
            fps: this.metrics.fps.toFixed(1),
            preprocess: { avg: avg(this.metrics.preprocessMs).toFixed(1), p95: p95(this.metrics.preprocessMs).toFixed(1) },
            inference: { avg: avg(this.metrics.inferenceMs).toFixed(1), p95: p95(this.metrics.inferenceMs).toFixed(1) },
            postprocess: { avg: avg(this.metrics.postprocessMs).toFixed(1), p95: p95(this.metrics.postprocessMs).toFixed(1) },
        };
    }

    /**
     * 自适应质量降级
     */
    shouldDowngrade(): boolean {
        const avgInference = this.metrics.inferenceMs.slice(-10)
            .reduce((a, b) => a + b, 0) / 10;
        return this.metrics.fps < 20 || avgInference > 50;
    }

    shouldUpgrade(): boolean {
        const avgInference = this.metrics.inferenceMs.slice(-30)
            .reduce((a, b) => a + b, 0) / 30;
        return this.metrics.fps > 28 && avgInference < 20;
    }
}
```

### 8.4 性能优化对比

| 优化手段 | 优化前 | 优化后 | 提升 |
|---------|--------|-------|------|
| WASM → WebGPU 后端 | 80ms | 25ms | 3.2× |
| FP32 → INT8 量化 | 25ms | 12ms | 2.1× |
| 逐帧分配 → 内存池 | GC 频繁卡顿 | 无 GC 暂停 | 帧率稳定 |
| 拷贝传输 → Transferable | 3ms/帧传输 | ~0ms | 消除传输开销 |
| 同步推理 → Worker 隔离 | UI 卡顿 | UI 始终 60fps | UX 质变 |
| 固定分辨率 → 自适应降级 | 低端设备 10fps | 低端设备 25fps | 2.5× |
| 首次冷启动 → 模型预热 | 首帧 800ms | 首帧 30ms | 26× |

---

## 9. 浏览器内存管理

### 9.1 内存布局与限制

```
浏览器标签页内存空间（典型 Chrome）：

┌──────────────────────────────────────────┐
│           V8 Heap (~2-4 GB)              │
│  ┌────────────────────────────────────┐  │
│  │ JS Objects, Closures, DOM Nodes   │  │
│  │ GC 管理，不可预测的暂停            │  │
│  └────────────────────────────────────┘  │
├──────────────────────────────────────────┤
│        ArrayBuffer / WASM Memory          │
│  ┌────────────────────────────────────┐  │
│  │ TypedArrays, WASM Linear Memory   │  │
│  │ 手动管理，直接内存访问             │  │
│  │ WASM 上限: ~4GB (32-bit)          │  │
│  └────────────────────────────────────┘  │
├──────────────────────────────────────────┤
│            GPU Memory                     │
│  ┌────────────────────────────────────┐  │
│  │ WebGPU Buffers, Textures          │  │
│  │ 设备内存，需手动 destroy()         │  │
│  │ 共享系统显存                       │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘

语义分割应用典型内存占用：
  模型权重:         5-50 MB (ArrayBuffer)
  输入 Tensor:      3 MB (512×512×3×4)
  输出 Tensor:      21 MB (512×512×21×4)
  中间激活:         50-200 MB (推理过程)
  蒙版/渲染缓冲:   1-4 MB
  ──────────────────────────────
  总计:             80-280 MB
```

### 9.2 内存泄漏防护

```typescript
class MemoryGuard {
    private resources: Set<{ destroy: () => void }> = new Set();
    private tensorRegistry = new FinalizationRegistry<string>((id) => {
        console.warn(`Tensor ${id} was GC'd without explicit release — potential leak`);
    });

    /**
     * 注册需手动释放的资源
     */
    track<T extends { destroy(): void }>(resource: T, debugId?: string): T {
        this.resources.add(resource);
        if (debugId) {
            this.tensorRegistry.register(resource, debugId);
        }
        return resource;
    }

    /**
     * 释放单个资源
     */
    release(resource: { destroy: () => void }) {
        resource.destroy();
        this.resources.delete(resource);
    }

    /**
     * 释放所有追踪资源
     */
    disposeAll() {
        for (const resource of this.resources) {
            try { resource.destroy(); } catch {}
        }
        this.resources.clear();
    }

    /**
     * 内存水位监控
     */
    async checkMemoryPressure(): Promise<'normal' | 'warning' | 'critical'> {
        if ('memory' in performance) {
            const mem = (performance as any).memory;
            const usedRatio = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
            if (usedRatio > 0.9) return 'critical';
            if (usedRatio > 0.7) return 'warning';
        }

        // 使用 Storage Manager API 估算可用空间
        if (navigator.storage?.estimate) {
            const estimate = await navigator.storage.estimate();
            const usedRatio = (estimate.usage || 0) / (estimate.quota || 1);
            if (usedRatio > 0.85) return 'warning';
        }

        return 'normal';
    }
}
```

### 9.3 GC 友好的数据结构

```typescript
/**
 * 避免 GC 风暴的关键原则：
 *
 * 1. 预分配，不逐帧 new
 * 2. 用 TypedArray 而非普通 Array
 * 3. 用对象池复用 buffer
 * 4. 避免闭包捕获大对象
 */

// ❌ GC 不友好：每帧创建新对象
function processFrameBad(pixels: Uint8ClampedArray) {
    const result = new Float32Array(pixels.length / 4 * 3);  // 每帧 new
    const mask = new Uint8Array(pixels.length / 4);            // 每帧 new
    // ... 处理后 result 和 mask 变成垃圾
    return { result, mask };
}

// ✅ GC 友好：复用预分配 buffer
class FrameProcessor {
    private resultBuffer: Float32Array;
    private maskBuffer: Uint8Array;

    constructor(width: number, height: number) {
        this.resultBuffer = new Float32Array(width * height * 3);
        this.maskBuffer = new Uint8Array(width * height);
    }

    processFrame(pixels: Uint8ClampedArray): { result: Float32Array; mask: Uint8Array } {
        // 就地写入预分配 buffer，零分配
        // ...
        return { result: this.resultBuffer, mask: this.maskBuffer };
    }
}
```

### 9.4 GPU 内存管理

```typescript
class GPUMemoryManager {
    private device: GPUDevice;
    private bufferPool: Map<number, GPUBuffer[]> = new Map();
    private totalAllocated = 0;
    private maxBudget = 512 * 1024 * 1024;  // 512MB GPU 内存预算

    /**
     * GPU Buffer 池化复用
     */
    acquireBuffer(size: number, usage: GPUBufferUsageFlags): GPUBuffer {
        // 向上对齐到 256 字节（WebGPU 对齐要求）
        const alignedSize = Math.ceil(size / 256) * 256;
        const key = alignedSize;

        const pool = this.bufferPool.get(key);
        if (pool && pool.length > 0) {
            return pool.pop()!;
        }

        // 检查内存预算
        if (this.totalAllocated + alignedSize > this.maxBudget) {
            this.evictBuffers(alignedSize);
        }

        const buffer = this.device.createBuffer({ size: alignedSize, usage });
        this.totalAllocated += alignedSize;
        return buffer;
    }

    releaseBuffer(buffer: GPUBuffer, size: number) {
        const alignedSize = Math.ceil(size / 256) * 256;
        const pool = this.bufferPool.get(alignedSize) || [];
        if (pool.length < 4) {
            pool.push(buffer);
            this.bufferPool.set(alignedSize, pool);
        } else {
            buffer.destroy();
            this.totalAllocated -= alignedSize;
        }
    }

    private evictBuffers(needed: number) {
        for (const [size, pool] of this.bufferPool) {
            while (pool.length > 0 && this.totalAllocated + needed > this.maxBudget) {
                const buf = pool.pop()!;
                buf.destroy();
                this.totalAllocated -= size;
            }
        }
    }

    /**
     * 设备丢失恢复
     */
    async handleDeviceLost() {
        this.device.lost.then(async (info) => {
            console.error(`GPU device lost: ${info.message}`);

            if (info.reason === 'destroyed') return;

            // 重新请求设备
            const adapter = await navigator.gpu.requestAdapter();
            this.device = await adapter!.requestDevice();

            // 清空池并重建资源
            this.bufferPool.clear();
            this.totalAllocated = 0;

            // 通知上层重建推理会话
            this.onDeviceRestored?.(this.device);
        });
    }

    onDeviceRestored?: (device: GPUDevice) => void;
}
```

### 9.5 OOM 防护策略

```typescript
class OOMProtection {
    /**
     * 安全的模型加载：检查可用内存后再加载
     */
    async safeLoadModel(modelUrl: string, modelSize: number): Promise<ArrayBuffer | null> {
        // 1. 预估检查
        if ('memory' in performance) {
            const mem = (performance as any).memory;
            const available = mem.jsHeapSizeLimit - mem.usedJSHeapSize;
            if (modelSize * 2.5 > available) {  // 2.5× 安全余量（加载+解析+推理）
                console.warn('Insufficient memory for model, trying smaller variant');
                return null;
            }
        }

        // 2. 分块加载，随时可中止
        const controller = new AbortController();
        try {
            const response = await fetch(modelUrl, { signal: controller.signal });
            return await response.arrayBuffer();
        } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') {
                return null;
            }
            throw e;
        }
    }

    /**
     * 内存压力响应：监听浏览器内存压力事件
     */
    setupPressureObserver(onPressure: (level: string) => void) {
        if ('PressureObserver' in globalThis) {
            const observer = new (globalThis as any).PressureObserver(
                (records: any[]) => {
                    const latest = records[records.length - 1];
                    // state: 'nominal' | 'fair' | 'serious' | 'critical'
                    onPressure(latest.state);
                },
                { sampleInterval: 1000 }
            );
            observer.observe('cpu');
            return observer;
        }
        return null;
    }

    /**
     * 降级策略
     */
    degrade(level: 'fair' | 'serious' | 'critical') {
        switch (level) {
            case 'fair':
                // 降低推理分辨率
                this.setResolution(384, 384);
                break;
            case 'serious':
                // 切换到最小模型 + 降低帧率
                this.switchToLiteModel();
                this.setTargetFps(15);
                break;
            case 'critical':
                // 停止推理，释放模型
                this.stopInference();
                this.releaseAllModels();
                break;
        }
    }

    private setResolution(_w: number, _h: number) { /* ... */ }
    private switchToLiteModel() { /* ... */ }
    private setTargetFps(_fps: number) { /* ... */ }
    private stopInference() { /* ... */ }
    private releaseAllModels() { /* ... */ }
}
```

---

## 10. 端到端架构实战

### 10.1 视频会议背景分割完整架构

```
┌─────────────────────────────────────────────────────────────┐
│                    React 应用层                              │
│                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Camera   │  │ SegEngine    │  │ CompositeRenderer    │  │
│  │ Provider │→│ (Hook)       │→│ (Canvas/WebGL)       │  │
│  └──────────┘  └──────┬───────┘  └──────────────────────┘  │
│                       │                                      │
├───────────────────────┼──────────────────────────────────────┤
│                       ▼                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              推理调度器 (主线程)                         │  │
│  │  - 帧采样（丢帧策略）                                    │  │
│  │  - 结果缓存（非推理帧复用蒙版）                           │  │
│  │  - 性能监控 & 自适应降级                                  │  │
│  └────────────────────┬───────────────────────────────────┘  │
│                       │ Transferable / SharedArrayBuffer      │
│                       ▼                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              推理 Worker                                │  │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐ │  │
│  │  │ 预处理   │→│ ORT WebGPU  │→│ 后处理 (argmax)  │ │  │
│  │  │ Resize   │  │ 推理引擎    │  │ + 边缘平滑       │ │  │
│  │  │ Normalize│  │             │  │                  │ │  │
│  │  └──────────┘  └──────────────┘  └──────────────────┘ │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  持久层: IndexedDB (模型缓存) │ Cache API (资源缓存)         │
└─────────────────────────────────────────────────────────────┘
```

### 10.2 React Hook 封装

```typescript
interface UseSegmentationOptions {
    modelUrl: string;
    modelVersion: string;
    inputSize?: [number, number];
    targetFps?: number;
    autoDegrade?: boolean;
}

interface SegmentationResult {
    mask: Uint8Array | null;
    fps: number;
    inferenceMs: number;
    modelTier: 'lite' | 'standard' | 'premium';
    isReady: boolean;
}

function useSegmentation(
    videoRef: React.RefObject<HTMLVideoElement>,
    options: UseSegmentationOptions
): SegmentationResult {
    const [result, setResult] = useState<SegmentationResult>({
        mask: null, fps: 0, inferenceMs: 0, modelTier: 'lite', isReady: false,
    });

    const workerRef = useRef<Worker | null>(null);
    const rafRef = useRef<number>(0);
    const schedulerRef = useRef<InferenceScheduler | null>(null);

    useEffect(() => {
        const worker = new Worker(
            new URL('./inference.worker.ts', import.meta.url),
            { type: 'module' }
        );
        workerRef.current = worker;

        // 初始化
        worker.postMessage({
            type: 'init',
            payload: {
                modelUrl: options.modelUrl,
                modelVersion: options.modelVersion,
                width: options.inputSize?.[0] ?? 512,
                height: options.inputSize?.[1] ?? 512,
            }
        });

        worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                setResult(r => ({ ...r, isReady: true }));
                startLoop();
            }
            if (e.data.type === 'result') {
                const mask = new Uint8Array(e.data.mask);
                setResult(r => ({
                    ...r,
                    mask,
                    inferenceMs: e.data.elapsed,
                }));
            }
        };

        function startLoop() {
            const video = videoRef.current;
            if (!video) return;

            let lastTime = 0;
            const interval = 1000 / (options.targetFps ?? 30);

            const loop = (timestamp: number) => {
                if (timestamp - lastTime >= interval) {
                    lastTime = timestamp;

                    // 从视频帧创建 ImageBitmap 并发送到 Worker
                    createImageBitmap(video).then(bitmap => {
                        worker.postMessage(
                            { type: 'infer', imageData: bitmap, frameId: Date.now() },
                            [bitmap]
                        );
                    });
                }
                rafRef.current = requestAnimationFrame(loop);
            };
            rafRef.current = requestAnimationFrame(loop);
        }

        return () => {
            cancelAnimationFrame(rafRef.current);
            worker.terminate();
        };
    }, [options.modelUrl]);

    return result;
}
```

### 10.3 关键性能指标

| 指标 | 目标值 | 测量方式 |
|------|--------|---------|
| 首帧延迟 | < 1s | 模型加载 + 预热 + 首次推理 |
| 推理帧率 | ≥ 24fps | 每秒完成的推理次数 |
| UI 帧率 | 稳定 60fps | 主线程不被推理阻塞 |
| 内存峰值 | < 300MB | 模型 + Tensor + 渲染缓冲 |
| P95 推理延迟 | < 50ms | 第 95 百分位推理耗时 |
| 模型加载（缓存命中）| < 200ms | IndexedDB 读取 + Session 创建 |
| 模型加载（冷启动）| < 5s | 网络下载 + 缓存 + Session 创建 |
| GC 暂停 | < 5ms/次 | Chrome DevTools Performance |

### 10.4 兼容性降级矩阵

```
设备能力检测 → 选择最优方案：

┌─────────────────────┬──────────────────┬────────────┬────────────┐
│ 设备能力             │ 推理后端         │ 模型选择    │ 目标帧率   │
├─────────────────────┼──────────────────┼────────────┼────────────┤
│ WebGPU + dGPU        │ WebGPU           │ SegFormer  │ 30fps      │
│ WebGPU + iGPU        │ WebGPU           │ DeepLabV3  │ 24fps      │
│ WebGL 2 + GPU        │ WebGL            │ MobileNet  │ 20fps      │
│ WASM SIMD + 多核     │ WASM (多线程)     │ Lite 模型  │ 15fps      │
│ WASM 基础            │ WASM (单线程)     │ MediaPipe  │ 10fps      │
│ 不支持               │ 回退云端 API      │ -          │ 按网络     │
└─────────────────────┴──────────────────┴────────────┴────────────┘
```

```typescript
async function detectCapabilities(): Promise<RuntimeConfig> {
    // 1. WebGPU 检测
    if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
            const info = await adapter.requestAdapterInfo();
            const isDedicatedGPU = !info.description?.toLowerCase().includes('intel');
            return {
                backend: 'webgpu',
                model: isDedicatedGPU ? 'segformer_b2' : 'deeplabv3_mobilenet',
                targetFps: isDedicatedGPU ? 30 : 24,
                inputSize: isDedicatedGPU ? [512, 512] : [384, 384],
            };
        }
    }

    // 2. WebGL 检测
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
        return {
            backend: 'webgl',
            model: 'mobilenet_v3_lite',
            targetFps: 20,
            inputSize: [256, 256],
        };
    }

    // 3. WASM 检测
    const hasSIMD = WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
    ]));

    return {
        backend: 'wasm',
        model: hasSIMD ? 'mediapipe_selfie' : 'tiny_seg',
        targetFps: hasSIMD ? 15 : 10,
        inputSize: [256, 256],
    };
}

interface RuntimeConfig {
    backend: 'webgpu' | 'webgl' | 'wasm';
    model: string;
    targetFps: number;
    inputSize: [number, number];
}
```

---

## 面试高频问题

### Q1: 端侧语义分割与云端方案相比，核心技术差异在哪里？

**模型层面：** 端侧必须用轻量模型（< 50MB），通过量化（INT8/INT4）、知识蒸馏、通道剪枝大幅压缩。云端可用 SegFormer-B5 等大模型。

**推理层面：** 端侧依赖 WebGPU/WASM 后端，需要关注 Shader 编译延迟、GPU Buffer 对齐、WASM SIMD 利用率。云端用 CUDA/TensorRT，优化空间大得多。

**工程层面：** 端侧面临浏览器内存限制（~4GB）、GC 暂停、GPU 设备丢失等浏览器特有问题。需要内存池、Transferable 传输、Worker 隔离、自适应降级等策略。

### Q2: 如何保证推理不阻塞 UI？

三层策略：
1. **Worker 隔离**：推理运行在 Web Worker 中，主线程仅负责 UI 渲染和帧调度
2. **丢帧策略**：推理未完成时丢弃中间帧，只处理最新帧，避免帧积压
3. **结果复用**：非推理帧复用上一次蒙版结果，实现视觉上的"伪实时"

### Q3: WebGPU 相比 WebGL 在推理上的优势？

- **Compute Shader**：WebGPU 支持通用计算管线，不需要把矩阵运算伪装成纹理渲染
- **显式内存控制**：可精确管理 Buffer 生命周期，避免隐式同步
- **Workgroup Shared Memory**：卷积等操作可利用共享内存减少全局访存
- **FP16 原生支持**：更高吞吐，更低带宽
- **管线缓存**：编译后的 Shader 可持久化，避免重复编译

### Q4: 端侧推理 OOM 怎么防护？

1. **加载前检查**：通过 `performance.memory` 和 `navigator.storage.estimate()` 预估可用空间
2. **分级加载**：先加载 lite 模型，按需加载更大模型
3. **PressureObserver**：监听 CPU/内存压力事件，分级降级
4. **Buffer 池化**：GPU Buffer 和 TypedArray 复用，避免频繁分配
5. **LRU 淘汰**：多模型场景下淘汰最久未用的模型会话
6. **设备丢失恢复**：WebGPU `device.lost` 事件处理，重建推理链路

### Q5: 模型从 PyTorch 到浏览器的完整部署链路？

```
PyTorch → ONNX 导出 (opset 17, dynamic axes)
    → onnx-simplifier (图优化)
    → ONNX Runtime 量化 (INT8 静态量化)
    → 模型分片 (每片 < 5MB，利用 HTTP/2)
    → CDN 部署 + 版本化 URL
    → 前端 IndexedDB 缓存 + 版本校验
    → ONNX Runtime Web 加载 (WebGPU/WASM 后端)
    → Session 预热 (空推理触发编译)
    → 就绪，开始实时推理
```
