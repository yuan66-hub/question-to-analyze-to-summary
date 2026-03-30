# 前端网络层面性能优化

## 一、减少请求数量

**资源合并与复用**
- 将多个小 CSS/JS 文件合并打包，减少 HTTP 请求数
- 使用 CSS Sprites 合并小图标，现代方案用 SVG Sprite 或 Icon Font 替代
- 内联关键资源（Critical CSS）到 `<style>` 避免额外请求

**HTTP/2 多路复用**
- 升级到 HTTP/2，消除 HTTP/1.1 的队头阻塞，单连接并行传输多个请求
- HTTP/2 下无需刻意合并文件（多路复用反而适合小文件），但仍需控制总请求数

---

## 二、减少传输体积

**压缩**
- 服务端开启 **Brotli** 压缩（比 Gzip 压缩率高 15-20%），降级兼容 Gzip
- 图片使用 **WebP/AVIF** 格式，体积比 PNG/JPEG 小 30-80%
- JS/CSS 开启 Tree Shaking + Minification（esbuild/terser/cssnano）

**代码分割（Code Splitting）**
```js
// 路由级懒加载，初始 bundle 只加载当前页
const Dashboard = dynamic(() => import('./Dashboard'), { ssr: false })
```
- 按路由拆包，避免首屏加载全量代码

**避免 Barrel 文件**
```js
// 避免：会引入整个模块树
import { Button } from '@/components'

// 推荐：直接引入，Tree Shaking 更彻底
import { Button } from '@/components/Button'
```

---

## 三、缓存策略

**HTTP 缓存头**

| 资源类型 | 策略 |
|---------|------|
| HTML 入口 | `Cache-Control: no-cache`（每次验证） |
| JS/CSS（含 hash） | `Cache-Control: max-age=31536000, immutable` |
| API 数据 | `Cache-Control: s-maxage=60, stale-while-revalidate=300` |

**Service Worker 缓存**
- 缓存静态资源，支持离线访问
- 拦截请求实现 Stale-While-Revalidate 策略

**CDN 边缘缓存**
- 静态资源通过 CDN 就近分发，降低 TTFB
- Next.js 的 `revalidate` 自动控制 CDN 缓存失效

---

## 四、资源加载优先级控制

**预加载关键资源**
```html
<!-- 预加载当前页必需的字体/图片 -->
<link rel="preload" href="/font.woff2" as="font" crossorigin>

<!-- 预连接第三方域名，减少 DNS+TLS 时间 -->
<link rel="preconnect" href="https://api.example.com">
<link rel="dns-prefetch" href="https://cdn.example.com">

<!-- 预获取下一页资源（用户大概率访问） -->
<link rel="prefetch" href="/dashboard.js">
```

**Hover 预加载（感知速度优化）**
```js
// 鼠标悬停时预加载
button.addEventListener('mouseenter', () => {
  import('./HeavyModal')
})
```

---

## 五、消除请求瀑布（Waterfalls）

**并行化独立请求**
```js
// 错误：串行请求，耗时叠加
const user = await getUser(id)
const posts = await getPosts(id)

// 正确：并行请求
const [user, posts] = await Promise.all([getUser(id), getPosts(id)])
```

**Suspense 流式渲染**
```jsx
// 慢组件不阻塞快组件渲染
<Suspense fallback={<Skeleton />}>
  <SlowDataComponent />
</Suspense>
```

---

## 六、图片与媒体优化

- 使用 `loading="lazy"` 延迟加载视口外图片
- `sizes` + `srcset` 响应式图片，按设备分辨率加载合适尺寸
- 视频用 `preload="metadata"` 而非 `preload="auto"`

---

## 七、第三方资源治理

**延迟非关键脚本**
```js
// 等页面 hydration 完成后加载埋点/分析脚本
useEffect(() => {
  import('./analytics').then(m => m.init())
}, [])
```

**避免阻塞渲染**
```html
<!-- defer：DOM 解析完后执行，不阻塞 -->
<script src="app.js" defer></script>

<!-- async：下载完立即执行（适合无依赖脚本） -->
<script src="tracker.js" async></script>
```

---

## 八、协议与连接优化

### HTTP/1.1 的核心瓶颈

HTTP/1.1 存在队头阻塞（Head-of-Line Blocking），浏览器对每个域名最多开 6 个并发 TCP 连接，治标不治本。

### HTTP/2 多路复用

单 TCP 连接内并行传输多个请求流，消除应用层队头阻塞。

**Nginx 配置 HTTP/2**
```nginx
server {
    listen 443 ssl http2;

    ssl_certificate     /etc/ssl/cert.pem;
    ssl_certificate_key /etc/ssl/key.pem;

    http2_max_field_size   16k;
    http2_max_header_size  32k;
    http2_max_requests     1000;
    http2_idle_timeout     3m;
    http2_chunk_size       8k;
}
```

### 103 Early Hints（现代推送替代方案）

服务端在处理请求期间提前发送 103 响应，让浏览器提前加载资源，无需等待完整响应。

```nginx
location = / {
    add_header Link "</css/app.css>; rel=preload; as=style";
    add_header Link "</js/app.js>; rel=preload; as=script";
    proxy_pass http://backend;
}
```

```js
// Node.js 实现
server.on('request', (req, res) => {
  res.writeEarlyHints({
    'link': [
      '</css/app.css>; rel=preload; as=style',
      '</js/app.js>; rel=preload; as=script',
    ]
  })

  fetchDataFromDB().then(data => {
    res.writeHead(200)
    res.end(renderHTML(data))
  })
})
```

### HTTP/3 + QUIC

HTTP/2 仍存在 TCP 层队头阻塞：一个丢包会阻塞所有流。QUIC 基于 UDP，每条流独立重传，互不影响。

**QUIC 0-RTT 连接恢复**：利用 Session Ticket，重连时直接携带数据，无需握手等待。

**Nginx 配置 HTTP/3**
```nginx
server {
    listen 443 ssl http2;
    listen 443 quic reuseport;   # HTTP/3

    ssl_protocols TLSv1.3;

    # 通知客户端支持 HTTP/3
    add_header Alt-Svc 'h3=":443"; ma=86400';

    ssl_early_data on;           # 0-RTT
}
```

```js
// 检测当前协议
const observer = new PerformanceObserver((list) => {
  list.getEntries().forEach(entry => {
    console.log(entry.name, entry.nextHopProtocol) // "h3" / "h2" / "http/1.1"
  })
})
observer.observe({ entryTypes: ['resource', 'navigation'] })
```

### TLS 1.3 优化

TLS 1.2 需要 2-RTT 握手，TLS 1.3 只需 1-RTT，重连支持 0-RTT。

**Nginx 配置**
```nginx
ssl_protocols TLSv1.2 TLSv1.3;

# Session 复用
ssl_session_cache   shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;

# OCSP Stapling：证书验证无需额外请求 CA 服务器
ssl_stapling        on;
ssl_stapling_verify on;
resolver            8.8.8.8 valid=300s;
```

### TCP 连接优化

**Nginx Keep-Alive 配置**
```nginx
http {
    keepalive_timeout  65;
    keepalive_requests 1000;

    upstream backend {
        server 127.0.0.1:3000;
        keepalive 32;           # 保持 32 个空闲长连接
    }

    location /api {
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_pass http://backend;
    }
}
```

**TCP 内核参数优化**
```bash
# /etc/sysctl.conf

net.ipv4.tcp_fin_timeout       = 15      # 减少 TIME_WAIT 占用
net.ipv4.tcp_tw_reuse          = 1
net.core.somaxconn             = 65535   # 增大连接队列
net.ipv4.tcp_max_syn_backlog   = 65535
net.ipv4.tcp_fastopen          = 3       # TCP Fast Open

sysctl -p
```

```nginx
# Nginx 启用 TCP Fast Open
listen 443 ssl http2 fastopen=256 reuseport;
```

### DNS 优化

```html
<!-- DNS 预解析（最低成本） -->
<link rel="dns-prefetch" href="//cdn.example.com">

<!-- 预连接（DNS + TCP + TLS，适合关键第三方） -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
```

```js
// Node.js：优先 IPv4，避免 IPv6 解析延迟
const dns = require('dns')
dns.setDefaultResultOrder('ipv4first')
```

### 减少重定向

```nginx
# 错误：两步跳转，浪费 2 个 RTT
# http://example.com → https://example.com → https://www.example.com

# 正确：一步到位
server {
    listen 80;
    server_name example.com www.example.com;
    return 301 https://www.example.com$request_uri;
}

# HSTS：浏览器本地缓存跳转，后续 HTTP 请求直接本地升级
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload";
```

### 验证工具

```bash
# 验证 HTTP 版本
curl -I --http2 https://example.com
curl -I --http3 https://example.com

# 查看 TLS 握手详情
openssl s_client -connect example.com:443 -tls1_3

# 测量各阶段耗时
curl -w "\ndns: %{time_namelookup}s\nconnect: %{time_connect}s\ntls: %{time_appconnect}s\nttfb: %{time_starttransfer}s\ntotal: %{time_total}s\n" \
     -o /dev/null -s https://example.com
```

```js
// Navigation Timing API 监控各阶段耗时
const t = performance.getEntriesByType('navigation')[0]
console.log({
  dns:      t.domainLookupEnd - t.domainLookupStart,
  tcp:      t.connectEnd - t.connectStart,
  tls:      t.connectEnd - t.secureConnectionStart,
  ttfb:     t.responseStart - t.requestStart,
  download: t.responseEnd - t.responseStart,
})
```

---

## 九、核心指标映射

| 优化手段 | 改善指标 |
|---------|---------|
| 减少 TTFB（CDN、服务端缓存） | FCP、LCP |
| 减少 JS 体积/延迟执行 | TTI、TBT |
| 图片优化 + 懒加载 | LCP、CLS |
| 消除瀑布请求 | FCP、LCP |
| 预加载关键资源 | FCP |

---

## 十、协议优化优先级

| 优先级 | 优化项 | 收益 | 实施成本 |
|--------|--------|------|---------|
| 🔴 最高 | 启用 HTTPS + TLS 1.3 | 安全 + 握手提速 | 低 |
| 🔴 最高 | 启用 HTTP/2 | 多路复用，消除队头阻塞 | 低 |
| 🟠 高 | HSTS + 消除重定向链 | 减少 RTT | 低 |
| 🟠 高 | OCSP Stapling | 消除证书验证延迟 | 低 |
| 🟡 中 | preconnect 关键第三方 | 减少连接建立时间 | 极低 |
| 🟡 中 | HTTP/3 | 弱网环境显著提升 | 中 |
| 🟢 低 | TCP Fast Open | 重连 0-RTT | 中 |
| 🟢 低 | 103 Early Hints | 并行预加载 | 中 |

> **核心原则**：能不传就不传，能晚传就晚传，传了就缓存，传的时候并行传。
