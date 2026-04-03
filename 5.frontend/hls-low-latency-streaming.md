# HLS 与 LL-HLS 低延迟流媒体指南

## 图片/视频下载到解码的优化链路

```
网络请求 → 数据传输 → 缓存 → 解码 → 渲染
```

### 各阶段优化重点

| 阶段 | 优化手段 |
|------|---------|
| 网络请求 | DNS 预解析、preconnect、HTTP/2 多路复用 |
| 数据传输 | WebP/AVIF 格式、响应式图片、HLS 分片 |
| 缓存 | Cache-Control、内容哈希文件名、Service Worker |
| 解码 | `decoding="async"`、`createImageBitmap`、WebCodecs |
| 渲染 | `will-change: transform`、OffscreenCanvas |

**最高 ROI 的三件事：**
1. 换 WebP/AVIF 格式 + 响应式尺寸 — 减少 30-60% 传输量
2. `loading="lazy"` + HLS 分片 — 减少首屏不必要请求
3. `decoding="async"` / `createImageBitmap` — 解码不阻塞主线程

---

## HLS 基础

### 工作原理

```
源视频 → 转码切片 → M3U8 索引文件 + .ts 分片文件 → CDN 分发 → 客户端按需拉取
```

### M3U8 文件结构

**主播放列表（Master Playlist）：**
```m3u8
#EXTM3U
#EXT-X-VERSION:3

#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
720p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p/index.m3u8
```

**媒体播放列表（Media Playlist）：**
```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0

#EXTINF:6.0,
seg000.ts
#EXTINF:6.0,
seg001.ts
#EXT-X-ENDLIST    ← 点播才有，直播没有
```

### FFmpeg 生成 HLS

**静态点播切片：**
```bash
ffmpeg -i input.mp4 \
  -c:v libx264 -c:a aac \
  -hls_time 6 \
  -hls_list_size 0 \
  -hls_segment_filename "seg%03d.ts" \
  output.m3u8
```

**多码率 ABR：**
```bash
ffmpeg -i input.mp4 \
  -filter_complex \
  "[0:v]split=3[v1][v2][v3]; \
   [v1]scale=1920:1080[v1out]; \
   [v2]scale=1280:720[v2out]; \
   [v3]scale=640:360[v3out]" \
  -map "[v1out]" -map 0:a -c:v libx264 -b:v 5M  -hls_time 6 1080p/index.m3u8 \
  -map "[v2out]" -map 0:a -c:v libx264 -b:v 2M  -hls_time 6 720p/index.m3u8  \
  -map "[v3out]" -map 0:a -c:v libx264 -b:v 800k -hls_time 6 360p/index.m3u8
```

**直播滑动窗口：**
```bash
ffmpeg -i rtmp://ingest/live/stream \
  -c:v libx264 -c:a aac \
  -hls_time 2 \
  -hls_list_size 5 \
  -hls_flags delete_segments \
  -hls_segment_filename "seg%d.ts" \
  live.m3u8
```

### hls.js 客户端播放

```js
import Hls from 'hls.js';

const video = document.getElementById('video');

if (Hls.isSupported()) {
  const hls = new Hls({
    autoStartLoad: true,
    startLevel: -1,         // 自动选初始码率
    maxBufferLength: 30,
    liveSyncDurationCount: 3,
  });

  hls.loadSource('https://cdn.example.com/master.m3u8');
  hls.attachMedia(video);

  hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
    console.log('切换到码率等级:', data.level);
  });
} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
  video.src = src; // Safari 原生支持
}
```

---

## LL-HLS 低延迟实现

### 普通 HLS vs LL-HLS

```
普通 HLS：  [录制6s] → [转码] → [上传] → [客户端发现] → [下载] = 15-30s 延迟
LL-HLS：    [录制0.2s部分片] → [立即推送] → 客户端边收边播  = 2-5s 延迟
```

核心思路：**不等整片完成，用 Partial Segment 边生产边消费**

### 三个关键机制

#### 1. Partial Segment（部分分片）

把一个 6 秒分片切成多个 200ms 的 Part，立即可用：

```m3u8
#EXTM3U
#EXT-X-VERSION:9                    ← 必须 v9+
#EXT-X-TARGETDURATION:6
#EXT-X-PART-INF:PART-TARGET=0.2     ← 声明 Part 目标时长 200ms

#EXTINF:6.0,
seg001.ts                           ← 已完成的完整分片

#EXTINF:6.0,
seg002.ts

#EXT-X-PART:DURATION=0.2,URI="seg003.part0.mp4"
#EXT-X-PART:DURATION=0.2,URI="seg003.part1.mp4"
#EXT-X-PART:DURATION=0.2,URI="seg003.part2.mp4"  ← 最新可用

#EXT-X-PRELOAD-HINT:TYPE=PART,URI="seg003.part3.mp4"  ← 预告下一个
```

#### 2. Blocking Playlist Reload（阻塞式刷新）

用长轮询代替定时轮询，服务端有新 Part 时立即响应：

```
# 客户端请求时带上当前已知序号
GET /live.m3u8?_HLS_msn=5&_HLS_part=3

服务端行为：
- part3 已存在 → 立即返回
- 还没生产     → 挂起请求，产出后立刻推送
```

```
时间线：
客户端 ──── GET ?msn=5&part=3 ──────────────→ 服务端（挂起等待）
服务端 ← ← ← ← ← ← ← part3 生产完毕，立即响应 ←
客户端 ──── GET ?msn=5&part=4 ──────────────→ 服务端（挂起等待）
```

#### 3. Rendition Report（码率报告）

M3U8 末尾携带其他码率进度，ABR 切换时无需额外请求：

```m3u8
#EXT-X-RENDITION-REPORT:URI="720p/index.m3u8",LAST-MSN=5,LAST-PART=3
#EXT-X-RENDITION-REPORT:URI="360p/index.m3u8",LAST-MSN=5,LAST-PART=3
```

### 服务端实现

#### 方案一：SRS（推荐）

```bash
docker run --rm -it \
  -p 1935:1935 -p 8080:8080 \
  ossrs/srs:5 ./objs/srs -c conf/llhls.conf
```

```nginx
# llhls.conf
vhost __defaultVhost__ {
  hls {
    enabled       on;
    hls_fragment  6;
    hls_window    60;
    hls_ll_hls    on;
    hls_part      0.2;   # Part 时长 200ms
  }
}
```

#### 方案二：Node.js 自建（阻塞请求核心逻辑）

```js
import express from 'express';
import EventEmitter from 'events';

const app = express();
const bus = new EventEmitter();

const state = { msn: 0, part: 0, playlist: '' };

app.get('/live.m3u8', (req, res) => {
  const clientMsn = parseInt(req.query._HLS_msn ?? -1);
  const clientPart = parseInt(req.query._HLS_part ?? -1);

  const isReady = () =>
    state.msn > clientMsn ||
    (state.msn === clientMsn && state.part >= clientPart);

  if (isReady()) return sendPlaylist(res);

  const onUpdate = () => {
    if (isReady()) {
      bus.off('part-ready', onUpdate);
      sendPlaylist(res);
    }
  };

  bus.on('part-ready', onUpdate);
  req.on('close', () => bus.off('part-ready', onUpdate));
});

function sendPlaylist(res) {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(state.playlist);
}
```

### 客户端（hls.js）

```js
const hls = new Hls({
  lowLatencyMode: true,

  liveSyncDuration: 3,        // 目标延迟：距直播边缘 3s
  liveMaxLatencyDuration: 5,
  lowLatencyMaxPartLoads: 3,  // Part 并发请求数
});

hls.loadSource('https://cdn.example.com/live.m3u8');
hls.attachMedia(video);

// 监控实时延迟
setInterval(() => {
  console.log(`延迟: ${hls.latency.toFixed(2)}s`);
}, 1000);
```

### 延迟构成分析

```
总延迟 = 编码延迟 + Part时长 + 网络RTT + 客户端缓冲

编码延迟:   ~0.5s  (GOP 大小决定)
Part 时长:  ~0.2s
网络 RTT:   ~0.05s (CDN 边缘节点)
客户端缓冲: ~1-2s  (liveSyncDuration 配置)
──────────────────
理论最低:   ~2s
```

**降低编码延迟的关键 FFmpeg 配置：**
```bash
ffmpeg -i input \
  -c:v libx264 \
  -tune zerolatency \       # 禁用 B 帧，减少编码缓冲
  -g 30 \                   # GOP = 1 秒（30fps）
  -sc_threshold 0 \         # 禁止场景切换插入 I 帧
  -x264opts "keyint=30:min-keyint=30:no-scenecut" \
  ...
```

---

## 方案选型对比

| 方案 | 延迟 | 适用场景 |
|------|------|---------|
| 普通 HLS | 15-30s | 点播、无延迟要求直播 |
| LL-HLS | 2-5s | 体育赛事、新闻直播 |
| WebRTC | <1s | 视频通话、互动直播 |
| RTMP 直播 | 1-3s | 极低延迟但规模受限 |

> LL-HLS 是**规模化低延迟**的最佳平衡点，可复用 CDN 基础设施，WebRTC 难以大规模分发。

### 各场景参数配置

| 场景 | 分片时长 | `hls_list_size` | 延迟 |
|------|---------|----------------|------|
| 点播 | 6-10s | 0（全保留） | 不关心 |
| 普通直播 | 2-4s | 5-10 | 10-30s |
| LL-HLS 直播 | 0.2-1s（Part） | 3-5 | 2-5s |
