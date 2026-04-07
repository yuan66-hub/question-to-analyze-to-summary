# 多文件预览性能优化：架构设计与渲染策略

## 核心问题

在线文档平台、网盘、IM 聊天中经常需要预览多种格式文件（图片、PDF、Office、视频、代码等）。核心挑战：

1. **格式多样** — 不同文件类型需要不同的解析/渲染引擎
2. **文件体积大** — 高清图片、长 PDF、大视频会阻塞加载
3. **内存压力** — 同时打开多个预览实例容易 OOM
4. **首屏延迟** — 用户期望秒开，实际渲染链路长

---

## 一、整体架构设计

### 统一预览架构

```
┌──────────────────────────────────────────────┐
│                  PreviewManager               │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │ FileType  │  │ Renderer │  │  Resource   │ │
│  │ Detector  │→ │ Registry │→ │  Scheduler  │ │
│  └──────────┘  └──────────┘  └────────────┘ │
│       ↓              ↓              ↓        │
│  MIME + magic   懒加载渲染器    优先级队列    │
│  bytes 双检测   按需注册        带宽控制      │
└──────────────────────────────────────────────┘
         ↓                ↓              ↓
   ┌──────────┐  ┌──────────────┐  ┌─────────┐
   │ 图片渲染器 │  │ PDF/Office    │  │ 视频播放 │
   │ Canvas    │  │ 渲染器        │  │ 器      │
   └──────────┘  └──────────────┘  └─────────┘
```

### 渲染器注册表模式

```ts
type RendererFactory = () => Promise<{ default: PreviewRenderer }>;

interface PreviewRenderer {
  supports(mime: string): boolean;
  render(container: HTMLElement, file: FileSource): Promise<void>;
  destroy(): void;
}

// 按需注册，避免一次性加载所有渲染引擎
const rendererRegistry = new Map<string, RendererFactory>([
  ['image/*',       () => import('./renderers/ImageRenderer')],
  ['application/pdf', () => import('./renderers/PDFRenderer')],
  ['video/*',       () => import('./renderers/VideoRenderer')],
  ['text/*',        () => import('./renderers/CodeRenderer')],
  ['application/vnd.openxmlformats*', () => import('./renderers/OfficeRenderer')],
]);

async function getRenderer(mime: string): Promise<PreviewRenderer> {
  for (const [pattern, factory] of rendererRegistry) {
    if (matchMime(mime, pattern)) {
      const mod = await factory();
      return new mod.default();
    }
  }
  // fallback: 二进制 hex 预览或下载提示
  const fallback = await import('./renderers/FallbackRenderer');
  return new fallback.default();
}
```

### 文件类型检测（双重校验）

```ts
// 不能只信 Content-Type，需要读 magic bytes 二次确认
async function detectFileType(file: File | Blob): Promise<string> {
  // 1. 先看 MIME
  if (file.type && file.type !== 'application/octet-stream') {
    return file.type;
  }

  // 2. 读前 16 字节做 magic bytes 检测
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());

  // PNG: 89 50 4E 47
  if (header[0] === 0x89 && header[1] === 0x50 &&
      header[2] === 0x4E && header[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (header[0] === 0xFF && header[1] === 0xD8) return 'image/jpeg';
  // PDF: 25 50 44 46 (%PDF)
  if (header[0] === 0x25 && header[1] === 0x50 &&
      header[2] === 0x44 && header[3] === 0x46) return 'application/pdf';
  // ZIP-based (docx/xlsx/pptx): 50 4B 03 04
  if (header[0] === 0x50 && header[1] === 0x4B &&
      header[2] === 0x03 && header[3] === 0x04) {
    return detectOfficeType(file); // 进一步解析 [Content_Types].xml
  }

  return 'application/octet-stream';
}
```

---

## 二、图片预览优化

### 1. 渐进式加载策略

```
用户点击 → 缩略图(模糊) → 中等质量 → 原图
  0ms        50ms           300ms      按需
```

```ts
class ImageRenderer implements PreviewRenderer {
  private controller = new AbortController();

  async render(container: HTMLElement, file: FileSource) {
    const img = document.createElement('img');
    img.decoding = 'async';           // 不阻塞主线程解码
    img.loading = 'lazy';             // 视口外延迟加载
    img.fetchPriority = 'low';        // 非当前预览降优先级

    // 阶段 1：先显示缩略图（服务端已生成，< 5KB）
    img.src = file.thumbnailUrl;
    container.appendChild(img);

    // 阶段 2：加载中等质量版本
    const mediumUrl = file.url + '?w=800&q=75';
    await this.preload(mediumUrl);
    img.src = mediumUrl;

    // 阶段 3：用户缩放时才加载原图
    this.setupZoomLoader(img, file.url);
  }

  private preload(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'image';
      link.href = url;
      link.onload = () => resolve();
      link.onerror = reject;
      document.head.appendChild(link);
    });
  }

  destroy() {
    this.controller.abort();
  }
}
```

### 2. 大图虚拟滚动（图片列表场景）

```ts
// 核心思路：只渲染视口内 ± buffer 区域的图片
function useVirtualImageList(images: ImageItem[], containerRef: RefObject<HTMLElement>) {
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 10 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const idx = Number(entry.target.dataset.index);
          if (entry.isIntersecting) {
            // 进入视口：触发加载
            loadImage(idx);
          } else {
            // 离开视口：释放 Blob URL，回收内存
            revokeImage(idx);
          }
        });
      },
      { root: container, rootMargin: '200px' } // 预加载 buffer
    );

    // 为每个占位元素注册观察
    container.querySelectorAll('[data-index]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [images]);

  return visibleRange;
}
```

### 3. 超大图片 Tile 渲染

对于卫星图、设计稿等超大图片（> 10000px），整张解码会爆内存：

```ts
// 分块加载 + Canvas 拼接（类似地图瓦片）
class TileImageRenderer {
  private canvas: OffscreenCanvas;
  private tileSize = 512;

  async render(imageUrl: string, viewport: Rect) {
    // 只请求视口覆盖的瓦片
    const tiles = this.calculateVisibleTiles(viewport);

    const results = await Promise.all(
      tiles.map(tile =>
        fetch(`${imageUrl}?x=${tile.x}&y=${tile.y}&w=${this.tileSize}&h=${this.tileSize}`)
          .then(r => r.blob())
          .then(b => createImageBitmap(b))
      )
    );

    const ctx = this.canvas.getContext('2d')!;
    results.forEach((bitmap, i) => {
      ctx.drawImage(bitmap, tiles[i].x, tiles[i].y);
      bitmap.close(); // 及时释放 ImageBitmap
    });
  }
}
```

---

## 三、PDF 预览优化

### 1. 按需渲染 + 分页加载

```ts
// 基于 pdf.js，核心优化：只渲染可见页
class PDFRenderer implements PreviewRenderer {
  private pdfDoc: PDFDocumentProxy | null = null;
  private pageCache = new LRUCache<number, HTMLCanvasElement>(5); // 缓存最近 5 页
  private renderingPages = new Set<number>();

  async render(container: HTMLElement, file: FileSource) {
    // 1. Range Request 加载，不需要下载完整文件
    const loadingTask = pdfjsLib.getDocument({
      url: file.url,
      rangeChunkSize: 65536,          // 64KB 分块
      disableAutoFetch: true,          // 禁止自动获取全部数据
      disableStream: false,            // 启用流式传输
    });

    this.pdfDoc = await loadingTask.promise;

    // 2. 先渲染第一页
    await this.renderPage(1, container);

    // 3. 监听滚动，按需渲染其他页
    this.setupScrollObserver(container);
  }

  private async renderPage(pageNum: number, container: HTMLElement) {
    if (this.renderingPages.has(pageNum)) return; // 防止重复渲染
    this.renderingPages.add(pageNum);

    // 检查缓存
    if (this.pageCache.has(pageNum)) {
      this.attachCanvas(this.pageCache.get(pageNum)!, pageNum, container);
      return;
    }

    const page = await this.pdfDoc!.getPage(pageNum);
    const viewport = page.getViewport({ scale: this.calculateScale(container) });

    // 使用 OffscreenCanvas 在 Worker 中渲染（不阻塞主线程）
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
      canvasContext: canvas.getContext('2d')!,
      viewport,
    }).promise;

    this.pageCache.set(pageNum, canvas);
    this.attachCanvas(canvas, pageNum, container);
    this.renderingPages.delete(pageNum);
  }

  private setupScrollObserver(container: HTMLElement) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageNum = Number(entry.target.dataset.page);
            this.renderPage(pageNum, container);
          }
        }
      },
      { root: container, rootMargin: '100%' } // 预渲染上下各一屏
    );

    // 为每一页创建占位 div
    for (let i = 1; i <= this.pdfDoc!.numPages; i++) {
      const placeholder = document.createElement('div');
      placeholder.dataset.page = String(i);
      placeholder.style.height = `${this.estimatePageHeight(i)}px`;
      container.appendChild(placeholder);
      observer.observe(placeholder);
    }
  }

  destroy() {
    this.pdfDoc?.destroy();
    this.pageCache.clear();
  }
}
```

### 2. PDF 文字层优化

```ts
// 文字层独立渲染，支持复制和搜索
async function renderTextLayer(page: PDFPageProxy, container: HTMLElement, viewport: PDFPageViewport) {
  const textContent = await page.getTextContent();
  const textDiv = document.createElement('div');
  textDiv.className = 'pdf-text-layer';

  // pdf.js 内置的文字层渲染
  pdfjsLib.renderTextLayer({
    textContentSource: textContent,
    container: textDiv,
    viewport,
    textDivs: [],
  });

  // 关键：文字层绝对定位在 canvas 上方，透明但可选中
  textDiv.style.cssText = `
    position: absolute; top: 0; left: 0;
    width: ${viewport.width}px;
    height: ${viewport.height}px;
    opacity: 0.25;           /* 选中时可见 */
    mix-blend-mode: multiply;
  `;
  container.appendChild(textDiv);
}
```

---

## 四、Office 文档预览

### 方案对比

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|---------|
| 服务端转 PDF/图片 | 格式保真、前端简单 | 需要服务端资源、转换延迟 | 生产环境首选 |
| 前端 JS 解析 (docx-preview, SheetJS) | 无服务端依赖 | 复杂格式支持差、大文件卡顿 | 轻量预览 |
| iframe 嵌入 Office Online | 功能完整 | 依赖微软服务、文件需公网可达 | 企业环境 |
| WebAssembly (LibreOffice compiled) | 格式支持全 | wasm 体积大（~30MB） | 离线场景 |

### 服务端转换 + 前端分页渲染（推荐方案）

```ts
// 服务端：Office → PDF → 按页切图片（或直接返回分页 PDF）
// 前端：复用 PDF 渲染器 or 图片列表渲染

class OfficeRenderer implements PreviewRenderer {
  async render(container: HTMLElement, file: FileSource) {
    // 1. 请求服务端转换（异步，有缓存）
    const convertResult = await this.requestConvert(file.id);

    if (convertResult.format === 'pdf') {
      // 直接用 PDF 渲染器
      const pdfRenderer = await getRenderer('application/pdf');
      return pdfRenderer.render(container, { url: convertResult.url });
    }

    if (convertResult.format === 'images') {
      // 按页图片渲染
      this.renderPageImages(container, convertResult.pages);
    }
  }

  private async requestConvert(fileId: string) {
    // 轮询转换状态（或用 WebSocket 推送）
    const res = await fetch(`/api/preview/convert`, {
      method: 'POST',
      body: JSON.stringify({ fileId, format: 'pdf' }),
    });
    return res.json();
  }
}
```

### 前端轻量 docx 预览（小文件场景）

```ts
// 使用 docx-preview 库，适合 < 5MB 的简单文档
import { renderAsync } from 'docx-preview';

class DocxLiteRenderer implements PreviewRenderer {
  async render(container: HTMLElement, file: FileSource) {
    const response = await fetch(file.url);
    const blob = await response.blob();

    await renderAsync(blob, container, undefined, {
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,           // 分页渲染
      ignoreLastRenderedPageBreak: true,
      experimental: { renderHeaders: true, renderFooters: true },
    });
  }

  destroy() {
    // 清理 DOM
  }
}
```

---

## 五、视频预览优化

### 1. 关键帧预览 + 懒加载播放器

```ts
class VideoRenderer implements PreviewRenderer {
  private hls: Hls | null = null;

  async render(container: HTMLElement, file: FileSource) {
    // 阶段 1：先显示视频封面帧（服务端截取）
    const poster = document.createElement('img');
    poster.src = file.posterUrl;
    poster.className = 'video-poster';
    container.appendChild(poster);

    // 阶段 2：用户点击才加载播放器
    const playBtn = this.createPlayButton();
    container.appendChild(playBtn);

    playBtn.addEventListener('click', () => this.initPlayer(container, file), { once: true });
  }

  private async initPlayer(container: HTMLElement, file: FileSource) {
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata'; // 只预加载元数据

    if (file.url.includes('.m3u8') && Hls.isSupported()) {
      // HLS 流式播放，不需要下载完整文件
      this.hls = new Hls({
        maxBufferLength: 30,          // 最多缓冲 30s
        maxMaxBufferLength: 60,
        startLevel: -1,               // 自适应码率
      });
      this.hls.loadSource(file.url);
      this.hls.attachMedia(video);
    } else {
      video.src = file.url;
    }

    container.innerHTML = '';
    container.appendChild(video);
  }

  destroy() {
    this.hls?.destroy();
  }
}
```

### 2. 视频缩略图时间轴（悬停预览）

```ts
// 服务端预生成雪碧图：每 N 秒截一帧，拼成一张大图
// 前端通过 background-position 定位显示对应帧
function VideoTimeline({ spriteUrl, frameCount, duration }: Props) {
  const frameWidth = 160, frameHeight = 90;
  const cols = 10; // 雪碧图每行 10 帧

  const handleHover = (e: MouseEvent) => {
    const progress = e.offsetX / (e.target as HTMLElement).clientWidth;
    const frameIndex = Math.floor(progress * frameCount);
    const x = (frameIndex % cols) * frameWidth;
    const y = Math.floor(frameIndex / cols) * frameHeight;

    tooltip.style.backgroundImage = `url(${spriteUrl})`;
    tooltip.style.backgroundPosition = `-${x}px -${y}px`;
    tooltip.style.width = `${frameWidth}px`;
    tooltip.style.height = `${frameHeight}px`;
  };
}
```

---

## 六、通用性能优化策略

### 1. 资源调度器（并发控制 + 优先级队列）

```ts
class ResourceScheduler {
  private queue: PriorityQueue<Task> = new PriorityQueue();
  private running = 0;
  private maxConcurrent = 3; // 同时最多 3 个文件在加载

  async schedule<T>(task: () => Promise<T>, priority: number): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      await this.waitForSlot();
    }

    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.processNext();
    }
  }

  // 用户切换预览时，取消低优任务
  cancelByTag(tag: string) {
    this.queue.removeByTag(tag);
  }
}

// 使用：当前预览的文件优先级最高
scheduler.schedule(() => loadFile(currentFile), Priority.HIGH);
scheduler.schedule(() => preloadFile(nextFile), Priority.LOW);
```

### 2. 内存管理与回收

```ts
class PreviewMemoryManager {
  private activeRenderers = new Map<string, PreviewRenderer>();
  private memoryBudget = 200 * 1024 * 1024; // 200MB 上限

  async open(fileId: string, renderer: PreviewRenderer) {
    // 超出预算时，销毁最久未使用的渲染器
    while (this.estimateMemory() > this.memoryBudget && this.activeRenderers.size > 1) {
      const oldest = this.getLRU();
      oldest.destroy();
      this.activeRenderers.delete(oldest.id);
    }

    this.activeRenderers.set(fileId, renderer);
  }

  private estimateMemory(): number {
    // performance.memory (Chrome only) 或估算
    if ('memory' in performance) {
      return (performance as any).memory.usedJSHeapSize;
    }
    // fallback：按渲染器类型估算
    let total = 0;
    for (const r of this.activeRenderers.values()) {
      total += r.estimatedMemory ?? 10 * 1024 * 1024;
    }
    return total;
  }
}
```

### 3. 缓存策略（多级缓存）

```
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│  Memory     │ →  │  Cache API  │ →  │  IndexedDB  │ →  │  CDN/OSS   │
│  (渲染结果) │    │  (HTTP缓存) │    │  (离线缓存) │    │  (源文件)  │
│  < 50MB     │    │  自动管理   │    │  < 500MB    │    │            │
└────────────┘    └────────────┘    └────────────┘    └────────────┘
```

```ts
class PreviewCache {
  private memoryCache = new LRUCache<string, Blob>(20);
  private dbName = 'preview-cache';

  async get(key: string): Promise<Blob | null> {
    // L1: Memory
    if (this.memoryCache.has(key)) return this.memoryCache.get(key)!;

    // L2: Cache API (缓存转换后的结果)
    const cache = await caches.open(this.dbName);
    const cached = await cache.match(key);
    if (cached) {
      const blob = await cached.blob();
      this.memoryCache.set(key, blob);
      return blob;
    }

    // L3: IndexedDB (大文件离线缓存)
    const db = await this.openDB();
    const tx = db.transaction('files', 'readonly');
    const result = await tx.objectStore('files').get(key);
    if (result) {
      this.memoryCache.set(key, result.data);
      return result.data;
    }

    return null;
  }

  async set(key: string, data: Blob, tier: 'memory' | 'persistent' = 'memory') {
    this.memoryCache.set(key, data);
    if (tier === 'persistent') {
      const db = await this.openDB();
      const tx = db.transaction('files', 'readwrite');
      await tx.objectStore('files').put({ key, data, timestamp: Date.now() });
    }
  }
}
```

### 4. Web Worker 解析卸载

```ts
// 将 CPU 密集型解析任务卸载到 Worker
// worker/parseWorker.ts
self.onmessage = async (e: MessageEvent<{ type: string; buffer: ArrayBuffer }>) => {
  const { type, buffer } = e.data;

  switch (type) {
    case 'excel': {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheets = workbook.SheetNames.map(name => ({
        name,
        data: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1 }),
      }));
      self.postMessage({ type: 'excel-parsed', sheets }, []);
      break;
    }
    case 'csv': {
      const text = new TextDecoder().decode(buffer);
      const rows = parseCSV(text); // 自定义解析，流式逐行
      self.postMessage({ type: 'csv-parsed', rows }, []);
      break;
    }
  }
};

// 主线程调用
const worker = new Worker(new URL('./worker/parseWorker.ts', import.meta.url));
worker.postMessage({ type: 'excel', buffer: arrayBuffer }, [arrayBuffer]); // transferable
worker.onmessage = (e) => {
  renderSpreadsheet(e.data.sheets);
};
```

---

## 七、预加载与预测策略

### 1. 相邻文件预加载

```ts
// 文件列表场景：预加载当前文件的前后 N 个
class PreloadStrategy {
  private preloadQueue: AbortController[] = [];

  onFileChange(currentIndex: number, fileList: FileItem[]) {
    // 取消之前的预加载
    this.preloadQueue.forEach(c => c.abort());
    this.preloadQueue = [];

    // 预加载前后各 2 个文件的缩略图 / 首页
    const preloadTargets = [
      fileList[currentIndex + 1],
      fileList[currentIndex - 1],
      fileList[currentIndex + 2],
      fileList[currentIndex - 2],
    ].filter(Boolean);

    for (const file of preloadTargets) {
      const controller = new AbortController();
      this.preloadQueue.push(controller);

      // 只预加载轻量资源（缩略图、PDF 首页、视频封面）
      this.preloadLightweight(file, controller.signal);
    }
  }

  private async preloadLightweight(file: FileItem, signal: AbortSignal) {
    switch (file.category) {
      case 'image':
        await fetch(file.thumbnailUrl, { signal, priority: 'low' as any });
        break;
      case 'pdf':
        // Range Request 只获取首页数据（约前 100KB）
        await fetch(file.url, {
          signal,
          headers: { Range: 'bytes=0-102400' },
          priority: 'low' as any,
        });
        break;
      case 'video':
        await fetch(file.posterUrl, { signal, priority: 'low' as any });
        break;
    }
  }
}
```

### 2. 基于用户行为的智能预加载

```ts
// 追踪用户浏览模式，预测下一个可能打开的文件
class SmartPreloader {
  private viewHistory: number[] = [];

  predict(currentIndex: number, fileCount: number): number[] {
    // 简单策略：判断用户是在向前还是向后浏览
    if (this.viewHistory.length < 2) {
      return [currentIndex + 1]; // 默认预加载下一个
    }

    const lastTwo = this.viewHistory.slice(-2);
    const direction = lastTwo[1] - lastTwo[0];

    if (direction > 0) {
      // 向后浏览，预加载后面 2 个
      return [currentIndex + 1, currentIndex + 2].filter(i => i < fileCount);
    } else {
      // 向前浏览，预加载前面 2 个
      return [currentIndex - 1, currentIndex - 2].filter(i => i >= 0);
    }
  }

  recordView(index: number) {
    this.viewHistory.push(index);
    if (this.viewHistory.length > 10) this.viewHistory.shift();
  }
}
```

---

## 八、错误处理与降级策略

```ts
class PreviewErrorHandler {
  async renderWithFallback(container: HTMLElement, file: FileSource) {
    const strategies = [
      // 1. 原始渲染
      () => this.renderPrimary(container, file),
      // 2. 服务端转换后重试
      () => this.renderConverted(container, file),
      // 3. 纯文本 / hex 展示
      () => this.renderPlainText(container, file),
      // 4. 下载链接兜底
      () => this.renderDownloadFallback(container, file),
    ];

    for (const strategy of strategies) {
      try {
        await strategy();
        return;
      } catch (error) {
        console.warn('Preview fallback:', error);
        continue;
      }
    }
  }

  // 超时保护：避免预览卡死
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Preview timeout after ${ms}ms`)), ms)
      ),
    ]);
  }
}
```

---

## 九、性能指标与监控

### 关键指标

| 指标 | 目标 | 测量方式 |
|------|------|---------|
| 首屏时间 (FCP) | < 1s | 从点击到首帧可见 |
| 完全渲染 (FMP) | < 3s | 内容完全可交互 |
| 内存占用 | < 200MB | performance.memory |
| 渲染器加载 | < 500ms | 动态 import 耗时 |
| 切换延迟 | < 300ms | 文件切换到内容可见 |

### 埋点方案

```ts
class PreviewMetrics {
  private marks = new Map<string, number>();

  start(fileId: string) {
    this.marks.set(fileId, performance.now());
  }

  end(fileId: string, phase: 'fcp' | 'fmp') {
    const start = this.marks.get(fileId);
    if (!start) return;

    const duration = performance.now() - start;
    // 上报
    navigator.sendBeacon('/api/metrics', JSON.stringify({
      event: 'preview_performance',
      fileId,
      phase,
      duration,
      fileType: this.getFileType(fileId),
      timestamp: Date.now(),
    }));
  }
}
```

---

## 十、面试高频追问

**Q：如果用户快速切换文件（连续点击），怎么避免渲染竞态？**

使用请求标记 + AbortController：每次切换时取消上一个文件的所有加载请求和渲染任务，只保留最新一次的渲染结果。关键是给每次渲染分配递增 ID，渲染完成时检查 ID 是否匹配当前。

**Q：PDF 预览如何支持搜索？**

pdf.js 的 `page.getTextContent()` 返回每页文字内容和坐标。建立全文索引后，搜索时高亮对应页的文字层 DOM 元素，并自动滚动到匹配位置。

**Q：移动端预览有什么特殊考量？**

1. 内存更紧张，渲染器缓存数量要更小（LRU 只保留 2-3 页）
2. 用 `<meta name="viewport">` 配合 CSS `touch-action` 处理手势缩放
3. 优先使用系统原生能力（`window.open` 触发系统 PDF 阅读器）
4. 图片用更小的分辨率版本，视频用更低码率

**Q：如何处理加密/受保护的文件？**

服务端在转换时解密，前端只拿到转换后的预览结果（图片或 PDF），不暴露原始文件内容。如果需要前端解密，使用 Web Crypto API 在 Worker 中处理，避免密钥暴露在主线程。

**Q：预览安全怎么保证？**

1. 永远不要用 `innerHTML` 渲染用户文件内容，防 XSS
2. iframe 预览加 `sandbox` 属性限制脚本执行
3. SVG 预览需要清洗 `<script>` 和事件属性
4. CSP 策略限制 `blob:` 和 `data:` URL 的使用范围
