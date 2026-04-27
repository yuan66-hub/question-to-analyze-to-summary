# 单张超大图分块并行加载技术方案

## 一、背景与目标

当页面需要展示单张超大图片时，例如高清设计稿、长图、地图、医学影像、遥感图、全景图或可缩放图片预览，直接加载原图会带来几个问题：

- 首屏等待时间长，用户必须等整张图下载和解码完成后才能看到内容。
- 解码后内存占用远大于文件体积，例如 `8000 x 8000` 图片解码为 RGBA 位图约占 `244MB`。
- 缩放、拖拽、快速移动视口时，浏览器容易出现卡顿、白屏或内存峰值。
- 用户通常只关注当前视口区域，没有必要一次性下载和解码整张原图。

本方案目标：

- 当前视口优先可见，避免整图加载阻塞首屏。
- 支持缩放和拖拽，只加载当前需要的图像区域。
- 支持分块并行加载，并通过调度控制网络、解码和内存压力。
- 明确 HTTP Range 的适用边界，避免把字节分片误用成图像区域分片。

## 二、结论先行

推荐主方案是 **瓦片金字塔（Tile Pyramid）+ CDN + 前端视口调度加载**。

HTTP Range 可以做分块并行下载，但对普通 `JPG/PNG/WebP/AVIF` 图片来说，它只能按字节范围切分文件，不能稳定映射到图像中的某个可独立渲染区域。因此它不适合作为普通大图“局部先显示”的主方案。

推荐选择：

| 场景 | 推荐方案 |
| --- | --- |
| 普通网页大图、Banner、详情图 | `AVIF/WebP + srcset + lazyload + CDN` |
| 超大图、可缩放、可拖拽、只看局部区域 | 瓦片金字塔 |
| 断点续传、下载器、整文件加速 | HTTP Range 分片下载 |
| GeoTIFF、COG、JPEG2000、Pyramidal TIFF 等随机访问格式 | HTTP Range + 文件内部 tile index |

## 三、整体架构

```text
原始大图
  │
  ▼
离线/服务端预处理
  - 生成多级缩略图
  - 切成固定尺寸瓦片
  - 转换为 WebP/AVIF
  - 生成 manifest 元数据
  │
  ▼
对象存储/CDN
  - 长缓存
  - HTTP/2/HTTP/3
  - 按瓦片 URL 命中缓存
  │
  ▼
前端大图查看器
  - 根据缩放级别选择 level
  - 根据视口计算 tile 范围
  - 并发加载视口内瓦片
  - 优先加载中心区域
  - 预加载周边缓冲区
  - LRU 淘汰离屏瓦片
```

## 四、瓦片金字塔方案

### 4.1 数据结构

把一张大图预处理成多个缩放层级，每一层再切成固定尺寸瓦片。

```text
tiles/{imageId}/
  manifest.json
  0/
    0_0.webp
  1/
    0_0.webp
    1_0.webp
  2/
    0_0.webp
    1_0.webp
    0_1.webp
    1_1.webp
  3/
    0_0.webp
    1_0.webp
    2_0.webp
    ...
```

示例 `manifest.json`：

```json
{
  "imageId": "design-001",
  "width": 12000,
  "height": 8000,
  "tileSize": 256,
  "format": "webp",
  "levels": [
    { "level": 0, "scale": 0.125, "width": 1500, "height": 1000 },
    { "level": 1, "scale": 0.25, "width": 3000, "height": 2000 },
    { "level": 2, "scale": 0.5, "width": 6000, "height": 4000 },
    { "level": 3, "scale": 1, "width": 12000, "height": 8000 }
  ]
}
```

### 4.2 后端或构建阶段切图

可以使用 `sharp`、`libvips`、`ImageMagick` 或专门的 Deep Zoom 工具。对于超大图，更推荐 `libvips/sharp`，因为它对大图处理的内存占用更稳定。

核心步骤：

1. 读取原图尺寸。
2. 生成多个缩放层级。
3. 每个层级按 `256 x 256` 或 `512 x 512` 切片。
4. 输出 `WebP/AVIF/JPEG` 瓦片。
5. 生成 `manifest.json`。

简化示例：

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const tileSize = 256;
const levels = [0.125, 0.25, 0.5, 1];

async function generateTiles(inputPath, outputDir) {
  const meta = await sharp(inputPath).metadata();
  const manifest = {
    width: meta.width,
    height: meta.height,
    tileSize,
    format: 'webp',
    levels: []
  };

  for (let level = 0; level < levels.length; level++) {
    const scale = levels[level];
    const width = Math.ceil(meta.width * scale);
    const height = Math.ceil(meta.height * scale);
    const levelDir = path.join(outputDir, String(level));

    await fs.mkdir(levelDir, { recursive: true });

    const resized = sharp(inputPath).resize(width, height);
    const cols = Math.ceil(width / tileSize);
    const rows = Math.ceil(height / tileSize);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const left = col * tileSize;
        const top = row * tileSize;
        const tileWidth = Math.min(tileSize, width - left);
        const tileHeight = Math.min(tileSize, height - top);

        await resized
          .clone()
          .extract({ left, top, width: tileWidth, height: tileHeight })
          .webp({ quality: 80 })
          .toFile(path.join(levelDir, `${col}_${row}.webp`));
      }
    }

    manifest.levels.push({ level, scale, width, height });
  }

  await fs.writeFile(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
}
```

### 4.3 前端视口计算

前端维护当前视口状态：

```ts
type Viewport = {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
};
```

根据 `zoom` 选择最接近的瓦片层级，再根据视口范围计算需要加载的 tile：

```js
function getVisibleTiles(viewport, levelInfo, tileSize, overscan = 1) {
  const scale = levelInfo.scale;
  const x = viewport.x * scale;
  const y = viewport.y * scale;
  const width = viewport.width * scale;
  const height = viewport.height * scale;

  const startCol = Math.max(0, Math.floor(x / tileSize) - overscan);
  const endCol = Math.ceil((x + width) / tileSize) + overscan;
  const startRow = Math.max(0, Math.floor(y / tileSize) - overscan);
  const endRow = Math.ceil((y + height) / tileSize) + overscan;

  const tiles = [];
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      tiles.push({ level: levelInfo.level, col, row });
    }
  }

  return tiles;
}
```

### 4.4 并行加载与优先级调度

并行加载不是越多越好。瓦片数过多时，过高并发会抢占主线程解码、增加内存峰值，并且可能拖慢关键瓦片。

建议：

- HTTP/2/3 下默认并发 `6-12`。
- 视口中心瓦片优先级最高。
- 视口内瓦片优先级高于预加载缓冲区瓦片。
- 用户快速拖拽或缩放时，取消过期请求。
- 已加载瓦片进入 LRU 缓存，离屏过远后释放。

示例调度器：

```js
class TileLoader {
  constructor({ concurrency = 8 } = {}) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.cache = new Map();
    this.controllers = new Map();
  }

  load(tile, priority) {
    const key = this.getKey(tile);
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));

    return new Promise((resolve, reject) => {
      this.queue.push({ tile, priority, resolve, reject });
      this.queue.sort((a, b) => b.priority - a.priority);
      this.flush();
    });
  }

  async flush() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      this.running++;
      this.fetchTile(task).finally(() => {
        this.running--;
        this.flush();
      });
    }
  }

  async fetchTile(task) {
    const key = this.getKey(task.tile);
    const controller = new AbortController();
    this.controllers.set(key, controller);

    try {
      const res = await fetch(this.getUrl(task.tile), {
        signal: controller.signal
      });
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);

      this.cache.set(key, bitmap);
      task.resolve(bitmap);
    } catch (error) {
      task.reject(error);
    } finally {
      this.controllers.delete(key);
    }
  }

  abort(tile) {
    const controller = this.controllers.get(this.getKey(tile));
    if (controller) controller.abort();
  }

  getKey(tile) {
    return `${tile.level}/${tile.col}_${tile.row}`;
  }

  getUrl(tile) {
    return `/tiles/${tile.level}/${tile.col}_${tile.row}.webp`;
  }
}
```

### 4.5 渲染实现选择

可选渲染方式：

| 方式 | 优点 | 缺点 | 适用场景 |
| --- | --- | --- | --- |
| 多个绝对定位 `img` | 实现简单，浏览器原生解码和缓存 | DOM 数量较多时性能下降 | 中等规模图片查看 |
| Canvas 2D | DOM 少，便于统一绘制和缓存控制 | 需要自己管理重绘和坐标 | 大图预览、标注、编辑器 |
| WebGL | 性能上限高，适合频繁缩放和变换 | 实现复杂 | 地图、遥感图、专业图像查看器 |
| OpenSeadragon | 成熟稳定，支持 Deep Zoom | 定制成本取决于业务 | 快速落地超大图查看 |

如果业务只需要浏览、缩放、拖拽，优先使用 `OpenSeadragon`。如果业务还需要标注、绘制、图层混合，推荐 `Canvas/WebGL`。

## 五、HTTP Range 方案边界

### 5.1 Range 能做什么

HTTP Range 可以让客户端请求文件的某个字节区间：

```http
Range: bytes=0-1048575
```

服务端返回：

```http
HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 0-1048575/20971520
Content-Length: 1048576
```

它适合：

- 大文件断点续传。
- 多线程下载器。
- 视频、音频 seek。
- 已知内部索引的随机访问文件格式。
- 云优化 GeoTIFF、JPEG2000、Pyramidal TIFF 等 tile-based 格式。

### 5.2 Range 不适合普通图片局部渲染

对普通 `JPG/PNG/WebP/AVIF` 来说，文件字节范围和图像像素区域不是简单的一一对应关系。请求 `bytes=0-1MB` 并不等于拿到了图片左上角区域。

主要原因：

- 图片是压缩编码流，解码通常依赖文件头、压缩表、块上下文等信息。
- 部分格式虽然内部有块结构，但浏览器 `<img>` 不暴露“只解码某个字节段为局部图像”的能力。
- 前端拿到多个 Range 后，通常仍要合并成完整 Blob，再交给浏览器解码整图。

所以 Range 对普通图片最多优化“整文件下载”的并行性，不能提供瓦片方案那种“当前区域先显示”的体验。

### 5.3 Range 分片下载示例

如果目标是断点续传或整文件并行下载，可以这样实现：

```js
async function fetchRange(url, start, end) {
  const res = await fetch(url, {
    headers: {
      Range: `bytes=${start}-${end}`
    }
  });

  if (res.status !== 206) {
    throw new Error('Server does not support HTTP Range');
  }

  return res.arrayBuffer();
}

async function loadImageByRanges(url, totalSize, chunkSize = 1024 * 1024) {
  const tasks = [];

  for (let start = 0; start < totalSize; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, totalSize - 1);
    tasks.push(fetchRange(url, start, end));
  }

  const chunks = await Promise.all(tasks);
  const blob = new Blob(chunks, { type: 'image/jpeg' });

  return URL.createObjectURL(blob);
}
```

注意：这个方案仍然要等所有分片合并后才能作为普通图片展示，无法按视口区域渐进渲染。

### 5.4 Range + 随机访问图片格式

如果确实希望用 Range 加载图像区域，需要图片格式本身提供 tile index 或 offset table。

典型方案：

```text
前端读取文件头/索引
  │
  ├─ 得到某个 tile 对应的 byte offset 和 byte length
  │
  ▼
HTTP Range 请求该 tile 字节段
  │
  ▼
专用解码器解析 tile
  │
  ▼
Canvas/WebGL 渲染到对应区域
```

这类方案更适合 GIS、遥感、医学影像等专业场景。普通 Web 产品如果没有强随机访问诉求，不建议为了使用 Range 而引入复杂格式和专用解码器。

## 六、缓存策略

### 6.1 CDN 缓存

瓦片 URL 应该稳定、可缓存，并带版本或 hash：

```text
/tiles/design-001/v3/2/10_8.webp
```

推荐响应头：

```http
Cache-Control: public, max-age=31536000, immutable
Content-Type: image/webp
```

如果图片会更新，不要覆盖同一个 URL，而是变更版本号或文件 hash。

### 6.2 前端缓存

前端至少维护两级缓存：

- 浏览器 HTTP 缓存：由 CDN 响应头控制。
- 运行时内存缓存：保存已解码的 `ImageBitmap` 或已加载的 `HTMLImageElement`。

运行时缓存必须有上限：

```js
class LruTileCache {
  constructor(max = 200) {
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const value = this.map.get(key);
    if (!value) return null;

    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, bitmap) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, bitmap);

    while (this.map.size > this.max) {
      const [oldestKey, oldestBitmap] = this.map.entries().next().value;
      if (oldestBitmap && typeof oldestBitmap.close === 'function') {
        oldestBitmap.close();
      }
      this.map.delete(oldestKey);
    }
  }
}
```

## 七、加载体验

建议采用渐进式体验：

1. 首先显示全图低清缩略图，保证用户立即看到整体轮廓。
2. 加载当前视口低层级瓦片，减少明显马赛克。
3. 用户停止缩放或拖拽后，再补充高层级瓦片。
4. 当前视口中心优先，边缘和 overscan 区域次之。
5. 快速交互时降低加载质量或暂停高清瓦片，避免请求风暴。

视觉策略：

- 用低清背景图兜底。
- 高级别瓦片加载完成后覆盖低级别瓦片。
- 设置固定容器尺寸，避免布局抖动。
- 对瓦片淡入可以提升观感，但动画不宜过多，否则会增加合成压力。

## 八、服务端要求

瓦片方案服务端要求：

- 支持上传后异步切图，避免请求链路阻塞。
- 切图任务需要幂等，支持失败重试。
- 生成 manifest，记录原图尺寸、瓦片尺寸、层级、格式。
- 瓦片文件上传对象存储，并通过 CDN 分发。
- 对切图结果使用版本号，避免缓存污染。

HTTP Range 方案服务端要求：

- 返回准确的 `Content-Length`。
- 支持 `Accept-Ranges: bytes`。
- Range 请求返回 `206 Partial Content`。
- 返回正确的 `Content-Range`。
- 对非法 Range 返回 `416 Range Not Satisfiable`。

## 九、异常与降级

| 异常 | 处理策略 |
| --- | --- |
| 某个 tile 加载失败 | 显示低清底图，失败 tile 重试 1-2 次 |
| 用户快速拖拽 | 中止过期请求，仅保留最新视口任务 |
| 网络慢 | 降低 level 或扩大低清图显示时间 |
| 内存过高 | 减小 LRU 缓存数量，释放离屏 `ImageBitmap` |
| CDN 206 不可用 | Range 方案降级为整图下载 |
| 浏览器不支持 AVIF | 降级 WebP/JPEG |
| 浏览器不支持 `createImageBitmap` | 使用 `Image` 解码 |

## 十、性能指标

建议关注以下指标：

- 首屏可见时间：低清图或首批瓦片出现时间。
- 当前视口清晰时间：视口内目标 level 瓦片全部加载完成时间。
- 拖拽帧率：交互过程中是否稳定在 `50-60 FPS`。
- 瓦片失败率：CDN 或网络失败导致的 tile 错误比例。
- 内存峰值：尤其是解码后位图和 GPU 纹理占用。
- 请求取消率：快速交互时是否大量无效请求。
- CDN 命中率：瓦片 URL 是否有效复用缓存。

目标参考：

```text
首屏低清可见：< 500ms
视口高清完成：< 1.5s
拖拽/缩放 FPS：> 50
单页内存峰值：< 300MB，视图片规模调整
瓦片失败率：< 0.5%
CDN 命中率：> 90%
```

## 十一、推荐落地路径

### 阶段 1：基础优化

适用于普通大图：

- 转换 `WebP/AVIF`。
- 使用 `srcset/sizes` 响应式图片。
- 首屏图 `preload`，非首屏图 `lazyload`。
- CDN 长缓存。
- 固定宽高比，避免 CLS。

### 阶段 2：瓦片化查看器

适用于超大图：

- 建立切图任务。
- 生成 `manifest.json`。
- 将瓦片上传 CDN。
- 前端实现视口 tile 计算。
- 增加并发调度、取消请求、LRU 缓存。
- 先用低清整图兜底，再叠加高清瓦片。

### 阶段 3：专业随机访问

仅适用于专业图像格式：

- 使用支持内部 tile index 的图片格式。
- 前端读取索引或由后端返回 offset 信息。
- 通过 HTTP Range 请求对应字节段。
- 使用专用解码器在 Canvas/WebGL 渲染。

## 十二、最终建议

如果目标是让普通网页大图加载更快，不建议直接上 HTTP Range 分片。优先使用图片格式、尺寸、懒加载、CDN 和缓存优化。

如果目标是展示单张超大图，并且支持缩放、拖拽、局部查看，建议采用 **瓦片金字塔方案**。这是 Web 地图、Deep Zoom、大图查看器中最成熟、最容易工程化和缓存优化的路径。

HTTP Range 应作为补充能力使用：用于断点续传、整文件并行下载，或与支持随机访问的专业图片格式结合使用，而不是替代瓦片切图。
