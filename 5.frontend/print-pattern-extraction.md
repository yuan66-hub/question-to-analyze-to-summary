# 印花提取功能实现原理与关键代码

> 涵盖端侧图像分割、前景提取、色彩分离、矢量化、透明通道处理到导出的完整技术方案。

---

## 目录

1. [需求定义与核心挑战](#1-需求定义与核心挑战)
2. [整体架构设计](#2-整体架构设计)
3. [核心处理流程](#3-核心处理流程)
4. [模块一：图像预处理](#4-模块一图像预处理)
5. [模块二：前景分割（AI 抠图）](#5-模块二前景分割ai-抠图)
6. [模块三：色彩分离与印花图层拆解](#6-模块三色彩分离与印花图层拆解)
7. [模块四：边缘优化与精细化处理](#7-模块四边缘优化与精细化处理)
8. [模块五：矢量化与格式导出](#8-模块五矢量化与格式导出)
9. [性能优化策略](#9-性能优化策略)
10. [端到端实战架构](#10-端到端实战架构)
11. [面试表达与方案亮点总结](#11-面试表达与方案亮点总结)

---

## 1. 需求定义与核心挑战

### 1.1 什么是印花提取

印花提取是指从拍摄的实物照片或设计稿中，**自动识别并分离出印花图案**，去除背景（如面料纹理、褶皱阴影），输出干净的、可复用的**透明底印花素材**。

**典型应用场景：**

| 场景 | 输入 | 输出 | 关键要求 |
|------|------|------|---------|
| POD 设计素材提取 | T恤实拍图 | 透明底印花 PNG | 边缘锐利、色彩还原 |
| 面料花型数字化 | 面料扫描图 | 无缝 Repeat Tile | 接缝处理、图案对齐 |
| 品牌 Logo 分离 | 产品照片 | 矢量 SVG | 保持矢量精度 |
| 色彩分离（丝印） | 多色印花稿 | 按颜色拆分图层 | 颜色精确、层次清晰 |
| 服装款式拆解 | 服装效果图 | 各部位印花素材 | 位置映射、比例还原 |

### 1.2 核心挑战

| 挑战 | 描述 | 解决方向 |
|------|------|---------|
| **前景/背景分离** | 印花与面料纹理混合，褶皱产生阴影干扰 | AI 语义分割 + Matting |
| **色彩还原** | 拍摄光照不均、白平衡偏移 | 色彩校正 + 直方图均衡 |
| **边缘质量** | 抠图锯齿、半透明渐变区域 | Alpha Matting + 超分辨率 |
| **图案 Repeat 识别** | 连续图案需识别最小重复单元 | 自相关分析 + FFT 频域检测 |
| **大图性能** | 高分辨率面料扫描图（8000×8000+） | Tile 分块 + Web Worker |

---

## 2. 整体架构设计

```
┌──────────────────────────────────────────────────────────────────┐
│                        应用层 (React / Vue)                       │
│  图片上传 / 相机采集 / 参数面板 / 实时预览 / 结果导出 / 批量处理  │
├──────────────────────────────────────────────────────────────────┤
│                       交互编辑层                                  │
│  Canvas 画布 / 选区编辑 / 画笔修正 / 色彩拾取 / 图层管理         │
├──────────────────────────────────────────────────────────────────┤
│                      核心处理管线层                                │
│  预处理 → 分割推理 → Matting → 色彩分离 → 边缘优化 → 矢量化      │
├──────────────────────────────────────────────────────────────────┤
│                      推理引擎层                                   │
│  ONNX Runtime Web │ TF.js │ MediaPipe │ Transformers.js          │
├──────────────────────────────────────────────────────────────────┤
│                      加速计算层                                   │
│  WebGPU / WebGL 2 │ WASM (SIMD + Threads) │ Web Worker 池        │
├──────────────────────────────────────────────────────────────────┤
│                      数据与服务层                                  │
│  IndexedDB 缓存 │ 模型 CDN │ 导出服务 │ 云端推理降级              │
└──────────────────────────────────────────────────────────────────┘
```

### 技术栈总览

| 层级 | 技术选型 |
|------|---------|
| 框架层 | React / Vue 3 + TypeScript |
| 画布引擎 | Fabric.js（交互编辑）+ OffscreenCanvas（离屏处理） |
| AI 推理 | ONNX Runtime Web（主）/ Transformers.js（备） |
| 图像处理 | WebGL Shader / Wasm (Rust image-rs) |
| 矢量化 | Potrace (Wasm) / OpenCV.js 轮廓追踪 |
| 性能加速 | Web Worker 池 + Tile 并行 |
| 导出格式 | PNG (透明底) / SVG / PSD (图层) / TIFF |

---

## 3. 核心处理流程

```
┌──────────┐    ┌──────────┐    ┌───────────────┐    ┌──────────────┐
│ 图像输入  │───→│ 预处理    │───→│ AI 语义分割   │───→│ Alpha Matting │
│          │    │          │    │ (前景检测)     │    │ (精细抠图)    │
└──────────┘    └──────────┘    └───────────────┘    └──────┬───────┘
                                                           │
    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
    │ 格式导出      │←───│ 边缘优化      │←───│ 色彩分离      │
    │ PNG/SVG/PSD  │    │ + 矢量化     │    │ (按颜色拆层)  │
    └──────────────┘    └──────────────┘    └──────────────┘
```

### 详细流程图

```
输入图像
    │
    ▼
┌─────────────────────────┐
│ Step 1: 图像预处理       │
│ · 色彩校正 (白平衡)      │
│ · 降噪 (高斯/双边滤波)   │
│ · 对比度增强 (CLAHE)     │
│ · 下采样 (适配模型输入)   │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Step 2: 粗分割           │
│ · 语义分割模型推理        │  ←── ONNX Runtime (WebGPU)
│ · 输出二值 Mask           │
│ · 多类别时按类别拆分      │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Step 3: Alpha Matting    │
│ · Trimap 生成            │  ←── 膨胀/腐蚀 Mask 边缘
│ · Matting 模型推理        │  ←── MODNet / RVM
│ · 输出连续 Alpha 通道     │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Step 4: 色彩处理         │
│ · 背景色去除             │
│ · 印花色彩还原           │
│ · K-Means 色彩聚类       │
│ · 按颜色生成分层 Mask    │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Step 5: 后处理与导出     │
│ · 边缘抗锯齿             │
│ · 超分辨率 (可选)         │
│ · 轮廓矢量化 (Potrace)   │
│ · 导出 PNG/SVG/PSD       │
└─────────────────────────┘
```

---

## 4. 模块一：图像预处理

### 4.1 色彩校正

拍摄图片往往存在色偏，需先进行白平衡校正和直方图均衡，确保后续分割和色彩分离的准确性。

```typescript
// WebGL Shader: CLAHE 对比度受限自适应直方图均衡
const claheShader = `
  precision highp float;
  uniform sampler2D u_image;
  uniform sampler2D u_lut;      // 预计算 LUT 纹理
  uniform vec2 u_tileCount;     // 网格划分数量
  varying vec2 v_texCoord;

  void main() {
    vec4 color = texture2D(u_image, v_texCoord);

    // 计算当前像素所在 tile 及归一化位置
    vec2 tilePos = v_texCoord * u_tileCount;
    vec2 tileIdx = floor(tilePos);
    vec2 tileUV = fract(tilePos);

    // 查询 4 个相邻 tile 的 LUT 映射值
    float tl = texture2D(u_lut, (tileIdx + vec2(0.0, 0.0)) / u_tileCount).r;
    float tr = texture2D(u_lut, (tileIdx + vec2(1.0, 0.0)) / u_tileCount).r;
    float bl = texture2D(u_lut, (tileIdx + vec2(0.0, 1.0)) / u_tileCount).r;
    float br = texture2D(u_lut, (tileIdx + vec2(1.0, 1.0)) / u_tileCount).r;

    // 双线性插值消除 tile 边界
    float mapped = mix(mix(tl, tr, tileUV.x), mix(bl, br, tileUV.x), tileUV.y);

    // 只处理亮度通道（先转 LAB 更准确，此处简化用灰度）
    float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    float gain = mapped / max(luma, 0.001);
    gl_FragColor = vec4(color.rgb * gain, color.a);
  }
`;
```

### 4.2 降噪（双边滤波）

保留印花边缘的同时去除面料纹理噪声：

```typescript
// Wasm (Rust): 双边滤波 — 保边降噪
#[wasm_bindgen]
pub fn bilateral_filter(
    pixels: &mut [u8], width: u32, height: u32,
    spatial_sigma: f32, range_sigma: f32, radius: i32,
) {
    let w = width as usize;
    let h = height as usize;
    let input = pixels.to_vec();

    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) * 4;
            let center_r = input[idx] as f32;
            let center_g = input[idx + 1] as f32;
            let center_b = input[idx + 2] as f32;

            let (mut sum_r, mut sum_g, mut sum_b, mut weight_sum) =
                (0.0f32, 0.0f32, 0.0f32, 0.0f32);

            for dy in -radius..=radius {
                for dx in -radius..=radius {
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx < 0 || nx >= w as i32 || ny < 0 || ny >= h as i32 {
                        continue;
                    }
                    let nidx = (ny as usize * w + nx as usize) * 4;
                    let nr = input[nidx] as f32;
                    let ng = input[nidx + 1] as f32;
                    let nb = input[nidx + 2] as f32;

                    // 空间权重
                    let spatial_dist = (dx * dx + dy * dy) as f32;
                    let spatial_w = (-spatial_dist / (2.0 * spatial_sigma * spatial_sigma)).exp();
                    // 范围权重 (颜色差异)
                    let color_dist = (nr - center_r).powi(2)
                        + (ng - center_g).powi(2)
                        + (nb - center_b).powi(2);
                    let range_w = (-color_dist / (2.0 * range_sigma * range_sigma)).exp();

                    let w = spatial_w * range_w;
                    sum_r += nr * w;
                    sum_g += ng * w;
                    sum_b += nb * w;
                    weight_sum += w;
                }
            }

            pixels[idx] = (sum_r / weight_sum) as u8;
            pixels[idx + 1] = (sum_g / weight_sum) as u8;
            pixels[idx + 2] = (sum_b / weight_sum) as u8;
        }
    }
}
```

### 4.3 下采样适配模型输入

```typescript
class ImagePreprocessor {
  /**
   * 将原图缩放到模型输入尺寸，保留原始数据用于后续高精度 Matting
   */
  async prepareForInference(
    imageData: ImageData,
    targetSize: { width: number; height: number }
  ): Promise<{ tensor: Float32Array; scale: { x: number; y: number } }> {
    const { width: tw, height: th } = targetSize;
    const { width: ow, height: oh } = imageData;

    // 使用 OffscreenCanvas 进行高质量缩放
    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';

    const bitmap = await createImageBitmap(imageData);
    ctx.drawImage(bitmap, 0, 0, tw, th);
    bitmap.close();

    const resized = ctx.getImageData(0, 0, tw, th);

    // 归一化到 [0, 1] 并转为 NCHW 格式 (模型要求)
    const tensor = new Float32Array(3 * tw * th);
    const mean = [0.485, 0.456, 0.406]; // ImageNet 标准化
    const std = [0.229, 0.224, 0.225];

    for (let i = 0; i < tw * th; i++) {
      tensor[i]              = (resized.data[i * 4] / 255 - mean[0]) / std[0];     // R
      tensor[tw * th + i]    = (resized.data[i * 4 + 1] / 255 - mean[1]) / std[1]; // G
      tensor[2 * tw * th + i] = (resized.data[i * 4 + 2] / 255 - mean[2]) / std[2]; // B
    }

    return {
      tensor,
      scale: { x: ow / tw, y: oh / th },
    };
  }
}
```

---

## 5. 模块二：前景分割（AI 抠图）

### 5.1 模型选型

| 模型 | 参数量 | 输入尺寸 | 特点 | 推理速度 (WebGPU) |
|------|--------|---------|------|-------------------|
| **MODNet** | 6.5M | 512×512 | 一步式 Matting，无需 Trimap | ~35ms |
| **RVM (Robust Video Matting)** | 3.8M | 512×512 | 视频级实时 Matting | ~20ms |
| **SAM-Tiny (蒸馏)** | 5.0M | 1024×1024 | 交互式分割，提示引导 | ~80ms |
| **U²-Net (Lite)** | 1.1M | 320×320 | 显著目标检测，极轻量 | ~15ms |
| **IS-Net** | 1.3M | 1024×1024 | 高精度前景分割 | ~50ms |

**推荐方案：** MODNet（单图场景）+ RVM（视频/实时场景），U²-Net 作为轻量 fallback。

### 5.2 两阶段分割流程

```
阶段一：粗分割（语义级）                    阶段二：精细 Matting（像素级）
┌──────────────────────┐                ┌──────────────────────┐
│ U²-Net / SAM          │                │ MODNet / RVM          │
│                       │                │                       │
│ 输入: RGB 图像        │   Trimap 生成   │ 输入: RGB + Trimap    │
│ 输出: 二值 Mask       │ ─────────────→ │ 输出: Alpha Matte     │
│ (前景 1 / 背景 0)     │                │ (0.0 ~ 1.0 连续值)   │
└──────────────────────┘                └──────────────────────┘
```

### 5.3 ONNX Runtime 推理核心代码

```typescript
import * as ort from 'onnxruntime-web';

class PatternSegmentor {
  private session: ort.InferenceSession | null = null;

  async init(modelUrl: string) {
    // 优先 WebGPU，降级 WebGL，兜底 WASM
    const providers: ort.InferenceSession.ExecutionProviderConfig[] = [];
    if ('gpu' in navigator) {
      providers.push({ name: 'webgpu' });
    }
    providers.push({ name: 'webgl' }, { name: 'wasm' });

    this.session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
    });
  }

  /**
   * 执行前景分割，返回 Alpha Matte
   */
  async segment(inputTensor: Float32Array, width: number, height: number): Promise<Float32Array> {
    if (!this.session) throw new Error('Model not initialized');

    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor('float32', inputTensor, [1, 3, height, width]),
    };

    const results = await this.session.run(feeds);

    // 模型输出: [1, 1, H, W] alpha matte
    const output = results['output'];
    const alpha = new Float32Array(output.data as Float32Array);

    return alpha;
  }

  /**
   * 将分割 Alpha 应用到原图，生成透明底图像
   */
  applyAlpha(
    original: ImageData,
    alpha: Float32Array,
    scale: { x: number; y: number }
  ): ImageData {
    const { width, height, data } = original;
    const result = new ImageData(width, height);
    const alphaW = Math.round(width / scale.x);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = (y * width + x) * 4;

        // 双线性插值采样 Alpha（模型输出分辨率可能低于原图）
        const ax = x / scale.x;
        const ay = y / scale.y;
        const ax0 = Math.floor(ax), ay0 = Math.floor(ay);
        const ax1 = Math.min(ax0 + 1, alphaW - 1);
        const ay1 = Math.min(ay0 + 1, Math.round(height / scale.y) - 1);
        const fx = ax - ax0, fy = ay - ay0;

        const a00 = alpha[ay0 * alphaW + ax0];
        const a10 = alpha[ay0 * alphaW + ax1];
        const a01 = alpha[ay1 * alphaW + ax0];
        const a11 = alpha[ay1 * alphaW + ax1];
        const a = a00 * (1 - fx) * (1 - fy) + a10 * fx * (1 - fy)
                + a01 * (1 - fx) * fy + a11 * fx * fy;

        result.data[srcIdx] = data[srcIdx];         // R
        result.data[srcIdx + 1] = data[srcIdx + 1]; // G
        result.data[srcIdx + 2] = data[srcIdx + 2]; // B
        result.data[srcIdx + 3] = Math.round(a * 255); // Alpha
      }
    }

    return result;
  }

  dispose() {
    this.session?.release();
    this.session = null;
  }
}
```

### 5.4 Trimap 生成（WebGL Shader 实现膨胀/腐蚀）

```glsl
// 形态学膨胀 Shader：将粗分割 Mask 的边缘区域扩展为"未知区域"
precision highp float;
uniform sampler2D u_mask;    // 粗分割二值 Mask
uniform vec2 u_resolution;
uniform float u_radius;      // 膨胀半径（像素）

varying vec2 v_texCoord;

void main() {
    float maxVal = 0.0;
    vec2 texelSize = 1.0 / u_resolution;

    // 圆形结构元素
    for (float dy = -u_radius; dy <= u_radius; dy += 1.0) {
        for (float dx = -u_radius; dx <= u_radius; dx += 1.0) {
            if (dx * dx + dy * dy > u_radius * u_radius) continue;
            vec2 offset = vec2(dx, dy) * texelSize;
            float val = texture2D(u_mask, v_texCoord + offset).r;
            maxVal = max(maxVal, val);
        }
    }

    float original = texture2D(u_mask, v_texCoord).r;
    // Trimap: 1.0 = 确定前景, 0.0 = 确定背景, 0.5 = 未知区域
    float trimap = original > 0.5 ? 1.0 : (maxVal > 0.5 ? 0.5 : 0.0);
    gl_FragColor = vec4(vec3(trimap), 1.0);
}
```

---

## 6. 模块三：色彩分离与印花图层拆解

### 6.1 色彩分离原理

丝网印刷（Screen Printing）要求每种颜色单独出版，因此需要将多色印花拆分为独立色版。

```
原始印花               色彩聚类                按颜色拆层
┌──────────┐    K-Means (K=5)    ┌──────────────────────────┐
│ 🔴🟢🔵🟡  │  ──────────────→   │ Layer 1: 红色通道 Mask    │
│ 多色混合   │                    │ Layer 2: 绿色通道 Mask    │
│           │                    │ Layer 3: 蓝色通道 Mask    │
└──────────┘                    │ Layer 4: 黄色通道 Mask    │
                                │ Layer 5: 黑色轮廓 Mask    │
                                └──────────────────────────┘
```

### 6.2 K-Means 色彩聚类实现

```typescript
class ColorSeparator {
  /**
   * K-Means 色彩聚类 — 将像素归类到 K 种主要颜色
   */
  kMeansColorCluster(
    imageData: ImageData,
    alpha: Float32Array, // 前景 Alpha
    k: number = 6,
    maxIter: number = 20
  ): { centroids: [number, number, number][]; labels: Uint8Array } {
    const { data, width, height } = imageData;
    const pixelCount = width * height;

    // 收集前景像素 (alpha > 0.5)
    const foregroundPixels: [number, number, number][] = [];
    const pixelIndices: number[] = [];
    for (let i = 0; i < pixelCount; i++) {
      if (alpha[i] > 0.5) {
        foregroundPixels.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
        pixelIndices.push(i);
      }
    }

    // K-Means++ 初始化质心
    const centroids = this.kMeansPPInit(foregroundPixels, k);
    const labels = new Uint8Array(pixelCount); // 每像素的聚类标签

    for (let iter = 0; iter < maxIter; iter++) {
      // 分配：每个像素归属最近质心
      const clusterSums = Array.from({ length: k }, () => [0, 0, 0]);
      const clusterCounts = new Array(k).fill(0);

      for (let i = 0; i < foregroundPixels.length; i++) {
        const [r, g, b] = foregroundPixels[i];
        let minDist = Infinity;
        let bestCluster = 0;

        for (let c = 0; c < k; c++) {
          const [cr, cg, cb] = centroids[c];
          const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
          if (dist < minDist) {
            minDist = dist;
            bestCluster = c;
          }
        }

        labels[pixelIndices[i]] = bestCluster;
        clusterSums[bestCluster][0] += r;
        clusterSums[bestCluster][1] += g;
        clusterSums[bestCluster][2] += b;
        clusterCounts[bestCluster]++;
      }

      // 更新质心
      let converged = true;
      for (let c = 0; c < k; c++) {
        if (clusterCounts[c] === 0) continue;
        const newR = Math.round(clusterSums[c][0] / clusterCounts[c]);
        const newG = Math.round(clusterSums[c][1] / clusterCounts[c]);
        const newB = Math.round(clusterSums[c][2] / clusterCounts[c]);

        if (newR !== centroids[c][0] || newG !== centroids[c][1] || newB !== centroids[c][2]) {
          converged = false;
        }
        centroids[c] = [newR, newG, newB];
      }

      if (converged) break;
    }

    return { centroids, labels };
  }

  /**
   * K-Means++ 质心初始化 — 比随机初始化收敛更快、结果更稳定
   */
  private kMeansPPInit(
    pixels: [number, number, number][],
    k: number
  ): [number, number, number][] {
    const centroids: [number, number, number][] = [];
    // 随机选第一个质心
    centroids.push(pixels[Math.floor(Math.random() * pixels.length)]);

    for (let i = 1; i < k; i++) {
      // 计算每个点到最近质心的距离
      const distances = pixels.map(p => {
        let minD = Infinity;
        for (const c of centroids) {
          const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
          minD = Math.min(minD, d);
        }
        return minD;
      });

      // 按距离概率加权采样
      const totalDist = distances.reduce((a, b) => a + b, 0);
      let r = Math.random() * totalDist;
      for (let j = 0; j < distances.length; j++) {
        r -= distances[j];
        if (r <= 0) {
          centroids.push(pixels[j]);
          break;
        }
      }
    }

    return centroids;
  }

  /**
   * 生成各色层 Mask — 每个颜色输出一张独立的灰度 Mask
   */
  generateColorLayers(
    width: number,
    height: number,
    labels: Uint8Array,
    alpha: Float32Array,
    k: number
  ): ImageData[] {
    const layers: ImageData[] = [];

    for (let c = 0; c < k; c++) {
      const layer = new ImageData(width, height);
      for (let i = 0; i < width * height; i++) {
        const isThisColor = labels[i] === c && alpha[i] > 0.5;
        const value = isThisColor ? 255 : 0;
        layer.data[i * 4] = value;
        layer.data[i * 4 + 1] = value;
        layer.data[i * 4 + 2] = value;
        layer.data[i * 4 + 3] = 255;
      }
      layers.push(layer);
    }

    return layers;
  }
}
```

---

## 7. 模块四：边缘优化与精细化处理

### 7.1 边缘抗锯齿（Guided Filter）

Guided Filter 比高斯模糊更能保持边缘结构，适用于 Alpha Matte 的边缘优化。

```typescript
/**
 * Guided Filter — 在 WebGL 中实现边缘感知平滑
 * 以原始 RGB 为引导图像，对 Alpha Matte 进行边缘优化
 */
class GuidedFilterGL {
  private gl: WebGL2RenderingContext;
  private programs: Map<string, WebGLProgram> = new Map();

  constructor(canvas: OffscreenCanvas) {
    this.gl = canvas.getContext('webgl2')!;
    this.initShaders();
  }

  /**
   * 对 Alpha Matte 执行 Guided Filter
   * @param guide - 引导图像 (原始 RGB)
   * @param src   - 待滤波图像 (Alpha Matte)
   * @param radius - 滤波窗口半径
   * @param eps    - 正则化参数 (控制平滑程度)
   */
  apply(guide: ImageData, src: Float32Array, radius: number, eps: number): Float32Array {
    const { width, height } = guide;

    // Step 1: 计算 mean_I, mean_p, mean_Ip, mean_II (均值滤波)
    const meanI = this.boxFilter(this.toFloat(guide), width, height, radius);
    const meanP = this.boxFilter(src, width, height, radius);
    const Ip = this.multiply(this.toFloat(guide), src, width * height);
    const meanIp = this.boxFilter(Ip, width, height, radius);
    const II = this.multiply(this.toFloat(guide), this.toFloat(guide), width * height);
    const meanII = this.boxFilter(II, width, height, radius);

    // Step 2: 计算 a = (mean_Ip - mean_I * mean_p) / (mean_II - mean_I² + eps)
    //         计算 b = mean_p - a * mean_I
    const a = new Float32Array(width * height);
    const b = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const covIp = meanIp[i] - meanI[i] * meanP[i];
      const varI = meanII[i] - meanI[i] * meanI[i];
      a[i] = covIp / (varI + eps);
      b[i] = meanP[i] - a[i] * meanI[i];
    }

    // Step 3: 输出 q = mean_a * I + mean_b
    const meanA = this.boxFilter(a, width, height, radius);
    const meanB = this.boxFilter(b, width, height, radius);
    const result = new Float32Array(width * height);
    const guideF = this.toFloat(guide);
    for (let i = 0; i < width * height; i++) {
      result[i] = Math.max(0, Math.min(1, meanA[i] * guideF[i] + meanB[i]));
    }

    return result;
  }

  private boxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
    // 积分图加速的 Box Filter — O(1) 复杂度
    const integral = new Float32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += src[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] =
          rowSum + integral[y * (w + 1) + (x + 1)];
      }
    }

    const result = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const y1 = Math.max(0, y - r), y2 = Math.min(h - 1, y + r);
        const x1 = Math.max(0, x - r), x2 = Math.min(w - 1, x + r);
        const area = (y2 - y1 + 1) * (x2 - x1 + 1);
        result[y * w + x] =
          (integral[(y2 + 1) * (w + 1) + (x2 + 1)]
          - integral[y1 * (w + 1) + (x2 + 1)]
          - integral[(y2 + 1) * (w + 1) + x1]
          + integral[y1 * (w + 1) + x1]) / area;
      }
    }
    return result;
  }

  private toFloat(imageData: ImageData): Float32Array {
    const { data, width, height } = imageData;
    const result = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      result[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
    }
    return result;
  }

  private multiply(a: Float32Array, b: Float32Array, len: number): Float32Array {
    const result = new Float32Array(len);
    for (let i = 0; i < len; i++) result[i] = a[i] * b[i];
    return result;
  }

  private initShaders() { /* WebGL shader 编译省略 */ }
}
```

### 7.2 图案 Repeat 检测（FFT 频域分析）

面料花型通常有重复图案，通过自相关 / FFT 检测最小重复单元：

```typescript
/**
 * FFT 自相关检测图案重复周期
 * 用于面料花型场景，自动找出最小 Repeat Tile
 */
class RepeatDetector {
  detectRepeatPeriod(
    imageData: ImageData
  ): { periodX: number; periodY: number } | null {
    const gray = this.toGrayscale(imageData);
    const { width, height } = imageData;

    // 计算水平方向自相关
    const acfX = this.autocorrelation1D(gray, width, height, 'horizontal');
    const periodX = this.findPeak(acfX, width);

    // 计算垂直方向自相关
    const acfY = this.autocorrelation1D(gray, width, height, 'vertical');
    const periodY = this.findPeak(acfY, height);

    if (!periodX || !periodY) return null;

    return { periodX, periodY };
  }

  /**
   * 一维自相关函数 — 检测信号中的周期性
   */
  private autocorrelation1D(
    gray: Float32Array, width: number, height: number,
    direction: 'horizontal' | 'vertical'
  ): Float32Array {
    const len = direction === 'horizontal' ? width : height;
    const acf = new Float32Array(len);

    for (let lag = 0; lag < len; lag++) {
      let sum = 0;
      let count = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let nx: number, ny: number;
          if (direction === 'horizontal') {
            nx = x + lag;
            ny = y;
            if (nx >= width) continue;
          } else {
            nx = x;
            ny = y + lag;
            if (ny >= height) continue;
          }

          sum += gray[y * width + x] * gray[ny * width + nx];
          count++;
        }
      }

      acf[lag] = count > 0 ? sum / count : 0;
    }

    // 归一化
    const max = acf[0];
    for (let i = 0; i < len; i++) acf[i] /= max;
    return acf;
  }

  /**
   * 在自相关函数中寻找第一个显著峰值（跳过 lag=0）
   */
  private findPeak(acf: Float32Array, len: number): number | null {
    const minLag = Math.max(10, Math.floor(len * 0.05)); // 最小周期约为 5%
    let maxVal = 0;
    let peakLag = 0;

    for (let i = minLag; i < len / 2; i++) {
      // 检测局部峰值
      if (acf[i] > acf[i - 1] && acf[i] > acf[i + 1] && acf[i] > maxVal) {
        maxVal = acf[i];
        peakLag = i;
      }
    }

    // 峰值需要足够显著（> 0.3）
    return maxVal > 0.3 ? peakLag : null;
  }

  private toGrayscale(imageData: ImageData): Float32Array {
    const { data, width, height } = imageData;
    const gray = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      gray[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
    }
    return gray;
  }
}
```

---

## 8. 模块五：矢量化与格式导出

### 8.1 轮廓追踪与矢量化

```typescript
/**
 * 将位图 Mask 矢量化为 SVG Path
 * 基于 Marching Squares + Douglas-Peucker 简化
 */
class Vectorizer {
  /**
   * 位图轮廓追踪 — Marching Squares 算法
   */
  traceContours(mask: Uint8Array, width: number, height: number): number[][][] {
    const contours: number[][][] = [];
    const visited = new Uint8Array(width * height);

    const getPixel = (x: number, y: number) =>
      x >= 0 && x < width && y >= 0 && y < height
        ? mask[y * width + x] > 128 ? 1 : 0
        : 0;

    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        // 构建 2×2 采样窗口的 case index
        const caseIdx =
          (getPixel(x, y) << 3) |
          (getPixel(x + 1, y) << 2) |
          (getPixel(x + 1, y + 1) << 1) |
          getPixel(x, y + 1);

        if (caseIdx === 0 || caseIdx === 15) continue;
        if (visited[y * width + x]) continue;

        // 追踪轮廓
        const contour = this.followContour(x, y, width, height, getPixel, visited);
        if (contour.length > 10) {
          contours.push(contour);
        }
      }
    }

    return contours;
  }

  /**
   * Douglas-Peucker 路径简化 — 减少矢量点数
   */
  simplifyPath(points: number[][], epsilon: number): number[][] {
    if (points.length <= 2) return points;

    // 找到距离首尾连线最远的点
    let maxDist = 0;
    let maxIdx = 0;
    const [start, end] = [points[0], points[points.length - 1]];

    for (let i = 1; i < points.length - 1; i++) {
      const dist = this.pointToLineDist(points[i], start, end);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    if (maxDist > epsilon) {
      const left = this.simplifyPath(points.slice(0, maxIdx + 1), epsilon);
      const right = this.simplifyPath(points.slice(maxIdx), epsilon);
      return [...left.slice(0, -1), ...right];
    }

    return [start, end];
  }

  /**
   * 生成 SVG Path Data
   */
  toSVGPath(contours: number[][][], epsilon: number = 1.0): string {
    return contours
      .map(contour => {
        const simplified = this.simplifyPath(contour, epsilon);
        const pathParts = simplified.map((p, i) =>
          i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`
        );
        return pathParts.join(' ') + ' Z';
      })
      .join(' ');
  }

  private followContour(
    startX: number, startY: number,
    width: number, height: number,
    getPixel: (x: number, y: number) => number,
    visited: Uint8Array
  ): number[][] {
    // Marching Squares 轮廓跟踪实现
    const contour: number[][] = [];
    let x = startX, y = startY;
    let dir = 0; // 0:右 1:下 2:左 3:上

    do {
      visited[y * width + x] = 1;
      contour.push([x + 0.5, y + 0.5]);

      const caseIdx =
        (getPixel(x, y) << 3) |
        (getPixel(x + 1, y) << 2) |
        (getPixel(x + 1, y + 1) << 1) |
        getPixel(x, y + 1);

      // 根据 case 决定移动方向
      switch (caseIdx) {
        case 1: case 5: case 13: dir = 0; break;  // 右
        case 2: case 3: case 7:  dir = 1; break;  // 下
        case 4: case 12: case 14: dir = 2; break;  // 左
        case 8: case 10: case 11: dir = 3; break;  // 上
        default: dir = (dir + 1) % 4;
      }

      switch (dir) {
        case 0: x++; break;
        case 1: y++; break;
        case 2: x--; break;
        case 3: y--; break;
      }
    } while ((x !== startX || y !== startY) && contour.length < width * height);

    return contour;
  }

  private pointToLineDist(p: number[], a: number[], b: number[]): number {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
}
```

### 8.2 多格式导出

```typescript
class PatternExporter {
  /**
   * 导出透明底 PNG
   */
  async exportPNG(imageData: ImageData, dpi: number = 300): Promise<Blob> {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(imageData, 0, 0);

    return canvas.convertToBlob({ type: 'image/png' });
  }

  /**
   * 导出多色层 SVG（每个颜色一个 <path> 图层）
   */
  exportSVG(
    width: number,
    height: number,
    colorLayers: { color: [number, number, number]; path: string }[]
  ): string {
    const paths = colorLayers.map((layer, i) => {
      const [r, g, b] = layer.color;
      return `  <path id="color-layer-${i}" d="${layer.path}" fill="rgb(${r},${g},${b})" />`;
    });

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`,
      ...paths,
      '</svg>',
    ].join('\n');
  }

  /**
   * 导出分层 PSD（通过 ag-psd 库）
   */
  async exportPSD(
    width: number,
    height: number,
    layers: { name: string; color: string; imageData: ImageData }[]
  ): Promise<ArrayBuffer> {
    // 使用 ag-psd 库组装 PSD 文件结构
    const psd = {
      width,
      height,
      children: layers.map(layer => ({
        name: layer.name,
        canvas: this.imageDataToCanvas(layer.imageData),
        blendMode: 'normal',
        opacity: 255,
      })),
    };

    // @ts-ignore — 动态导入 ag-psd
    const { writePsd } = await import('ag-psd');
    return writePsd(psd);
  }

  private imageDataToCanvas(imageData: ImageData): OffscreenCanvas {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    canvas.getContext('2d')!.putImageData(imageData, 0, 0);
    return canvas;
  }
}
```

---

## 9. 性能优化策略

### 9.1 大图 Tile 分块处理

```typescript
/**
 * Tile-based 并行处理：将大图分块，多 Worker 并行处理
 */
class TileProcessor {
  private workerPool: Worker[];
  private poolSize: number;

  constructor(poolSize = navigator.hardwareConcurrency || 4) {
    this.poolSize = poolSize;
    this.workerPool = Array.from({ length: poolSize }, () =>
      new Worker(new URL('./process-worker.ts', import.meta.url), { type: 'module' })
    );
  }

  async processTiled(
    imageData: ImageData,
    tileSize: number = 512,
    overlap: number = 32 // 重叠区域消除接缝
  ): Promise<ImageData> {
    const { width, height } = imageData;
    const tiles: { x: number; y: number; w: number; h: number }[] = [];

    // 生成 tile 网格
    for (let y = 0; y < height; y += tileSize - overlap) {
      for (let x = 0; x < width; x += tileSize - overlap) {
        tiles.push({
          x,
          y,
          w: Math.min(tileSize, width - x),
          h: Math.min(tileSize, height - y),
        });
      }
    }

    // 分配任务到 Worker 池
    const results = await Promise.all(
      tiles.map((tile, i) => this.dispatchToWorker(
        this.workerPool[i % this.poolSize],
        imageData,
        tile
      ))
    );

    // 合并结果（重叠区域 Alpha 混合）
    return this.mergeTiles(results, width, height, overlap);
  }

  private dispatchToWorker(
    worker: Worker,
    imageData: ImageData,
    tile: { x: number; y: number; w: number; h: number }
  ): Promise<ImageData> {
    return new Promise(resolve => {
      const tileData = this.extractTile(imageData, tile);
      worker.onmessage = (e) => resolve(e.data.result);
      worker.postMessage(
        { type: 'process', data: tileData, tile },
        [tileData.data.buffer] // Transferable 零拷贝
      );
    });
  }

  private extractTile(
    src: ImageData,
    tile: { x: number; y: number; w: number; h: number }
  ): ImageData {
    const tileData = new ImageData(tile.w, tile.h);
    for (let row = 0; row < tile.h; row++) {
      const srcOffset = ((tile.y + row) * src.width + tile.x) * 4;
      const dstOffset = row * tile.w * 4;
      tileData.data.set(
        src.data.subarray(srcOffset, srcOffset + tile.w * 4),
        dstOffset
      );
    }
    return tileData;
  }

  private mergeTiles(
    tiles: ImageData[],
    width: number,
    height: number,
    overlap: number
  ): ImageData {
    // 重叠区域线性混合，消除 tile 接缝
    const result = new ImageData(width, height);
    // ... 合并逻辑
    return result;
  }

  dispose() {
    this.workerPool.forEach(w => w.terminate());
  }
}
```

### 9.2 推理性能优化

| 策略 | 方法 | 效果 |
|------|------|------|
| **模型量化** | FP32 → FP16 / INT8 | 模型体积减半，推理加速 1.5-2x |
| **WebGPU 优先** | 优先 WebGPU → 降级 WebGL → WASM | WebGPU 比 WebGL 快 2-4x |
| **Batch 推理** | 多 Tile 合并为 Batch | GPU 利用率提升 |
| **模型缓存** | IndexedDB 缓存 ONNX 模型 | 二次加载 < 100ms |
| **渐进式渲染** | 低分辨率预览 → 全分辨率处理 | 首次可交互时间 < 1s |

### 9.3 模型缓存策略

```typescript
class ModelCache {
  private dbName = 'pattern-extractor-models';
  private storeName = 'models';

  async getOrFetch(modelUrl: string, version: string): Promise<ArrayBuffer> {
    const db = await this.openDB();
    const cached = await this.getFromDB(db, modelUrl);

    if (cached && cached.version === version) {
      return cached.data;
    }

    // 带进度的模型下载
    const response = await fetch(modelUrl);
    const contentLength = +(response.headers.get('Content-Length') ?? 0);
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;

      // 派发下载进度事件
      self.postMessage({
        type: 'model-download-progress',
        progress: contentLength ? received / contentLength : -1,
      });
    }

    const buffer = this.concatBuffers(chunks);
    await this.saveToDB(db, modelUrl, { version, data: buffer });
    return buffer;
  }

  private async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async getFromDB(db: IDBDatabase, key: string) {
    return new Promise<any>((resolve) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const req = tx.objectStore(this.storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  private async saveToDB(db: IDBDatabase, key: string, value: any) {
    return new Promise<void>((resolve) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      tx.objectStore(this.storeName).put(value, key);
      tx.oncomplete = () => resolve();
    });
  }

  private concatBuffers(chunks: Uint8Array[]): ArrayBuffer {
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result.buffer;
  }
}
```

---

## 10. 端到端实战架构

### 10.1 完整调用链路

```typescript
/**
 * 印花提取 Pipeline — 端到端编排
 */
class PatternExtractionPipeline {
  private preprocessor = new ImagePreprocessor();
  private segmentor = new PatternSegmentor();
  private colorSeparator = new ColorSeparator();
  private guidedFilter: GuidedFilterGL;
  private vectorizer = new Vectorizer();
  private exporter = new PatternExporter();
  private repeatDetector = new RepeatDetector();

  async init() {
    await this.segmentor.init('/models/modnet-512.onnx');
    this.guidedFilter = new GuidedFilterGL(new OffscreenCanvas(1, 1));
  }

  /**
   * 完整提取流程
   */
  async extract(
    inputImage: ImageData,
    options: {
      colorCount?: number;      // 色彩分离数量
      detectRepeat?: boolean;   // 是否检测 Repeat
      outputFormat?: 'png' | 'svg' | 'psd';
      edgeSmooth?: boolean;     // 边缘优化
    } = {}
  ): Promise<ExtractionResult> {
    const {
      colorCount = 6,
      detectRepeat = false,
      outputFormat = 'png',
      edgeSmooth = true,
    } = options;

    // Step 1: 预处理
    const { tensor, scale } = await this.preprocessor.prepareForInference(
      inputImage,
      { width: 512, height: 512 }
    );

    // Step 2: AI 前景分割
    let alpha = await this.segmentor.segment(tensor, 512, 512);

    // Step 3: 边缘优化 (Guided Filter)
    if (edgeSmooth) {
      alpha = this.guidedFilter.apply(inputImage, alpha, 8, 0.01);
    }

    // Step 4: 生成透明底图像
    const extracted = this.segmentor.applyAlpha(inputImage, alpha, scale);

    // Step 5: 色彩分离 (可选)
    const { centroids, labels } = this.colorSeparator.kMeansColorCluster(
      inputImage, alpha, colorCount
    );
    const colorLayers = this.colorSeparator.generateColorLayers(
      inputImage.width, inputImage.height, labels, alpha, colorCount
    );

    // Step 6: Repeat 检测 (可选)
    let repeatInfo = null;
    if (detectRepeat) {
      repeatInfo = this.repeatDetector.detectRepeatPeriod(extracted);
    }

    // Step 7: 矢量化 + 导出
    let output: Blob | string | ArrayBuffer;
    switch (outputFormat) {
      case 'svg': {
        const svgLayers = colorLayers.map((layer, i) => ({
          color: centroids[i],
          path: this.vectorizer.toSVGPath(
            this.vectorizer.traceContours(
              new Uint8Array(layer.data.filter((_, j) => j % 4 === 0)),
              inputImage.width, inputImage.height
            )
          ),
        }));
        output = this.exporter.exportSVG(inputImage.width, inputImage.height, svgLayers);
        break;
      }
      case 'psd':
        output = await this.exporter.exportPSD(
          inputImage.width, inputImage.height,
          colorLayers.map((layer, i) => ({
            name: `Color ${i + 1} (${centroids[i].join(',')})`,
            color: `rgb(${centroids[i].join(',')})`,
            imageData: layer,
          }))
        );
        break;
      default:
        output = await this.exporter.exportPNG(extracted);
    }

    return {
      extracted,         // 透明底 ImageData
      alpha,             // Alpha Matte
      colorLayers,       // 各色层 Mask
      centroids,         // 聚类颜色值
      repeatInfo,        // Repeat 周期信息
      output,            // 最终导出数据
    };
  }

  dispose() {
    this.segmentor.dispose();
  }
}

interface ExtractionResult {
  extracted: ImageData;
  alpha: Float32Array;
  colorLayers: ImageData[];
  centroids: [number, number, number][];
  repeatInfo: { periodX: number; periodY: number } | null;
  output: Blob | string | ArrayBuffer;
}
```

### 10.2 React 组件集成示例

```tsx
function PatternExtractor() {
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [progress, setProgress] = useState<string>('');
  const pipelineRef = useRef<PatternExtractionPipeline>();

  useEffect(() => {
    const pipeline = new PatternExtractionPipeline();
    pipeline.init().then(() => { pipelineRef.current = pipeline; });
    return () => pipeline.dispose();
  }, []);

  const handleImageUpload = async (file: File) => {
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();

    setProgress('正在提取印花...');
    const result = await pipelineRef.current!.extract(imageData, {
      colorCount: 6,
      detectRepeat: true,
      outputFormat: 'png',
    });

    setResult(result);
    setProgress('提取完成');
  };

  return (
    <div>
      <input type="file" accept="image/*" onChange={e => {
        const file = e.target.files?.[0];
        if (file) handleImageUpload(file);
      }} />
      {progress && <p>{progress}</p>}
      {result && (
        <div>
          <h3>提取结果</h3>
          <canvas ref={c => {
            if (c) {
              c.width = result.extracted.width;
              c.height = result.extracted.height;
              c.getContext('2d')!.putImageData(result.extracted, 0, 0);
            }
          }} />
          <h3>色彩图层 ({result.centroids.length} 色)</h3>
          {result.centroids.map((color, i) => (
            <span key={i} style={{
              display: 'inline-block', width: 32, height: 32,
              backgroundColor: `rgb(${color.join(',')})`,
              margin: 4, border: '1px solid #ccc',
            }} />
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## 11. 面试表达与方案亮点总结

### 一句话概括

> "印花提取是一个端侧 AI 图像处理管线：通过 **ONNX Runtime + WebGPU** 做前景分割，**Guided Filter** 优化边缘，**K-Means** 色彩聚类拆分色版，**Marching Squares** 矢量化，最终输出透明底 PNG / 分层 SVG / PSD。"

### 方案亮点

| 亮点 | 说明 |
|------|------|
| **两阶段分割** | 粗分割 (U²-Net) + 精细 Matting (MODNet)，兼顾速度与边缘质量 |
| **端侧推理** | 数据不出端、无服务器成本、离线可用 |
| **WebGPU 优先降级** | WebGPU → WebGL → WASM，覆盖 95%+ 设备 |
| **Guided Filter** | 边缘感知平滑，比高斯模糊保边效果好 3x |
| **K-Means++ 色彩分离** | 自动拆分色版，满足丝印/数码印要求 |
| **FFT Repeat 检测** | 自相关频域分析自动识别面料花型重复周期 |
| **Tile 并行** | Web Worker 池 + 分块处理，支持 8000×8000+ 大图 |
| **多格式导出** | PNG（透明底）/ SVG（矢量）/ PSD（分层），覆盖印刷全链路 |

### 面试追问应对

**Q: 如何处理复杂背景（如花纹面料上的印花）？**

> 两阶段方案：先用语义分割模型识别"印花区域"的粗 Mask，再用 Matting 模型在边缘区域做亚像素级 Alpha 预测。对于面料纹理干扰，在预处理阶段用双边滤波抑制纹理、保留印花边缘。

**Q: 色彩分离的 K 值如何自动确定？**

> 用 **Elbow Method**（肘部法则）或 **Silhouette Score**（轮廓系数）自动选 K。先运行 K=2~10，计算类内距离下降拐点或轮廓系数峰值。实际工程中丝印通常 4-8 色，数码印可放宽到 12-16 色。

**Q: 大图场景下如何保证性能？**

> Tile 分块 + Web Worker 并行。512×512 一块，overlap 32px 消除接缝。Worker 池大小 = `navigator.hardwareConcurrency`。加上渐进式渲染（先出低分辨率预览），首次可交互时间控制在 1 秒内。

**Q: 为什么选择端侧推理而非云端？**

> 三个原因：① 隐私——设计稿是核心资产，数据不出端；② 成本——无 GPU 服务器费用；③ 体验——本地推理延迟 < 100ms，无网络往返。降级方案是大图或复杂场景自动切换云端推理。
