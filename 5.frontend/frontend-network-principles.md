# 前端网络原理

> 涵盖 HTTP 协议、缓存机制、跨域与安全、DNS 与连接优化、性能优化、网络 API

---

## 目录

1. [HTTP 协议](#一http-协议)
2. [缓存机制](#二缓存机制)
3. [跨域与安全](#三跨域与安全)
4. [DNS 与连接优化](#四dns-与连接优化)
5. [性能优化](#五性能优化)
6. [网络调试与监控](#六网络调试与监控)
7. [近年新特性](#七近年新特性)
8. [综合场景](#八综合场景)

---

## 一、HTTP 协议

### HTTP/1.1 与 HTTP/2 的核心区别

| 维度 | HTTP/1.1 | HTTP/2 |
|------|----------|--------|
| 传输格式 | 文本 | 二进制帧 |
| 多路复用 | 不支持（队头阻塞） | 支持（单连接并行多流） |
| 头部压缩 | 无 | HPACK 算法 |
| 服务器推送 | 不支持 | 支持 Server Push |
| 连接数 | 浏览器限制 6 个 | 通常 1 个 |

**HTTP/1.1 队头阻塞**：请求必须按序处理，前一个慢就阻塞后面所有请求。
**HTTP/2 多路复用**：多个 Stream 在同一 TCP 连接上并行，互不阻塞。

> 注意：HTTP/2 解决了应用层队头阻塞，但 TCP 层仍存在队头阻塞（丢包重传时）。

---

### HTTP/3 为什么基于 QUIC 而不是 TCP？

**TCP 的根本问题**：
- 丢一个包，该连接所有 Stream 都要等重传（TCP 层队头阻塞）
- 握手延迟：TCP 3 次握手 + TLS 1.2 需要 2-3 个 RTT

**QUIC 的解决方案**（基于 UDP 实现）：
- **0-RTT / 1-RTT 握手**：首次连接 1-RTT，再次连接 0-RTT（复用会话票证）
- **连接迁移**：用 Connection ID 标识连接，切换网络（WiFi → 4G）不断连
- **独立流控**：每条 Stream 独立处理丢包，不影响其他 Stream

---

### HTTP 状态码速查

| 场景 | 状态码 |
|------|--------|
| 资源永久移走 | **301** Moved Permanently |
| 协商缓存命中 | **304** Not Modified |
| 请求格式错误 | **400** Bad Request |
| 需要认证 | **401** Unauthorized |
| 服务器限流 | **429** Too Many Requests |
| 网关超时 | **504** Gateway Timeout |

**常见混淆**：
- 401 vs 403：401 是未登录，403 是登录了但没权限
- 502 vs 504：502 是网关收到无效响应，504 是网关等待超时

---

### HTTPS 握手过程（TLS 1.3）

**TLS 1.3 握手（1-RTT）**：

```
Client → Server: ClientHello（支持的算法 + 密钥份额 Key Share）
Server → Client: ServerHello + Certificate + Finished（选定算法 + 服务端密钥份额）
Client → Server: Finished（验证证书 + 确认握手）
```

对比 TLS 1.2 的 2-RTT，TLS 1.3 把密钥交换合并到第一步，节省一个 RTT。

**核心概念**：
- **非对称加密**：协商阶段用（RSA/ECDHE），传输不用，太慢
- **对称加密**：正式传输用（AES-GCM），快
- **证书链验证**：叶子证书 → 中间 CA → 根 CA（浏览器内置根 CA）
- **前向安全**：ECDHE 每次生成新密钥对，历史流量不可解密

---

### GET 和 POST 的区别

**语义层面**：
- GET：读取资源，幂等，无副作用
- POST：提交数据，非幂等，有副作用

**常见误区澄清**：

| 说法 | 是否准确 |
|------|---------|
| GET 参数在 URL，POST 在 Body | 规范如此，但 GET 也可以有 Body，POST 也可以带 URL 参数 |
| GET 不安全 | HTTPS 下 URL 也是加密的，安全性相同 |
| POST 一定比 GET 安全 | 安全取决于 HTTPS，不取决于方法 |
| GET 有长度限制 | 是浏览器/服务器限制，HTTP 协议本身无限制 |

---

## 二、缓存机制

### 强缓存与协商缓存完整流程

```
请求发出
  ↓
本地有缓存？
  ├─ 否 → 发请求 → 服务器返回 200 + 资源
  └─ 是 → 是否过期（max-age / Expires）？
            ├─ 未过期 → 强缓存命中 → 200 (from cache) ← 不发请求
            └─ 已过期 → 协商缓存
                          ├─ 带 If-None-Match (ETag) 或 If-Modified-Since 发请求
                          ├─ 未变化 → 304 Not Modified → 用缓存
                          └─ 已变化 → 200 + 新资源
```

**优先级**：`Cache-Control` > `Expires`（前者是相对时间，后者是绝对时间）
**ETag vs Last-Modified**：ETag 精度更高（秒内修改、内容相同但时间变了都能正确处理）

**实战配置**：
```
# HTML 入口：每次验证
Cache-Control: no-cache

# 带 hash 的 JS/CSS：永久缓存
Cache-Control: max-age=31536000, immutable

# API：短缓存 + stale-while-revalidate
Cache-Control: s-maxage=60, stale-while-revalidate=300
```

---

### stale-while-revalidate

```http
Cache-Control: max-age=60, stale-while-revalidate=300
```

**行为**：
- 0-60s：直接用缓存（新鲜）
- 60-360s：**先返回旧缓存（stale）**，同时后台发请求更新缓存
- 360s 后：必须等待网络请求

**优势**：用户永远不感知等待，缓存始终在后台保持新鲜。

---

### Service Worker 缓存与 HTTP 缓存的区别

**层级关系**：
```
网络请求
  → Service Worker（拦截，可完全自定义响应）
    → HTTP 缓存（Cache-Control / ETag）
      → 服务器
```

**缓存策略**（Workbox）：
- `CacheFirst`：优先缓存，适合静态资源
- `NetworkFirst`：优先网络，适合 API 数据
- `StaleWhileRevalidate`：返回缓存同时后台更新，适合非关键资源

> Service Worker 只在 HTTPS 或 localhost 下工作。

---

## 三、跨域与安全

### CORS 预检请求（Preflight）触发条件

满足以下**任一条件**就会触发 OPTIONS 预检：

1. **非简单方法**：非 GET/POST/HEAD（如 PUT、DELETE、PATCH）
2. **非简单请求头**：包含 `Authorization`、`Content-Type: application/json` 等
3. **Content-Type** 非 `text/plain` / `application/x-www-form-urlencoded` / `multipart/form-data`

**优化**：设置 `Access-Control-Max-Age` 缓存预检结果，减少重复 OPTIONS 请求。

```http
Access-Control-Max-Age: 86400  # 预检结果缓存 1 天
```

---

### XSS 与 CSRF 的防御方案

**XSS（跨站脚本注入）防御**：
```
1. 输出编码：innerHTML → textContent，或 DOMPurify 净化
2. CSP 头：Content-Security-Policy: default-src 'self'
3. HttpOnly Cookie：防止 JS 读取 Cookie
4. 避免 eval / dangerouslySetInnerHTML
```

**CSRF（跨站请求伪造）防御**：
```
1. SameSite Cookie（主流方案）
   - SameSite=Strict：只有同站才发 Cookie
   - SameSite=Lax：GET 跨站可发，POST 不可发
2. CSRF Token：每个表单/请求携带随机 Token，服务端验证
3. 检查 Origin/Referer 头
4. 自定义请求头（AJAX 跨域需预检，天然防 CSRF）
```

**核心区别**：XSS 是注入脚本在用户浏览器执行；CSRF 是借用用户 Cookie 伪造请求。

---

### Cookie 的安全属性

```
Set-Cookie: token=xxx;
  HttpOnly;          # JS 不可读，防 XSS 窃取
  Secure;            # 只在 HTTPS 传输
  SameSite=Strict;   # 跨站请求不携带，防 CSRF
  Path=/;
  Max-Age=3600
```

**SameSite 详解**：
- `Strict`：完全隔离，点击第三方链接也不带 Cookie（登录态会丢失）
- `Lax`（Chrome 默认）：顶级导航 GET 请求带，POST/iframe/img 不带
- `None`：完全跨站携带，**必须同时设置 Secure**

---

## 四、DNS 与连接优化

### DNS 解析过程

```
浏览器缓存 → 操作系统缓存（hosts 文件）→ 本地 DNS 服务器
  → 根域名服务器（返回 .com 服务器地址）
    → 顶级域（.com）服务器（返回 example.com 的 NS 地址）
      → 权威 DNS 服务器（返回最终 IP）
        → 缓存 TTL 时间
```

**前端优化**：
```html
<!-- DNS 预解析，提前查询第三方域名 IP -->
<link rel="dns-prefetch" href="//cdn.example.com">

<!-- 预连接：DNS + TCP + TLS 全部提前做 -->
<link rel="preconnect" href="https://api.example.com">
```

---

### TCP 三次握手

```
Client → Server: SYN（我要连接，我的序号是 X）
Server → Client: SYN-ACK（收到了，我的序号是 Y，确认你的 X+1）
Client → Server: ACK（收到了，确认你的 Y+1）
```

**为什么不能是两次**：如果旧的 SYN 数据包延迟到达服务器，服务器以为是新连接并建立连接，但客户端已经不认这个连接了，服务器会一直等待，浪费资源。

**四次挥手**：因为 TCP 是全双工的，双方各自需要一个 FIN + ACK 来关闭各自方向的数据流。

---

## 五、性能优化

### 资源加载优化：preload / prefetch / preconnect 区别

| 指令 | 时机 | 用途 |
|------|------|------|
| `preload` | **当前页**立即需要 | 字体、关键 CSS、首屏图片 |
| `prefetch` | **下一页**可能需要 | 路由预加载、翻页资源 |
| `preconnect` | 提前建立连接 | 第三方 API、CDN 域名 |
| `dns-prefetch` | 只做 DNS 解析 | 资源较多的第三方域名 |

```html
<!-- 当前页关键字体，as 指定类型保证优先级 -->
<link rel="preload" href="/fonts/Inter.woff2" as="font" crossorigin>

<!-- 下一个路由 chunk -->
<link rel="prefetch" href="/static/js/about.chunk.js">

<!-- 提前与 CDN 握手 -->
<link rel="preconnect" href="https://cdn.example.com">
```

注意：preload 优先级高于 prefetch，preload 未使用会报警告。

---

### Core Web Vitals 优化（LCP 最大内容渲染）

**LCP 目标：< 2.5s**

**1. 消除渲染阻塞资源**
```html
<!-- CSS 异步加载，避免阻塞渲染 -->
<link rel="stylesheet" href="non-critical.css" media="print" onload="this.media='all'">
```

**2. 优化 LCP 图片**
```html
<!-- 不要懒加载 LCP 图片，加 fetchpriority -->
<img src="hero.webp" fetchpriority="high" loading="eager">
```

**3. 服务端优化**
- 开启 Brotli/Gzip 压缩
- 使用 CDN 缩短 TTFB（首字节时间）
- 关键 CSS 内联（Critical CSS）

**4. 字体优化**
```css
@font-face {
  font-display: swap; /* 先用系统字体渲染，字体加载后替换 */
}
```

---

### 并发请求队列

```javascript
class RequestQueue {
  constructor(concurrency = 3) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  add(requestFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ requestFn, resolve, reject });
      this.run();
    });
  }

  run() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const { requestFn, resolve, reject } = this.queue.shift();
      this.running++;
      requestFn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          this.running--;
          this.run();
        });
    }
  }
}

const queue = new RequestQueue(3);
const urls = Array.from({ length: 10 }, (_, i) => `https://api.example.com/${i}`);
const results = await Promise.all(
  urls.map(url => queue.add(() => fetch(url).then(r => r.json())))
);
```

---

## 六、网络调试与监控

### Performance API 监控页面网络性能

```javascript
// 获取所有资源加载时间
const entries = performance.getEntriesByType('resource');
entries.forEach(entry => {
  console.log({
    name: entry.name,
    dns: entry.domainLookupEnd - entry.domainLookupStart,
    tcp: entry.connectEnd - entry.connectStart,
    ttfb: entry.responseStart - entry.requestStart,
    download: entry.responseEnd - entry.responseStart,
    total: entry.duration,
  });
});

// 监控 LCP
new PerformanceObserver(list => {
  const entries = list.getEntries();
  const lcp = entries[entries.length - 1];
  console.log('LCP:', lcp.startTime, lcp.element);
}).observe({ entryTypes: ['largest-contentful-paint'] });

// 监控长任务（> 50ms）
new PerformanceObserver(list => {
  list.getEntries().forEach(entry => {
    if (entry.duration > 50) {
      reportLongTask(entry);
    }
  });
}).observe({ entryTypes: ['longtask'] });
```

---

### 从输入 URL 到页面展示（网络部分）

```
1. URL 解析：协议、域名、端口、路径

2. DNS 解析
   浏览器缓存 → OS 缓存 → 本地 DNS → 递归查询

3. 建立连接
   TCP 三次握手 → TLS 握手（HTTPS）

4. 发送 HTTP 请求
   GET / HTTP/2
   Host: example.com

5. 服务器处理 → 返回响应
   状态码 + 响应头 + Body（HTML）

6. 浏览器接收响应
   ├─ 检查缓存头，决定是否缓存
   ├─ 解析 HTML → DOM 树
   ├─ 发现 CSS/JS/图片 → 并行请求（HTTP/2 多路复用）
   ├─ 构建 CSSOM → 合并 Render Tree
   └─ Layout → Paint → Composite → 展示页面
```

---

## 七、近年新特性

### WebSocket 与 SSE（Server-Sent Events）选择

| 维度 | WebSocket | SSE |
|------|-----------|-----|
| 通信方向 | 双向 | 单向（服务端→客户端） |
| 协议 | ws:// / wss:// | HTTP（复用现有连接） |
| 断线重连 | 手动实现 | 浏览器自动重连 |
| 数据格式 | 二进制/文本 | 文本（UTF-8） |
| 负载均衡 | 需粘性会话（sticky session） | 普通 HTTP 负载均衡即可 |
| 适用场景 | 聊天室、游戏、协同编辑 | 消息推送、进度通知、AI 流式输出 |

**SSE 代码示例**：
```javascript
const es = new EventSource('/api/stream');
es.onmessage = e => console.log(e.data);
es.addEventListener('progress', e => updateProgress(e.data));
```

---

### Fetch API 与 XMLHttpRequest 的区别

| 维度 | XHR | Fetch |
|------|-----|-------|
| API 风格 | 回调/事件 | Promise |
| 流式响应 | 不支持 | 支持（`response.body` ReadableStream） |
| 请求取消 | `xhr.abort()` | `AbortController` |
| 上传进度 | `xhr.upload.onprogress` | 暂不支持 |
| Cookie 携带 | 默认携带 | 需要 `credentials: 'include'` |
| 错误处理 | HTTP 错误也触发 onerror | **HTTP 错误不 reject**，需手动检查 `response.ok` |

```javascript
// Fetch 正确的错误处理
const res = await fetch('/api');
if (!res.ok) throw new Error(`HTTP ${res.status}`);

// 流式处理（AI 场景）
const res = await fetch('/api/stream');
const reader = res.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value));
}
```

---

## 八、综合场景

### 大文件上传（分片 + 断点续传）

```javascript
async function uploadLargeFile(file, chunkSize = 5 * 1024 * 1024) {
  // 1. 计算文件 hash（用于秒传和断点续传）
  const hash = await calcFileHash(file);

  // 2. 询问服务器已上传哪些分片
  const { uploadedChunks } = await fetch('/api/upload/check', {
    method: 'POST',
    body: JSON.stringify({ hash, filename: file.name })
  }).then(r => r.json());

  // 3. 分片并过滤已上传的
  const chunks = splitFile(file, chunkSize);
  const pendingChunks = chunks.filter((_, i) => !uploadedChunks.includes(i));

  // 4. 并发上传（控制并发数）
  await Promise.all(
    pendingChunks.map(({ chunk, index }) => {
      const form = new FormData();
      form.append('chunk', chunk);
      form.append('hash', hash);
      form.append('index', index);
      return fetch('/api/upload/chunk', { method: 'POST', body: form });
    })
  );

  // 5. 通知服务端合并
  return fetch('/api/upload/merge', {
    method: 'POST',
    body: JSON.stringify({ hash, filename: file.name, total: chunks.length })
  });
}
```

**关键点**：秒传（hash 相同直接返回）、断点续传（记录已传分片）、并发控制。

---

### 带超时、重试和取消功能的 fetch 封装

```javascript
async function fetchWithRetry(url, options = {}, {
  timeout = 5000,
  retries = 3,
  retryDelay = 1000,
  signal
} = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

    const combinedSignal = signal
      ? anySignal([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const res = await fetch(url, { ...options, signal: combinedSignal });
      clearTimeout(timeoutId);

      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) {
          await delay(retryDelay * 2 ** attempt); // 指数退避
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError' && signal?.aborted) {
        throw err; // 用户主动取消，不重试
      }
      if (attempt === retries) throw err;
      await delay(retryDelay * 2 ** attempt);
    }
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
```

---

### 前端请求错误监控

```javascript
// 拦截 fetch
const originalFetch = window.fetch;
window.fetch = async (...args) => {
  const start = Date.now();
  try {
    const res = await originalFetch(...args);
    if (!res.ok) {
      reportError({ type: 'http', status: res.status, url: args[0], duration: Date.now() - start });
    }
    return res;
  } catch (err) {
    reportError({ type: 'network', message: err.message, url: args[0] });
    throw err;
  }
};
```

**上报策略**：
- `navigator.sendBeacon`：页面卸载时可靠上报
- 批量聚合：合并同类错误，避免刷屏
- 采样率：高频错误按比例采样（1%~10%）

---

## 速查清单

| 类别 | 核心知识点 |
|------|---------|
| HTTP | 状态码语义、GET vs POST、HTTP/2 多路复用、HTTP/3 QUIC |
| HTTPS | TLS 1.3 握手、证书验证、前向安全 |
| 缓存 | 强缓存/协商缓存流程、Cache-Control 各字段、SWR |
| 跨域 | CORS 简单请求/预检、JSONP 原理、代理方案 |
| 安全 | XSS/CSRF 防御、CSP、Cookie SameSite |
| 性能 | preload/prefetch、LCP 优化、资源压缩 |
| API | Fetch vs XHR、SSE vs WebSocket、AbortController |
| 网络基础 | DNS 解析、TCP 握手/挥手、TLS 握手 |
