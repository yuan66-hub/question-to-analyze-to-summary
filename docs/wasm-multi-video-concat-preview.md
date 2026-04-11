# WebAssembly 多视频拼接预览技术方案

> 覆盖浏览器端多视频片段解码、拼接合成、实时预览、导出编码的完整链路，重点解决跨片段 seek、无缝衔接与内存控制问题。

---

## 一、问题定义

### 1.1 场景描述

用户在浏览器视频编辑器中选取多段视频片段（可能来自不同源文件、不同编码参数），需要：

1. **实时预览**：拖动播放头可流畅预览拼接后的完整视频
2. **无缝衔接**：片段之间无黑帧、无卡顿、无音频爆破
3. **最终导出**：将拼接结果编码为一个完整的 MP4 文件

```
源视频 A    ████████████████████
               ├─ 截取 ─┤
源视频 B  ██████████████████████████
                     ├─ 截取 ─┤
源视频 C       ████████████████
            ├── 截取 ──┤

拼接结果   [片段A][片段B][片段C] → 连续播放的单一时间轴
```

### 1.2 核心挑战

| 挑战 | 说明 |
|------|------|
| 异构编码 | 不同源视频可能是 H.264/H.265/VP9，分辨率、帧率、采样率各异 |
| 跨片段 Seek | 播放头跳转到任意位置时，需要快速定位到对应片段的正确帧 |
| 无缝衔接 | 片段边界处不能出现黑帧、音频断裂或时间戳跳变 |
| 内存压力 | 多个视频同时解码，帧缓冲内存可能爆炸（1080p 单帧 ≈ 8MB） |
| 音视频同步 | 拼接后的统一时间轴上，音频和视频必须严格对齐 |

---

## 二、整体架构

```
┌───────────────────────────────────────────────────────────────┐
│                        浏览器端                                │
│                                                               │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────────┐  │
│  │  时间轴控制器  │   │  片段调度器    │   │  统一播放控制器    │  │
│  │  TimelineCtrl│──▶│ SegmentSched │──▶│  PlaybackCtrl    │  │
│  └─────────────┘   └──────┬───────┘   └────────┬──────────┘  │
│                           │                     │             │
│            ┌──────────────┼──────────────┐      │             │
│            ▼              ▼              ▼      ▼             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          │
│  │ 解码器实例 A  │ │ 解码器实例 B  │ │ 解码器实例 C  │          │
│  │ WebCodecs /  │ │ WebCodecs /  │ │ WebCodecs /  │          │
│  │ WASM FFmpeg  │ │ WASM FFmpeg  │ │ WASM FFmpeg  │          │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘          │
│         │                │                │                   │
│         └────────────────┼────────────────┘                   │
│                          ▼                                    │
│                 ┌─────────────────┐                           │
│                 │  帧缓冲池        │                           │
│                 │  FrameBufferPool │                           │
│                 └────────┬────────┘                           │
│                          ▼                                    │
│              ┌────────────────────┐                           │
│              │  Canvas/WebGL 渲染  │                           │
│              └────────────────────┘                           │
│                                                               │
│              ┌────────────────────┐                           │
│              │  导出编码器          │                           │
│              │  WebCodecs Encoder  │                           │
│              │  / WASM FFmpeg      │                           │
│              └────────────────────┘                           │
└───────────────────────────────────────────────────────────────┘
```

### 2.1 关键模块

| 模块 | 职责 |
|------|------|
| **时间轴控制器** | 管理拼接后的统一时间轴，将全局时间映射到片段本地时间 |
| **片段调度器** | 根据当前播放位置，决定激活/预加载/释放哪些解码器实例 |
| **解码器池** | 管理多个 WebCodecs/WASM 解码器实例的生命周期 |
| **帧缓冲池** | 预分配固定数量的帧缓冲，环形复用，控制内存上限 |
| **统一播放控制器** | 驱动播放循环，协调音视频同步 |
| **导出编码器** | 逐帧读取拼接结果并编码为目标格式 |

---

## 三、时间轴映射模型

### 3.1 片段定义

```ts
interface VideoSegment {
  id: string;
  sourceUrl: string;            // 源视频文件 URL
  sourceStartTime: number;      // 源视频中的截取起点（秒）
  sourceEndTime: number;        // 源视频中的截取终点（秒）
  timelineStartTime: number;    // 在拼接时间轴上的起始位置（秒）
  duration: number;             // sourceEndTime - sourceStartTime
  // 源视频元信息（首次解析后缓存）
  meta?: {
    codec: string;              // 'avc1.64001f' / 'hev1.1.6.L93' / ...
    width: number;
    height: number;
    fps: number;
    sampleRate: number;         // 音频采样率
    channels: number;           // 音频声道数
  };
}
```

### 3.2 全局时间 → 片段本地时间

```ts
class ConcatTimeline {
  private segments: VideoSegment[] = [];

  constructor(segments: VideoSegment[]) {
    // 按时间轴位置排序，计算每个片段的 timelineStartTime
    let cursor = 0;
    this.segments = segments.map(seg => {
      const placed = { ...seg, timelineStartTime: cursor };
      cursor += seg.duration;
      return placed;
    });
  }

  get totalDuration(): number {
    const last = this.segments[this.segments.length - 1];
    return last.timelineStartTime + last.duration;
  }

  // 核心方法：全局时间 → 片段 + 本地时间
  resolve(globalTime: number): { segment: VideoSegment; localTime: number } | null {
    for (const seg of this.segments) {
      const end = seg.timelineStartTime + seg.duration;
      if (globalTime >= seg.timelineStartTime && globalTime < end) {
        return {
          segment: seg,
          localTime: seg.sourceStartTime + (globalTime - seg.timelineStartTime),
        };
      }
    }
    return null; // 超出范围
  }

  // 查找指定全局时间附近的片段边界
  findBoundary(globalTime: number): { prevEnd: number; nextStart: number } | null {
    for (let i = 0; i < this.segments.length - 1; i++) {
      const currEnd = this.segments[i].timelineStartTime + this.segments[i].duration;
      const nextStart = this.segments[i + 1].timelineStartTime;
      if (globalTime >= currEnd - 0.1 && globalTime <= nextStart + 0.1) {
        return { prevEnd: currEnd, nextStart };
      }
    }
    return null;
  }
}
```

### 3.3 时间轴可视化

```
全局时间轴：
0s          5s          10s         15s         20s
├───────────┼───────────┼───────────┼───────────┤
│  片段 A   │   片段 B   │      片段 C          │
│ 0-5s      │  5-10s     │     10-20s           │
│           │            │                      │

映射到源文件：
片段 A → 源视频 1 的 [12s, 17s]
片段 B → 源视频 2 的 [0s, 5s]
片段 C → 源视频 3 的 [30s, 40s]
```

---

## 四、视频解码策略

### 4.1 方案选型：WebCodecs vs WASM FFmpeg

| 维度 | WebCodecs | WASM FFmpeg (ffmpeg.wasm) |
|------|-----------|--------------------------|
| **解码性能** | 硬件加速，GPU 解码 | 纯 CPU，WASM 软解 |
| **格式支持** | H.264/H.265/VP8/VP9/AV1 | 几乎所有格式 |
| **浏览器支持** | Chrome 94+, Safari 16.4+ | 所有现代浏览器 |
| **内存开销** | 低（GPU 显存） | 高（WASM 线性内存） |
| **Seek 速度** | 需要从关键帧解码 | 可利用 FFmpeg 的 seek 能力 |
| **API 复杂度** | 原生 API，较底层 | 需封装命令行接口 |

**推荐策略**：WebCodecs 优先 + WASM FFmpeg 兜底

```ts
async function createDecoder(segment: VideoSegment): Promise<FrameDecoder> {
  if (self.VideoDecoder && await isCodecSupported(segment.meta!.codec)) {
    return new WebCodecsDecoder(segment);
  }
  return new WasmFFmpegDecoder(segment);
}

async function isCodecSupported(codec: string): Promise<boolean> {
  const support = await VideoDecoder.isConfigSupported({ codec });
  return support.supported === true;
}
```

### 4.2 WebCodecs 解码器封装

```ts
class WebCodecsDecoder implements FrameDecoder {
  private decoder: VideoDecoder;
  private demuxer: MP4Demuxer;           // MP4 解封装
  private pendingFrames: VideoFrame[] = [];
  private resolveFrame: ((frame: VideoFrame) => void) | null = null;

  constructor(private segment: VideoSegment) {
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => console.error('Decode error:', e),
    });

    this.decoder.configure({
      codec: segment.meta!.codec,
      codedWidth: segment.meta!.width,
      codedHeight: segment.meta!.height,
      // 硬件加速优先
      hardwareAcceleration: 'prefer-hardware',
    });
  }

  private onFrame(frame: VideoFrame) {
    if (this.resolveFrame) {
      this.resolveFrame(frame);
      this.resolveFrame = null;
    } else {
      this.pendingFrames.push(frame);
    }
  }

  // 解码指定时间点的帧
  async decodeAt(localTime: number): Promise<VideoFrame> {
    // 1. 从 demuxer 获取目标时间附近的编码数据
    const samples = await this.demuxer.seekTo(localTime);

    // 2. 从最近的关键帧开始解码
    for (const sample of samples) {
      this.decoder.decode(new EncodedVideoChunk({
        type: sample.isKeyframe ? 'key' : 'delta',
        timestamp: sample.timestamp,
        duration: sample.duration,
        data: sample.data,
      }));
    }

    // 3. 等待目标帧输出
    await this.decoder.flush();

    if (this.pendingFrames.length > 0) {
      // 取最接近目标时间的帧
      return this.pickClosestFrame(localTime);
    }

    // 等待异步输出
    return new Promise(resolve => { this.resolveFrame = resolve; });
  }

  private pickClosestFrame(targetTime: number): VideoFrame {
    let best = this.pendingFrames[0];
    let bestDiff = Math.abs(best.timestamp / 1e6 - targetTime);

    for (const frame of this.pendingFrames) {
      const diff = Math.abs(frame.timestamp / 1e6 - targetTime);
      if (diff < bestDiff) {
        best.close(); // 释放非目标帧
        best = frame;
        bestDiff = diff;
      } else {
        frame.close();
      }
    }

    this.pendingFrames = [];
    return best;
  }

  dispose() {
    this.decoder.close();
    this.pendingFrames.forEach(f => f.close());
  }
}
```

### 4.3 WASM FFmpeg 解码器封装

```ts
class WasmFFmpegDecoder implements FrameDecoder {
  private ffmpeg: FFmpegInstance;
  private frameBuffer: Uint8Array;

  constructor(private segment: VideoSegment) {
    // 预分配帧缓冲
    const { width, height } = segment.meta!;
    this.frameBuffer = new Uint8Array(width * height * 4); // RGBA
  }

  async init() {
    const { createFFmpeg } = await import('@ffmpeg/ffmpeg');
    this.ffmpeg = createFFmpeg({ log: false });
    await this.ffmpeg.load();

    // 将视频文件写入 WASM 虚拟文件系统
    const data = await fetch(this.segment.sourceUrl).then(r => r.arrayBuffer());
    this.ffmpeg.FS('writeFile', 'input.mp4', new Uint8Array(data));
  }

  async decodeAt(localTime: number): Promise<ImageData> {
    const { width, height } = this.segment.meta!;

    // 使用 FFmpeg 提取指定时间点的单帧
    await this.ffmpeg.run(
      '-ss', localTime.toFixed(3),
      '-i', 'input.mp4',
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${width}x${height}`,
      '-y', 'frame.raw'
    );

    // 读取原始帧数据
    const rawData = this.ffmpeg.FS('readFile', 'frame.raw');
    return new ImageData(
      new Uint8ClampedArray(rawData.buffer),
      width, height
    );
  }

  dispose() {
    this.ffmpeg.exit();
  }
}
```

### 4.4 MP4 解封装（Demuxer）

WebCodecs 不包含解封装功能，需要搭配 mp4box.js 或自定义 WASM demuxer：

```ts
class MP4Demuxer {
  private file: MP4File;
  private samples: EncodedSample[] = [];
  private keyframeIndex: number[] = []; // 关键帧在 samples 中的索引

  constructor(private url: string) {
    this.file = MP4Box.createFile();
  }

  async load(): Promise<VideoTrackInfo> {
    const response = await fetch(this.url);
    const reader = response.body!.getReader();
    let offset = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const buffer = value.buffer as MP4ArrayBuffer;
      buffer.fileStart = offset;
      this.file.appendBuffer(buffer);
      offset += value.byteLength;
    }

    this.file.flush();
    return this.extractTrackInfo();
  }

  // Seek 到指定时间，返回从最近关键帧开始的 samples
  seekTo(timeInSeconds: number): EncodedSample[] {
    const targetTimestamp = timeInSeconds * 1e6; // 转换为微秒

    // 二分查找最近的关键帧
    let keyframeIdx = this.findNearestKeyframe(targetTimestamp);

    // 收集从关键帧到目标帧的所有 samples
    const result: EncodedSample[] = [];
    for (let i = keyframeIdx; i < this.samples.length; i++) {
      result.push(this.samples[i]);
      if (this.samples[i].timestamp >= targetTimestamp) break;
    }

    return result;
  }

  private findNearestKeyframe(timestamp: number): number {
    let lo = 0, hi = this.keyframeIndex.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.samples[this.keyframeIndex[mid]].timestamp <= timestamp) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return this.keyframeIndex[lo];
  }
}
```

---

## 五、片段调度与预加载

### 5.1 解码器生命周期管理

同时激活所有片段的解码器会占用大量内存。采用**滑动窗口**策略：

```
时间轴上的片段：
[  A  ][  B  ][  C  ][  D  ][  E  ][  F  ]

播放头在 C 位置时，解码器状态：
  A: disposed（已释放）
  B: standby（已加载元数据，随时可解码）
  C: active（正在解码，输出帧到渲染器）
  D: preloading（预加载中，提前获取关键帧）
  E: idle（未初始化）
  F: idle
```

```ts
class SegmentScheduler {
  private decoders = new Map<string, FrameDecoder>();
  private timeline: ConcatTimeline;
  private preloadWindow = 1; // 预加载前后各 1 个片段

  async updatePlayhead(globalTime: number) {
    const current = this.timeline.resolve(globalTime);
    if (!current) return;

    const currentIdx = this.timeline.indexOf(current.segment);

    // 确定需要保持活跃的片段范围
    const activeRange = {
      start: Math.max(0, currentIdx - 1),
      end: Math.min(this.timeline.segmentCount - 1, currentIdx + this.preloadWindow),
    };

    // 释放范围外的解码器
    for (const [id, decoder] of this.decoders) {
      const idx = this.timeline.indexOfId(id);
      if (idx < activeRange.start || idx > activeRange.end) {
        decoder.dispose();
        this.decoders.delete(id);
      }
    }

    // 预加载范围内未初始化的解码器
    for (let i = activeRange.start; i <= activeRange.end; i++) {
      const seg = this.timeline.segmentAt(i);
      if (!this.decoders.has(seg.id)) {
        const decoder = await createDecoder(seg);
        this.decoders.set(seg.id, decoder);
      }
    }

    // 返回当前帧
    const decoder = this.decoders.get(current.segment.id)!;
    return decoder.decodeAt(current.localTime);
  }
}
```

### 5.2 片段边界预解码

片段切换瞬间最容易出现卡顿。提前解码下一片段的首帧：

```ts
class BoundaryPreloader {
  private preloadedFirstFrames = new Map<string, VideoFrame>();

  async preloadNextSegmentStart(nextSegment: VideoSegment) {
    if (this.preloadedFirstFrames.has(nextSegment.id)) return;

    const decoder = await createDecoder(nextSegment);
    // 解码片段的第一帧（从源视频的 sourceStartTime 开始）
    const firstFrame = await decoder.decodeAt(nextSegment.sourceStartTime);
    this.preloadedFirstFrames.set(nextSegment.id, firstFrame);
  }

  getPreloadedFrame(segmentId: string): VideoFrame | null {
    const frame = this.preloadedFirstFrames.get(segmentId);
    if (frame) {
      this.preloadedFirstFrames.delete(segmentId);
      return frame;
    }
    return null;
  }
}
```

---

## 六、帧缓冲池与内存管理

### 6.1 固定大小帧缓冲池

```ts
class FrameBufferPool {
  private pool: ArrayBuffer[];
  private inUse = new Set<ArrayBuffer>();
  private readonly frameSize: number;
  private readonly maxFrames: number;

  constructor(width: number, height: number, maxFrames = 30) {
    this.frameSize = width * height * 4; // RGBA
    this.maxFrames = maxFrames;

    // 预分配，避免运行时 GC
    this.pool = Array.from(
      { length: maxFrames },
      () => new ArrayBuffer(this.frameSize)
    );
  }

  acquire(): ArrayBuffer | null {
    const buffer = this.pool.pop();
    if (!buffer) return null; // 池耗尽
    this.inUse.add(buffer);
    return buffer;
  }

  release(buffer: ArrayBuffer) {
    this.inUse.delete(buffer);
    this.pool.push(buffer);
  }

  get available(): number {
    return this.pool.length;
  }

  get memoryUsageMB(): number {
    return (this.maxFrames * this.frameSize) / (1024 * 1024);
  }
}
```

### 6.2 内存预算计算

```
1080p 帧缓冲池内存预算：
  单帧 = 1920 × 1080 × 4 = 8.3 MB
  30 帧缓冲池 = 8.3 × 30 = 249 MB

720p 帧缓冲池：
  单帧 = 1280 × 720 × 4 = 3.7 MB
  30 帧缓冲池 = 3.7 × 30 = 111 MB

策略：
  预览阶段 → 720p 缓冲池（节省内存）
  导出阶段 → 原始分辨率（按需分配，逐帧处理后释放）
```

### 6.3 WASM 线性内存分区

当使用 WASM FFmpeg 解码时，需要精细管理线性内存：

```
┌─────────────────────────────────────────────────────────┐
│                  WASM Linear Memory (256MB)              │
│                                                         │
│  ┌──────────┬────────────┬────────────┬──────────────┐  │
│  │  FFmpeg  │  解码缓冲区  │  帧缓冲池   │  临时工作区   │  │
│  │  Runtime │  (输入数据)  │  (输出帧)   │  (编码/滤镜) │  │
│  │  ~20MB   │   ~30MB    │  ~120MB    │   ~50MB      │  │
│  └──────────┴────────────┴────────────┴──────────────┘  │
└─────────────────────────────────────────────────────────┘
```

```c
// WASM 侧内存分区管理
typedef struct {
    uint8_t* base;
    size_t   size;
    size_t   used;
} MemoryArena;

// 帧缓冲池：环形分配
typedef struct {
    uint8_t*  buffer;       // 连续内存块
    int       frame_size;   // 单帧大小（W * H * 4）
    int       capacity;     // 总帧数
    int       write_idx;    // 写入位置
    int       read_idx;     // 读取位置
} FrameRingBuffer;

EMSCRIPTEN_KEEPALIVE
FrameRingBuffer* create_frame_ring(int width, int height, int capacity) {
    FrameRingBuffer* ring = malloc(sizeof(FrameRingBuffer));
    ring->frame_size = width * height * 4;
    ring->capacity = capacity;
    ring->buffer = malloc(ring->frame_size * capacity);
    ring->write_idx = 0;
    ring->read_idx = 0;
    return ring;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* ring_acquire_write(FrameRingBuffer* ring) {
    uint8_t* ptr = ring->buffer + (ring->write_idx % ring->capacity) * ring->frame_size;
    ring->write_idx++;
    return ptr;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* ring_acquire_read(FrameRingBuffer* ring) {
    if (ring->read_idx >= ring->write_idx) return NULL; // 无可读帧
    uint8_t* ptr = ring->buffer + (ring->read_idx % ring->capacity) * ring->frame_size;
    ring->read_idx++;
    return ptr;
}
```

---

## 七、音视频同步

### 7.1 统一时钟模型

拼接后的音视频需要一个统一时钟，而非依赖各片段原始时间戳：

```ts
class UnifiedClock {
  private startTime = 0;
  private pauseTime = 0;
  private playing = false;

  play() {
    this.startTime = performance.now() - this.pauseTime;
    this.playing = true;
  }

  pause() {
    this.pauseTime = this.currentTime;
    this.playing = false;
  }

  get currentTime(): number {
    if (!this.playing) return this.pauseTime;
    return (performance.now() - this.startTime) / 1000; // 秒
  }

  // Seek 时重置时钟
  seekTo(time: number) {
    this.pauseTime = time;
    if (this.playing) {
      this.startTime = performance.now() - time * 1000;
    }
  }
}
```

### 7.2 音频拼接处理

音频拼接的难点在于：不同片段可能有不同采样率、声道数，且片段边界需要做淡入淡出避免爆破音。

```ts
class AudioConcatenator {
  private audioCtx: AudioContext;
  private segments: AudioSegment[] = [];

  constructor() {
    this.audioCtx = new AudioContext();
  }

  // 加载并解码音频片段
  async loadSegment(segment: VideoSegment): Promise<AudioBuffer> {
    const response = await fetch(segment.sourceUrl);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);

    // 截取指定范围
    return this.trimAudioBuffer(
      audioBuffer,
      segment.sourceStartTime,
      segment.sourceEndTime
    );
  }

  // 截取 AudioBuffer 的指定时间范围
  private trimAudioBuffer(
    buffer: AudioBuffer,
    startTime: number,
    endTime: number
  ): AudioBuffer {
    const sampleRate = buffer.sampleRate;
    const startSample = Math.floor(startTime * sampleRate);
    const endSample = Math.floor(endTime * sampleRate);
    const length = endSample - startSample;

    const trimmed = this.audioCtx.createBuffer(
      buffer.numberOfChannels,
      length,
      sampleRate
    );

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const source = buffer.getChannelData(ch);
      const target = trimmed.getChannelData(ch);
      target.set(source.subarray(startSample, endSample));
    }

    return trimmed;
  }

  // 拼接所有片段，处理边界交叉淡入淡出
  async concatenate(
    segments: VideoSegment[],
    crossfadeDuration = 0.02 // 20ms 交叉淡化
  ): Promise<AudioBuffer> {
    const buffers: AudioBuffer[] = [];
    for (const seg of segments) {
      buffers.push(await this.loadSegment(seg));
    }

    // 统一采样率（以第一个片段为基准，或使用 44100）
    const targetRate = 44100;
    const resampled = buffers.map(buf =>
      this.resample(buf, targetRate)
    );

    // 计算总长度
    const totalLength = resampled.reduce((sum, buf) => sum + buf.length, 0);
    const channels = Math.max(...resampled.map(b => b.numberOfChannels));
    const output = this.audioCtx.createBuffer(channels, totalLength, targetRate);

    // 逐段拷贝 + 边界交叉淡化
    let offset = 0;
    const fadeSamples = Math.floor(crossfadeDuration * targetRate);

    for (let i = 0; i < resampled.length; i++) {
      const buf = resampled[i];
      for (let ch = 0; ch < channels; ch++) {
        const src = ch < buf.numberOfChannels
          ? buf.getChannelData(ch)
          : new Float32Array(buf.length); // 声道不足时补零
        const dst = output.getChannelData(ch);

        // 拷贝数据
        dst.set(src, offset);

        // 首个片段以外的片段做淡入
        if (i > 0) {
          for (let s = 0; s < fadeSamples && s < buf.length; s++) {
            dst[offset + s] *= s / fadeSamples;
          }
        }

        // 末尾片段以外的片段做淡出
        if (i < resampled.length - 1) {
          for (let s = 0; s < fadeSamples && s < buf.length; s++) {
            const idx = offset + buf.length - 1 - s;
            dst[idx] *= s / fadeSamples;
          }
        }
      }
      offset += buf.length;
    }

    return output;
  }

  private resample(buffer: AudioBuffer, targetRate: number): AudioBuffer {
    if (buffer.sampleRate === targetRate) return buffer;

    const ratio = targetRate / buffer.sampleRate;
    const newLength = Math.floor(buffer.length * ratio);
    const output = this.audioCtx.createBuffer(
      buffer.numberOfChannels, newLength, targetRate
    );

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = output.getChannelData(ch);
      // 线性插值重采样
      for (let i = 0; i < newLength; i++) {
        const srcIdx = i / ratio;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(lo + 1, src.length - 1);
        const frac = srcIdx - lo;
        dst[i] = src[lo] * (1 - frac) + src[hi] * frac;
      }
    }

    return output;
  }
}
```

### 7.3 WASM 侧音频交叉淡化

对于导出场景，在 WASM 中做音频拼接效率更高：

```c
// 两段音频交叉淡化合并
EMSCRIPTEN_KEEPALIVE
void crossfade_audio(
    float* bufA, int lenA,
    float* bufB, int lenB,
    float* output,
    int fadeSamples       // 交叉淡化采样数
) {
    // 段 A 非淡化部分
    int bodyA = lenA - fadeSamples;
    memcpy(output, bufA, bodyA * sizeof(float));

    // 交叉淡化区域
    for (int i = 0; i < fadeSamples; i++) {
        float t = (float)i / fadeSamples;
        output[bodyA + i] = bufA[bodyA + i] * (1.0f - t) + bufB[i] * t;
    }

    // 段 B 非淡化部分
    memcpy(output + bodyA + fadeSamples,
           bufB + fadeSamples,
           (lenB - fadeSamples) * sizeof(float));
}
```

---

## 八、播放循环与渲染

### 8.1 播放控制器

```ts
class ConcatPlayer {
  private timeline: ConcatTimeline;
  private scheduler: SegmentScheduler;
  private clock: UnifiedClock;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animationId: number | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    segments: VideoSegment[]
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.timeline = new ConcatTimeline(segments);
    this.scheduler = new SegmentScheduler(this.timeline);
    this.clock = new UnifiedClock();
  }

  play() {
    this.clock.play();
    this.renderLoop();
  }

  pause() {
    this.clock.pause();
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  seek(time: number) {
    this.clock.seekTo(time);
    // seek 时立即渲染一帧
    this.renderSingleFrame(time);
  }

  private async renderLoop() {
    const currentTime = this.clock.currentTime;

    // 检查是否播放完毕
    if (currentTime >= this.timeline.totalDuration) {
      this.pause();
      this.dispatchEvent('ended');
      return;
    }

    await this.renderSingleFrame(currentTime);
    this.animationId = requestAnimationFrame(() => this.renderLoop());
  }

  private async renderSingleFrame(globalTime: number) {
    const frame = await this.scheduler.updatePlayhead(globalTime);
    if (!frame) return;

    if (frame instanceof VideoFrame) {
      // WebCodecs VideoFrame → Canvas
      this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      frame.close(); // 释放 GPU 资源
    } else if (frame instanceof ImageData) {
      // WASM 解码结果 → Canvas
      this.ctx.putImageData(frame, 0, 0);
    }
  }
}
```

### 8.2 分辨率归一化

不同片段分辨率不同时，需要归一化到统一输出尺寸：

```ts
class ResolutionNormalizer {
  private outputWidth: number;
  private outputHeight: number;

  constructor(outputWidth: number, outputHeight: number) {
    this.outputWidth = outputWidth;
    this.outputHeight = outputHeight;
  }

  // 计算 letterbox/pillarbox 填充参数
  calculateFit(
    srcWidth: number,
    srcHeight: number,
    mode: 'contain' | 'cover' | 'stretch' = 'contain'
  ): DrawParams {
    const srcRatio = srcWidth / srcHeight;
    const dstRatio = this.outputWidth / this.outputHeight;

    let drawWidth: number, drawHeight: number, drawX: number, drawY: number;

    if (mode === 'stretch') {
      return {
        x: 0, y: 0,
        width: this.outputWidth, height: this.outputHeight,
      };
    }

    const fitInside = mode === 'contain'
      ? srcRatio > dstRatio   // contain: 宽的以宽为准
      : srcRatio < dstRatio;  // cover: 宽的以高为准

    if (fitInside) {
      drawWidth = this.outputWidth;
      drawHeight = this.outputWidth / srcRatio;
    } else {
      drawHeight = this.outputHeight;
      drawWidth = this.outputHeight * srcRatio;
    }

    drawX = (this.outputWidth - drawWidth) / 2;
    drawY = (this.outputHeight - drawHeight) / 2;

    return { x: drawX, y: drawY, width: drawWidth, height: drawHeight };
  }
}

interface DrawParams {
  x: number;
  y: number;
  width: number;
  height: number;
}
```

---

## 九、导出编码

### 9.1 WebCodecs 编码器

```ts
class VideoExporter {
  private encoder: VideoEncoder;
  private muxer: MP4Muxer;           // 例如 mp4-muxer 库
  private timeline: ConcatTimeline;
  private frameIndex = 0;

  constructor(
    timeline: ConcatTimeline,
    config: ExportConfig
  ) {
    this.timeline = timeline;
    this.muxer = new MP4Muxer(config);

    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        this.muxer.addVideoChunk(chunk, metadata);
      },
      error: (e) => console.error('Encode error:', e),
    });

    this.encoder.configure({
      codec: 'avc1.640028',          // H.264 High Profile
      width: config.width,
      height: config.height,
      bitrate: config.bitrate,       // 例如 8_000_000 (8Mbps)
      framerate: config.fps,
    });
  }

  async exportAll(onProgress: (p: number) => void): Promise<Blob> {
    const fps = 30;
    const totalFrames = Math.ceil(this.timeline.totalDuration * fps);
    const frameDuration = 1 / fps;

    for (let i = 0; i < totalFrames; i++) {
      const globalTime = i * frameDuration;
      const resolved = this.timeline.resolve(globalTime);
      if (!resolved) continue;

      // 解码当前帧
      const decoder = await this.getDecoder(resolved.segment);
      const frame = await decoder.decodeAt(resolved.localTime);

      // 创建 VideoFrame（如果解码结果是 ImageData）
      let videoFrame: VideoFrame;
      if (frame instanceof VideoFrame) {
        videoFrame = frame;
      } else {
        videoFrame = new VideoFrame(frame.data.buffer, {
          format: 'RGBA',
          codedWidth: frame.width,
          codedHeight: frame.height,
          timestamp: i * frameDuration * 1e6, // 微秒
        });
      }

      // 每隔一定间隔输出关键帧
      const keyFrame = i % (fps * 2) === 0; // 每 2 秒一个关键帧
      this.encoder.encode(videoFrame, { keyFrame });
      videoFrame.close();

      onProgress(i / totalFrames);
    }

    await this.encoder.flush();
    return this.muxer.finalize(); // 返回 MP4 Blob
  }
}

interface ExportConfig {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}
```

### 9.2 WASM FFmpeg 导出（兜底方案）

```ts
class WasmFFmpegExporter {
  private ffmpeg: FFmpegInstance;

  async export(segments: VideoSegment[], output: ExportConfig): Promise<Blob> {
    await this.ffmpeg.load();

    // 1. 将所有源视频写入 WASM 文件系统
    for (let i = 0; i < segments.length; i++) {
      const data = await fetch(segments[i].sourceUrl).then(r => r.arrayBuffer());
      this.ffmpeg.FS('writeFile', `input_${i}.mp4`, new Uint8Array(data));
    }

    // 2. 生成 concat filter 脚本
    const filterParts = segments.map((seg, i) => {
      const trim = `[${i}:v]trim=start=${seg.sourceStartTime}:end=${seg.sourceEndTime},setpts=PTS-STARTPTS[v${i}];`;
      const atrim = `[${i}:a]atrim=start=${seg.sourceStartTime}:end=${seg.sourceEndTime},asetpts=PTS-STARTPTS[a${i}];`;
      return trim + atrim;
    });

    const concatInputs = segments.map((_, i) => `[v${i}][a${i}]`).join('');
    const filterComplex = filterParts.join('') +
      `${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

    // 3. 构建 FFmpeg 命令
    const inputArgs = segments.flatMap((_, i) => ['-i', `input_${i}.mp4`]);

    await this.ffmpeg.run(
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[outv]', '-map', '[outa]',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-s', `${output.width}x${output.height}`,
      '-r', String(output.fps),
      '-y', 'output.mp4'
    );

    // 4. 读取输出文件
    const outputData = this.ffmpeg.FS('readFile', 'output.mp4');
    return new Blob([outputData.buffer], { type: 'video/mp4' });
  }
}
```

---

## 十、片段切换无缝衔接

### 10.1 片段边界的三大问题

```
问题 1：黑帧
  ──────────┤ 片段A 最后一帧 │ 黑帧 │ 片段B 第一帧 ├──────────
  原因：解码器切换有延迟，下一帧还没解出来

问题 2：音频爆破
  ~~~~~~~~~~│ 突变 │~~~~~~~~~~
  原因：两段音频的采样值不连续，产生阶跃脉冲

问题 3：时间戳跳变
  ... 4998ms 4999ms 5000ms │ 0ms 1ms 2ms ...
  原因：新片段的时间戳从头开始，播放器混乱
```

### 10.2 解决方案

```ts
class SeamlessTransition {
  // 方案 1：预解码缓冲（解决黑帧）
  async ensureNoBlackFrame(
    currentSegment: VideoSegment,
    nextSegment: VideoSegment,
    transitionTime: number
  ) {
    // 在当前片段播放到最后 500ms 时，开始解码下一片段的首帧
    const preloadThreshold = 0.5; // 秒
    const timeToEnd = currentSegment.duration -
      (transitionTime - currentSegment.timelineStartTime);

    if (timeToEnd <= preloadThreshold) {
      await this.preloadFirstFrame(nextSegment);
    }
  }

  // 方案 2：音频交叉淡化（解决爆破音）
  applyCrossfade(
    audioCtx: AudioContext,
    currentSource: AudioBufferSourceNode,
    nextSource: AudioBufferSourceNode,
    fadeMs = 20
  ) {
    const now = audioCtx.currentTime;
    const fadeSec = fadeMs / 1000;

    // 当前片段淡出
    const gainA = audioCtx.createGain();
    gainA.gain.setValueAtTime(1, now);
    gainA.gain.linearRampToValueAtTime(0, now + fadeSec);
    currentSource.connect(gainA).connect(audioCtx.destination);

    // 下一片段淡入
    const gainB = audioCtx.createGain();
    gainB.gain.setValueAtTime(0, now);
    gainB.gain.linearRampToValueAtTime(1, now + fadeSec);
    nextSource.connect(gainB).connect(audioCtx.destination);
  }

  // 方案 3：时间戳重映射（解决跳变）
  remapTimestamp(
    frame: VideoFrame,
    segmentTimelineStart: number,
    segmentSourceStart: number
  ): number {
    // 将帧的原始时间戳映射到全局时间轴
    const localTime = frame.timestamp / 1e6; // 微秒 → 秒
    const offsetInSegment = localTime - segmentSourceStart;
    return segmentTimelineStart + offsetInSegment;
  }
}
```

---

## 十一、Worker 架构

### 11.1 主线程 vs Worker 分工

```
┌────────────────────┐          ┌────────────────────────────┐
│      主线程         │          │        Decode Worker       │
│                    │          │                            │
│  UI 交互           │          │  MP4 解封装                 │
│  时间轴拖拽         │  ◄────►  │  WebCodecs / WASM 解码     │
│  Canvas 渲染        │ 消息传递 │  帧格式转换                 │
│  播放控制           │          │  音频重采样                 │
│                    │          │                            │
└────────────────────┘          └────────────────────────────┘
                                ┌────────────────────────────┐
                                │       Export Worker        │
                                │                            │
                                │  逐帧解码                   │
                                │  分辨率归一化                │
                                │  WebCodecs 编码             │
                                │  MP4 封装                   │
                                └────────────────────────────┘
```

### 11.2 Worker 通信协议

```ts
// 主线程 → Worker 的消息
type WorkerCommand =
  | { type: 'LOAD_SEGMENT'; segment: VideoSegment }
  | { type: 'DECODE_FRAME'; segmentId: string; localTime: number; requestId: number }
  | { type: 'SEEK'; segmentId: string; localTime: number }
  | { type: 'DISPOSE_SEGMENT'; segmentId: string }
  | { type: 'EXPORT_START'; segments: VideoSegment[]; config: ExportConfig };

// Worker → 主线程的消息
type WorkerResponse =
  | { type: 'FRAME_READY'; requestId: number; frame: VideoFrame }    // Transferable
  | { type: 'FRAME_READY_PIXELS'; requestId: number; pixels: ArrayBuffer; width: number; height: number }
  | { type: 'SEGMENT_LOADED'; segmentId: string; meta: VideoMeta }
  | { type: 'EXPORT_PROGRESS'; progress: number }
  | { type: 'EXPORT_COMPLETE'; blob: Blob }
  | { type: 'ERROR'; message: string };

// Worker 实现
self.onmessage = async (e: MessageEvent<WorkerCommand>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'DECODE_FRAME': {
      const decoder = decoders.get(msg.segmentId);
      if (!decoder) {
        self.postMessage({ type: 'ERROR', message: `Decoder not found: ${msg.segmentId}` });
        return;
      }

      const frame = await decoder.decodeAt(msg.localTime);

      if (frame instanceof VideoFrame) {
        // VideoFrame 支持 Transferable，零拷贝传输
        self.postMessage(
          { type: 'FRAME_READY', requestId: msg.requestId, frame },
          { transfer: [frame] }
        );
      } else {
        // ImageData → ArrayBuffer 传输
        self.postMessage(
          {
            type: 'FRAME_READY_PIXELS',
            requestId: msg.requestId,
            pixels: frame.data.buffer,
            width: frame.width,
            height: frame.height,
          },
          { transfer: [frame.data.buffer] }
        );
      }
      break;
    }
    // ...
  }
};
```

---

## 十二、性能优化汇总

| 优化手段 | 效果 | 适用阶段 |
|---------|------|---------|
| WebCodecs 硬件加速解码 | 解码性能提升 5-10× vs WASM 软解 | 预览 + 导出 |
| 帧缓冲池预分配 | 消除运行时 GC 停顿 | 预览 |
| 预览分辨率降采样 | 720p 预览比 1080p 省 55% 内存 | 预览 |
| 解码器滑动窗口 | 同时只维护 2-3 个解码器实例 | 预览 |
| 片段边界预解码 | 消除切换黑帧 | 预览 |
| 音频交叉淡化 | 消除片段边界爆破音 | 预览 + 导出 |
| VideoFrame Transferable | Worker↔主线程零拷贝传输 | 预览 |
| 关键帧索引缓存 | Seek 时直接跳到最近关键帧 | 预览 |
| concat filter（FFmpeg） | 服务端/WASM 一次性拼接 | 导出 |
| 分段并行编码 | 将长视频拆为多段并行编码后合并 | 导出 |

---

## 十三、完整数据流时序

以用户 Seek 到两个片段交界处为例：

```
用户拖动 Seek Bar
      │
      ▼
┌──────────────────┐
│ 1. 全局时间映射    │  globalTime=9.8s → 片段B(localTime=4.8s)
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 2. 解码器调度      │  片段A: standby, 片段B: active, 片段C: preloading
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 3. 帧解码         │  demuxer.seekTo(4.8s) → 关键帧@3.0s
│                  │  decode 3.0s→3.03s→...→4.8s (约54帧)
│                  │  取最后一帧作为目标帧
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 4. Worker → 主线程 │  VideoFrame via Transferable（零拷贝）
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 5. Canvas 渲染    │  ctx.drawImage(frame) + 分辨率归一化
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 6. 预加载下一片段   │  片段C 距离 0.2s → 触发预解码首帧
└──────────────────┘
```

---

## 十四、方案对比总结

| 维度 | WebCodecs 方案 | WASM FFmpeg 方案 | 混合方案（推荐） |
|------|---------------|-----------------|----------------|
| **预览性能** | 优秀（硬件加速） | 一般（CPU 软解） | 优秀 |
| **格式兼容** | 受限于浏览器支持 | 几乎全格式 | 全格式 |
| **浏览器支持** | Chrome 94+/Safari 16.4+ | 全部现代浏览器 | 全部 |
| **Seek 速度** | 快（硬件 seek） | 中等 | 快 |
| **导出质量** | 高（可控编码参数） | 高（FFmpeg 编码链） | 高 |
| **内存占用** | 低（GPU 显存） | 高（WASM 线性内存） | 中等 |
| **实现复杂度** | 中（需手动解封装） | 低（FFmpeg 封装好） | 高 |

**推荐策略**：

- **预览阶段**：WebCodecs 优先（硬件加速解码 → Canvas 渲染），不支持时降级到 WASM FFmpeg
- **导出阶段**：WebCodecs Encoder 优先，复杂格式转换用 WASM FFmpeg
- **音频处理**：Web Audio API + WASM 交叉淡化
- **内存管理**：帧缓冲池 + 解码器滑动窗口 + 预览降采样

---

## 十五、实现原理总结

### 核心思想：虚拟拼接，按需解码

多视频拼接预览的本质**不是**把多个视频文件物理合并成一个新文件，而是建立一层**虚拟时间轴映射**，在播放或导出时实时定位并解码对应片段的帧。

```
                     ┌─────────────────────────────┐
                     │      虚拟拼接时间轴           │
                     │  [0s─5s][5s─10s][10s─20s]   │
                     │   片段A   片段B    片段C      │
                     └──────────┬──────────────────┘
                                │
              ┌─────────────────┼──────────────────┐
              │                 │                   │
    ┌─────────▼──────┐ ┌───────▼────────┐ ┌───────▼────────┐
    │  源视频1.mp4    │ │  源视频2.mp4    │ │  源视频3.mp4    │
    │  [12s─17s]截取  │ │  [0s─5s]截取   │ │  [30s─40s]截取  │
    └────────────────┘ └────────────────┘ └────────────────┘
```

### 五步原理链路

**第一步：时间轴映射**

将多个片段按顺序排列在统一时间轴上，建立 `全局时间 → (源文件, 本地时间)` 的映射。播放头在任意位置时，O(n) 查找即可定位到具体片段和帧位置。

```
globalTime = 7.5s
→ 落在片段B [5s, 10s) 区间
→ localTime = 源视频2 的 (7.5 - 5 + 0) = 2.5s 处
```

**第二步：按需解码**

不预先解码全部帧，而是根据播放头位置**实时按需解码**：

- 优先使用 **WebCodecs**（浏览器原生 API，GPU 硬件加速解码）
- 不支持的格式降级到 **WASM FFmpeg**（编译为 WebAssembly 的 FFmpeg，纯 CPU 软解）
- 解码前先通过 **mp4box.js 解封装**，提取编码数据包（NAL Units）送入解码器

**第三步：关键帧 Seek**

视频采用帧间压缩（I/P/B 帧），Seek 到目标时间必须经过关键帧：

```
源视频帧序列：
I --- P --- P --- P --- I --- P --- P --- P --- I
0s   0.5s  1s   1.5s  2s   2.5s  3s   3.5s  4s

Seek 到 3.2s 的实际过程：
1. 二分查找最近的前置关键帧 → I@2s
2. 从 2s 开始连续解码：I(2s) → P(2.5s) → P(3s) → P(3.2s) ✓
3. 丢弃中间帧，只取 3.2s 的帧用于渲染
```

关键帧越密集 Seek 越快，但文件越大。通常视频每 2 秒一个关键帧（GOP=60@30fps）。

**第四步：片段无缝衔接**

片段边界是最容易出问题的地方，需要解决三个问题：

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| **黑帧** | 解码器切换有延迟，下一帧还没解出来 | 提前 500ms 预解码下一片段首帧，缓存在内存中 |
| **音频爆破** | 两段音频采样值不连续，产生阶跃脉冲 | 片段边界做 20ms 交叉淡入淡出（crossfade） |
| **时间戳跳变** | 新片段时间戳从 0 开始，破坏连续性 | 将每帧的原始时间戳重映射到全局时间轴坐标 |

**第五步：渲染与导出**

预览和导出采用不同路径：

```
预览路径（实时，要求 <16ms/帧）：
  解码帧 → ctx.drawImage(frame) → Canvas 显示
  特点：GPU 渲染，按需单帧，可降采样到 720p

导出路径（离线，要求质量优先）：
  逐帧遍历全局时间轴
  → 解码每帧 → 分辨率归一化 → VideoEncoder 编码
  → MP4Muxer 封装 → Blob 下载
  特点：全分辨率，全帧率，WebCodecs 或 WASM FFmpeg 编码
```

### 关键技术选型决策树

```
浏览器是否支持 WebCodecs？
├─ 是 → 硬件加速解码（GPU，性能最优）
│       └─ 需要搭配 mp4box.js 做解封装
└─ 否 → WASM FFmpeg 软解码（CPU，兼容性最优）
         └─ FFmpeg 自带解封装，无需额外库

预览 vs 导出：
├─ 预览 → 解码器滑动窗口（同时 ≤3 个实例）
│         帧缓冲池预分配（30帧环形复用）
│         降采样到 720p（省 55% 内存）
└─ 导出 → 逐帧顺序解码 + 编码
           全分辨率处理
           Worker 线程执行，不阻塞 UI
```

### 一句话总结

> **WebAssembly 多视频拼接预览的核心原理是：不做物理拼接，而是通过虚拟时间轴映射，在播放/导出时实时定位对应片段，按需解码渲染，配合预加载、交叉淡化和时间戳重映射实现无缝衔接。**
