# 大量图片同时加载优化方案

## 一、懒加载（Lazy Loading）

### 1.1 原生懒加载

```html
<img src="photo.jpg" loading="lazy" />
```

### 1.2 Intersection Observer 实现

```js
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const img = entry.target;
      img.src = img.dataset.src;
      observer.unobserve(img);
    }
  });
}, { rootMargin: '0px 0px 300px 0px' }); // 底部提前 300px 触发

document.querySelectorAll('img[data-src]').forEach(img => observer.observe(img));
```

### 1.3 rootMargin 取值依据

```
用户平均滚动速度 ≈ 2000-4000 px/s（快速滑动）
图片平均加载时间 ≈ 200-500ms（CDN + 压缩后）
预加载距离 = 滚动速度 × 加载时间 = 4000 × 0.5 = 2000px

建议 rootMargin: 1~2 屏高度（约 800~2000px）
```

### 1.4 懒加载的三个层次

```
Layer 1: DOM 级懒加载
  └─ 图片不在视口内，不设置 src（不发请求）

Layer 2: 组件级懒加载
  └─ 整个图片卡片组件不挂载（配合虚拟列表）

Layer 3: 数据级懒加载
  └─ 图片 URL 都不请求，滚动到附近才请求接口拿 URL
```

**Layer 3 示例（无限滚动 + 分页）：**

```js
class ImageFeed {
  constructor() {
    this.page = 1;
    this.buffer = [];        // 已获取但未渲染的 URL
    this.rendered = [];       // 已渲染的
    this.fetching = false;
  }

  async prefetchNextPage() {
    if (this.fetching) return;
    this.fetching = true;
    const urls = await fetch(`/api/images?page=${++this.page}`).then(r => r.json());
    this.buffer.push(...urls);
    this.fetching = false;
  }

  checkBuffer(visibleCount) {
    if (this.buffer.length < visibleCount * 2) {
      this.prefetchNextPage();
    }
  }
}
```

---

## 二、虚拟滚动深入原理

### 2.1 核心计算模型

```
┌──────────────────────────┐
│      overscan top        │  ← 缓冲区（防止快速滚动白屏）
├──────────────────────────┤
│                          │
│     visible area         │  ← 实际渲染的 DOM 节点
│                          │
├──────────────────────────┤
│     overscan bottom      │  ← 缓冲区
├──────────────────────────┤
│                          │
│  padding (空白占位)       │  ← 用 padding/transform 撑开滚动高度
│                          │
└──────────────────────────┘
```

```js
function getVisibleRange(scrollTop, containerHeight, itemHeight, totalCount, overscan = 5) {
  const startIndex = Math.floor(scrollTop / itemHeight);
  const endIndex = Math.min(
    Math.ceil((scrollTop + containerHeight) / itemHeight),
    totalCount - 1
  );

  return {
    start: Math.max(0, startIndex - overscan),
    end: Math.min(totalCount - 1, endIndex + overscan),
    offsetY: Math.max(0, startIndex - overscan) * itemHeight
  };
}
```

### 2.2 不定高图片的虚拟滚动（难点）

图片未加载前不知道真实高度，这是虚拟列表最难的场景：

```js
class DynamicHeightVirtualList {
  constructor() {
    this.heightCache = new Map();   // index → 实际高度
    this.estimatedHeight = 300;     // 预估高度
    this.positionCache = [];        // index → top 位置（前缀和）
  }

  onItemResize(index, newHeight) {
    const oldHeight = this.heightCache.get(index) || this.estimatedHeight;
    if (Math.abs(oldHeight - newHeight) < 2) return; // 避免抖动

    this.heightCache.set(index, newHeight);
    this.recalcPositionsFrom(index);
  }

  getItemTop(index) {
    if (this.positionCache[index] !== undefined) return this.positionCache[index];

    let top = 0;
    for (let i = 0; i < index; i++) {
      top += this.heightCache.get(i) || this.estimatedHeight;
    }
    this.positionCache[index] = top;
    return top;
  }

  // 二分查找当前 scrollTop 对应的 startIndex
  findStartIndex(scrollTop) {
    let low = 0, high = this.totalCount - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const top = this.getItemTop(mid);
      if (top < scrollTop) low = mid + 1;
      else high = mid - 1;
    }
    return low;
  }
}
```

### 2.3 瀑布流虚拟滚动

```js
class WaterfallVirtualList {
  constructor(columnCount = 3) {
    this.columns = Array.from({ length: columnCount }, () => []);
    this.columnHeights = new Array(columnCount).fill(0);
  }

  // 新图片分配到最矮的列
  addItem(item) {
    const shortestCol = this.columnHeights.indexOf(Math.min(...this.columnHeights));
    const top = this.columnHeights[shortestCol];

    this.columns[shortestCol].push({
      ...item,
      top,
      left: shortestCol * (100 / this.columns.length),
      column: shortestCol
    });

    this.columnHeights[shortestCol] += item.height + this.gap;
  }

  getVisibleItems(scrollTop, viewportHeight) {
    const top = scrollTop - 200;
    const bottom = scrollTop + viewportHeight + 200;

    return this.columns.flatMap(col =>
      col.filter(item => item.top + item.height > top && item.top < bottom)
    );
  }
}
```

---

## 三、图片格式与压缩

| 策略 | 效果 |
|------|------|
| **WebP / AVIF** | 比 JPEG 体积减少 25-50% |
| **响应式图片** `srcset` | 按设备分辨率加载不同尺寸 |
| **渐进式 JPEG** | 先显示模糊轮廓，逐步清晰 |
| **缩略图 → 原图** | 列表用小图，点击加载大图 |

```html
<picture>
  <source srcset="photo.avif" type="image/avif" />
  <source srcset="photo.webp" type="image/webp" />
  <img src="photo.jpg" alt="fallback" />
</picture>
```

---

## 四、图片解码与渲染管线

### 4.1 浏览器图片处理流程

```
网络下载 → 解码(decode) → 位图(bitmap) → 合成(composite) → 绘制(paint)
   ↓            ↓              ↓              ↓
 可优化      主线程阻塞      内存占用       GPU 上传

一张 4000×3000 JPEG:
  文件大小: ~2MB
  解码后位图: 4000 × 3000 × 4bytes = 48MB（RGBA）
  解码耗时: 50-200ms（主线程）
```

### 4.2 异步解码 — 避免主线程卡顿

```js
// ❌ 同步解码（阻塞主线程，造成掉帧）
img.src = url;
document.body.appendChild(img);

// ✅ 异步解码（decode 在非主线程完成）
const img = new Image();
img.src = url;
await img.decode();  // 解码完成后再插入 DOM，不会卡顿
document.body.appendChild(img);
```

### 4.3 createImageBitmap — Worker 中解码

```js
// 主线程
const response = await fetch(imageUrl);
const blob = await response.blob();

// 在 Worker 中解码 + 缩放
const bitmap = await createImageBitmap(blob, {
  resizeWidth: 400,
  resizeHeight: 300,
  resizeQuality: 'medium'  // low | medium | high | pixelated
});

// 直接绘制到 Canvas（零拷贝）
const ctx = canvas.getContext('2d');
ctx.drawImage(bitmap, 0, 0);
bitmap.close(); // 释放内存
```

### 4.4 内存管理 — LRU 缓存

```
问题：1000 张图全部解码 → 48GB 位图内存 → 浏览器崩溃
解决：配合虚拟滚动，离开视口的图片释放位图
```

```js
class ImageMemoryManager {
  constructor(maxCached = 50) {
    this.cache = new Map();  // url → { bitmap, lastAccess }
    this.maxCached = maxCached;
  }

  async load(url) {
    if (this.cache.has(url)) {
      const entry = this.cache.get(url);
      entry.lastAccess = Date.now();
      return entry.bitmap;
    }

    const res = await fetch(url);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);

    this.cache.set(url, { bitmap, lastAccess: Date.now() });
    this.evictIfNeeded();
    return bitmap;
  }

  evictIfNeeded() {
    if (this.cache.size <= this.maxCached) return;

    const sorted = [...this.cache.entries()]
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

    while (this.cache.size > this.maxCached) {
      const [url, entry] = sorted.shift();
      entry.bitmap.close();  // 释放 GPU/内存
      this.cache.delete(url);
    }
  }
}
```

---

## 五、网络层优化

### 5.1 并发控制

```js
async function loadWithConcurrency(urls, limit = 6) {
  const executing = new Set();
  for (const url of urls) {
    const p = fetch(url).then(r => r.blob()).finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(executing);
}
```

### 5.2 HTTP/1.1 vs HTTP/2 vs HTTP/3

```
HTTP/1.1:
  └─ 同域 6 连接限制
  └─ 队头阻塞（HOL blocking）
  └─ 优化手段：域名分片（img1.cdn.com, img2.cdn.com）

HTTP/2:
  └─ 单连接多路复用（理论无限并发）
  └─ 实际受 TCP 拥塞控制限制
  └─ 服务端推送（可预推关键图片）
  └─ ⚠️ TCP 层队头阻塞仍存在

HTTP/3 (QUIC):
  └─ 基于 UDP，无队头阻塞
  └─ 0-RTT 建连
  └─ 独立流，丢包不影响其他图片
  └─ 弱网环境优势明显（移动端）
```

### 5.3 自适应加载策略

```js
class AdaptiveImageLoader {
  constructor() {
    this.loadTimes = [];
    this.concurrency = 6;
  }

  recordLoadTime(ms) {
    this.loadTimes.push(ms);
    if (this.loadTimes.length > 20) this.loadTimes.shift();
    this.adjustConcurrency();
  }

  adjustConcurrency() {
    const avg = this.loadTimes.reduce((a, b) => a + b, 0) / this.loadTimes.length;

    if (avg < 100) {
      this.concurrency = Math.min(20, this.concurrency + 2);  // 网络好，加并发
    } else if (avg > 500) {
      this.concurrency = Math.max(2, this.concurrency - 2);   // 网络差，减并发
    }
  }

  getQuality() {
    const connection = navigator.connection;
    if (!connection) return 'high';

    if (connection.effectiveType === '4g' && !connection.saveData) return 'high';
    if (connection.effectiveType === '3g') return 'medium';
    return 'low';
  }

  getImageUrl(baseUrl) {
    const quality = this.getQuality();
    const params = {
      high:   'w=1200&q=85&fm=webp',
      medium: 'w=600&q=70&fm=webp',
      low:    'w=300&q=50&fm=webp'
    };
    return `${baseUrl}?${params[quality]}`;
  }
}
```

### 5.4 请求优先级调度

```js
class PriorityImageQueue {
  constructor(concurrency = 6) {
    this.queues = {
      critical: [],  // 首屏 hero 图
      high: [],      // 视口内图片
      low: []        // 预加载图片
    };
    this.running = 0;
    this.concurrency = concurrency;
  }

  enqueue(url, priority = 'high') {
    return new Promise((resolve, reject) => {
      this.queues[priority].push({ url, resolve, reject });
      this.flush();
    });
  }

  async flush() {
    if (this.running >= this.concurrency) return;

    const task = this.queues.critical.shift()
              || this.queues.high.shift()
              || this.queues.low.shift();

    if (!task) return;

    this.running++;
    try {
      const img = new Image();
      img.src = task.url;
      await img.decode();
      task.resolve(img);
    } catch (e) {
      task.reject(e);
    } finally {
      this.running--;
      this.flush();
    }
  }

  // 滚动时：取消低优先级，提升新进入视口的优先级
  reprioritize(enteringViewport, leavingViewport) {
    leavingViewport.forEach(url => {
      const idx = this.queues.high.findIndex(t => t.url === url);
      if (idx >= 0) {
        const [task] = this.queues.high.splice(idx, 1);
        this.queues.low.push(task);
      }
    });

    enteringViewport.forEach(url => {
      const idx = this.queues.low.findIndex(t => t.url === url);
      if (idx >= 0) {
        const [task] = this.queues.low.splice(idx, 1);
        this.queues.high.unshift(task);
      }
    });
  }
}
```

---

## 六、缓存策略

### 6.1 HTTP 缓存

```
强缓存: Cache-Control: max-age=31536000, immutable（文件名带 hash）
协商缓存: ETag / Last-Modified（兜底）
```

### 6.2 Service Worker 缓存

```js
self.addEventListener('fetch', event => {
  if (event.request.destination === 'image') {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  }
});
```

---

## 七、渲染层优化

### 7.1 合成层优化

```css
.image-item {
  will-change: transform;
  contain: layout style paint;
}

/*
  ⚠️ 注意：过多合成层会消耗 GPU 显存
  1000 个 400×300 的合成层 ≈ 1000 × 0.48MB ≈ 480MB GPU 显存
  所以只对视口内的图片提升合成层
*/
```

### 7.2 CSS contain — 限制重排范围

```css
.image-card {
  contain: content;
  /*
    content = layout + style + paint
    告诉浏览器：这个元素内部变化不影响外部布局
    浏览器可跳过该元素外部的重排计算
  */
}
```

### 7.3 content-visibility: auto — 浏览器原生虚拟渲染

```css
.image-item {
  content-visibility: auto;
  contain-intrinsic-size: auto 300px;
}

/*
  效果：
  - 离屏元素跳过 layout、paint、style 计算
  - DOM 仍存在（可搜索、可访问性保留）
  - 浏览器自动管理渲染/跳过

  适用场景：
  - 图片数量 100-500 张（DOM 节点可接受）
  - 不需要手写虚拟滚动
  - Chrome 85+、Edge 85+
*/
```

---

## 八、占位与体验优化

| 方案 | 说明 |
|------|------|
| **骨架屏** | 灰色块占位，避免布局抖动 |
| **BlurHash / LQIP** | 极小的模糊缩略图作为占位（~100 bytes） |
| **固定宽高比** | `aspect-ratio: 16/9` 防止 CLS |
| **渐显动画** | `opacity 0→1` 过渡，加载完成时淡入 |

```css
img {
  aspect-ratio: 16 / 9;
  background: #f0f0f0;
  transition: opacity 0.3s;
}
img[data-loaded] { opacity: 1; }
```

### 预加载与优先级提示

```html
<!-- 首屏关键图片预加载 -->
<link rel="preload" as="image" href="hero.webp" fetchpriority="high" />

<!-- 非关键图片降低优先级 -->
<img src="bg.jpg" fetchpriority="low" />
```

---

## 九、完整架构设计

### 万级图片画廊架构

```
                  ┌─────────────────────────┐
                  │     应用层 (React/Vue)    │
                  │  <VirtualGallery />      │
                  └──────────┬──────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
    ┌─────────▼──────┐ ┌────▼─────┐ ┌──────▼───────┐
    │ 虚拟滚动引擎    │ │ 懒加载器  │ │ 优先级队列    │
    │ - 可见区间计算   │ │ - IO观察  │ │ - critical   │
    │ - 不定高处理    │ │ - 预加载  │ │ - high/low   │
    │ - 瀑布流布局    │ │ - 占位符  │ │ - 取消/升降级 │
    └─────────┬──────┘ └────┬─────┘ └──────┬───────┘
              │              │              │
              └──────────────┼──────────────┘
                             │
                  ┌──────────▼──────────────┐
                  │      图片处理管线         │
                  │  - Worker 池解码         │
                  │  - createImageBitmap     │
                  │  - 内存 LRU 缓存         │
                  │  - 自适应质量选择         │
                  └──────────┬──────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
    ┌─────────▼──────┐ ┌────▼─────┐ ┌──────▼───────┐
    │  CDN 层        │ │ SW Cache │ │ HTTP/2+      │
    │  - 图片裁剪    │ │ - 离线   │ │ - 多路复用    │
    │  - 格式转换    │ │ - 缓存   │ │ - 优先级      │
    │  - 质量压缩    │ │ - 预缓存 │ │ - 服务端推送  │
    └────────────────┘ └──────────┘ └──────────────┘
```

---

## 十、性能指标参考

```
目标指标（电商列表页，1000+ 商品图）：

┌─────────────────────────┬──────────┬──────────┐
│ 指标                     │ 优化前    │ 优化后    │
├─────────────────────────┼──────────┼──────────┤
│ 首屏加载时间 (FCP)       │ 3.2s     │ 0.8s     │
│ 最大内容绘制 (LCP)       │ 4.5s     │ 1.2s     │
│ 累积布局偏移 (CLS)       │ 0.35     │ 0.02     │
│ 滚动帧率 (FPS)           │ 30-45    │ 55-60    │
│ 内存占用                 │ 1.2GB    │ 180MB    │
│ 首屏请求数               │ 80+      │ 8-12     │
│ 总传输体积               │ 50MB     │ 6MB      │
└─────────────────────────┴──────────┴──────────┘

关键优化收益来源：
  FCP/LCP: 懒加载 + WebP + CDN
  CLS:     固定宽高比 + 占位符
  FPS:     虚拟滚动 + 合成层 + 异步解码
  内存:    LRU 缓存 + bitmap.close()
  请求数:  懒加载 + HTTP/2
  体积:    WebP/AVIF + 响应式 + 质量自适应
```

---

## 十一、面试回答框架

按 **网络 → 资源 → 渲染 → 体验** 四层递进：

```
1. 【减少请求】懒加载、虚拟滚动、分页
2. 【减小体积】WebP/AVIF、响应式 srcset、CDN 裁剪压缩
3. 【加速传输】HTTP/2 多路复用、CDN、强缓存、Service Worker
4. 【优化解码】img.decode()、createImageBitmap、Worker 解码
5. 【控制内存】LRU 缓存、bitmap.close()、虚拟滚动卸载 DOM
6. 【渲染性能】content-visibility、CSS contain、合成层提升
7. 【用户体验】BlurHash 占位、渐进式加载、骨架屏、固定宽高比
8. 【自适应】Network API 感知网速、动态调整质量和并发数
```

每一层说清 **问题 → 方案 → 原理 → 量化效果**，展示系统性思维。
