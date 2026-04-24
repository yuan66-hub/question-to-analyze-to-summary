# Next.js SSR 经过 Nginx 转发时的流式传输排障手册

## 1. 问题定义

在生产环境里，`Next.js` 经常不会直接暴露在公网，而是放在 `Nginx`、`CDN`、`SLB` 或 API 网关后面。

这时一个非常常见的问题是：

> `Next.js` 服务端明明支持流式输出，但页面经过 `Nginx` 中转后，浏览器端看起来却像一次性返回，流式传输特性失效了。

这个问题本质上通常不是 `Next.js` 不支持流式，而是链路中某一层把响应缓冲、压缩、聚合或缓存了，导致浏览器无法按 chunk 逐步接收和渲染。

---

## 2. 结论先行

### 2.1 会不会生效

会，但不是天然稳定生效。

如果你使用的是 `Next.js App Router`，并且页面里确实存在可流式输出的边界，例如：

- `Suspense`
- `loading.tsx`
- 异步 Server Component
- Route Handler 返回 `ReadableStream`

那么 `Next.js` 端是支持流式传输的。

### 2.2 为什么经常“看起来不生效”

因为 `Nginx` 默认可能会做响应缓冲，或者链路上还有其他代理层在缓冲。

典型现象是：

- 服务端已经逐段生成 HTML
- 代理层先把这些 chunk 暂存起来
- 浏览器只能在缓冲达到一定条件后一次性收到
- 最终用户看到的是“整段页面一起出来”

### 2.3 一句话结论

`Next.js` 的流式渲染能否在生产环境真正体现出来，不只取决于应用本身，还取决于 `Nginx`、`CDN`、负载均衡、压缩和缓存链路是否完整保留了分块响应。

---

## 3. 生效前提

要让 `Next.js` 的流式 SSR 真正生效，至少要同时满足下面几个条件：

### 3.1 应用层真的在流式输出

不是所有 `SSR` 都等价于“流式 SSR”。

#### `App Router`

`App Router` 是 `Next.js` 流式能力的主要承载方式。它结合 React 18 的服务端渲染能力，可以按 `Suspense` 边界逐段返回内容。

#### `Pages Router`

`Pages Router` 下的 `getServerSideProps` 更常见的是“每次请求服务端生成完整 HTML”，通常不具备你预期中的 React 18 分段流式 UI 输出体验。

所以，讨论生产环境里的流式传输时，优先默认场景是：

`App Router + Suspense + Async Server Component`

### 3.2 代理层不能吞掉 chunk

只要 `Browser` 和 `Next.js` 之间的任意一层做了缓冲，流式收益就会显著下降。

最常见的中间层包括：

- `Nginx`
- `CDN`
- `WAF`
- `SLB / ALB`
- 平台网关

### 3.3 返回链路支持分块传输

常见要求包括：

- 反向代理正确转发分块响应
- 不提前读完整个响应再下发
- 不因为压缩或缓存策略而合并小块数据
- 负载均衡支持 `chunked transfer encoding` 或 `HTTP/2 streaming`

---

## 4. 核心原理

### 4.1 `Next.js` 流式渲染做了什么

React 服务端渲染可以先输出页面骨架，再在异步数据准备完成后逐步补全页面片段。

这意味着：

1. 首屏骨架可以更早返回
2. 慢数据区域不必阻塞整个页面
3. 用户更早看到“页面已开始工作”

### 4.2 `Nginx` 为什么会破坏流式效果

如果 `Nginx` 开启了响应缓冲，它会先收集上游返回的数据，再按自己的策略写给客户端。

这样就会导致：

1. `Next.js` 虽然已经在分块输出
2. `Nginx` 却没有立刻往浏览器透传
3. 浏览器无法按 chunk 渲染
4. 页面表现成“等一会儿后整体出来”

### 4.3 为什么压缩也可能影响观察结果

压缩并不一定彻底破坏流式，但它可能造成：

- 小 chunk 被合并
- 首块更晚发出
- 调试时很难直观看到分块边界

所以排障阶段通常建议先关闭动态压缩，先确认流式链路通了，再决定是否重新开启。

---

## 5. 推荐的 Nginx 配置

下面是一份适合 `Next.js` 自托管场景的基础模板：

```nginx
upstream next_app {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://next_app;

        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 核心：关闭响应缓冲，尽量保持上游 chunk 原样透传
        proxy_buffering off;
        proxy_cache off;

        # 主要影响请求体上传，但很多团队会一并关闭
        proxy_request_buffering off;

        # 调试阶段建议关闭，避免 chunk 聚合影响判断
        gzip off;

        # 防止慢查询或慢组件导致连接过早超时
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;

        chunked_transfer_encoding on;
    }

    location /_next/static/ {
        proxy_pass http://next_app;
        proxy_http_version 1.1;
        proxy_set_header Host $host;

        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

### 5.1 最关键的几个配置项

#### `proxy_buffering off;`

最重要的开关。  
如果不关，服务端即使在流式输出，浏览器端也很可能感受不到。

#### `proxy_http_version 1.1;`

保证与上游应用的分块传输更稳定，尤其是 Node 服务和代理组合里，这是非常常见且必要的设置。

#### `gzip off;`

建议在排障和验证阶段关闭。  
如果确认链路没问题，再根据实际需要评估是否恢复压缩。

#### `chunked_transfer_encoding on;`

帮助代理端更明确地进行分块传输。在大多数现代链路里不是唯一决定因素，但保留它更稳妥。

---

## 6. 推荐的 Next.js 配置

`Next.js` 官方在自托管流式场景里建议显式返回：

`X-Accel-Buffering: no`

这个 header 的作用是告诉 `Nginx` 不要对该响应做缓冲。

### 6.1 在 `next.config.js` 中统一添加

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Accel-Buffering",
            value: "no",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
```

### 6.2 Route Handler 流式响应示例

```ts
export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 5; i++) {
        controller.enqueue(encoder.encode(`chunk ${i}\n`));
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    },
  });
}
```

### 6.3 App Router 页面示例

只有真的存在异步边界，流式体验才会明显。

```tsx
import { Suspense } from "react";

async function SlowPanel() {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return <div>slow data loaded</div>;
}

function SlowPanelFallback() {
  return <div>loading slow panel...</div>;
}

export default function Page() {
  return (
    <main>
      <h1>dashboard</h1>
      <Suspense fallback={<SlowPanelFallback />}>
        <SlowPanel />
      </Suspense>
    </main>
  );
}
```

---

## 7. 推荐的生产链路理解方式

可以把链路抽象成下面这样：

`Browser -> CDN/WAF -> Nginx -> Next.js`

任何一层都可能让流式看起来失效。

### 7.1 最容易出问题的链路点

#### CDN

- 动态内容被缓冲
- 边缘压缩导致小 chunk 合并
- 页面优化功能重写 HTML 输出行为

#### WAF / 安全网关

- 先检查全量响应内容再放行
- 风险检测导致不能边收边发

#### 负载均衡

- 不完全支持流式透传
- 对连接、超时、协议协商有额外限制

#### Nginx

- 默认或局部配置启用了缓冲
- 动态压缩影响 chunk 透传表现

---

## 8. 如何验证流式有没有真的生效

不要只靠浏览器肉眼判断。  
最稳妥的办法是分层验证。

### 8.1 第一步：直连 Next.js

```bash
curl -N -D - http://127.0.0.1:3000/your-page
```

如果这里都不是逐步返回，那么优先检查：

- 是否是 `App Router`
- 是否真的用了 `Suspense`
- 是否只是普通 `SSR`
- 数据请求是否形成了真正的异步边界

### 8.2 第二步：经过 Nginx

```bash
curl -N -D - http://your-domain.com/your-page
```

重点看两件事：

1. 是否仍然是逐步输出
2. 是否带有 `X-Accel-Buffering: no`

如果直连 `3000` 可以流式返回，而经域名访问不行，问题大概率就在 `Nginx` 或其前置代理层。

### 8.3 第三步：如果前面还有 CDN

继续分别测试：

- 内网域名或源站域名
- 经过公网 CDN 的最终域名

只要某一跳开始“从逐步输出变成一次性输出”，问题点基本就找到了。

---

## 9. 常见误判

### 9.1 “已经是 SSR，所以一定支持流式”

不成立。  
`SSR` 只是说明 HTML 在服务端生成，不代表它一定会被逐块下发。

### 9.2 “浏览器看起来没变化，说明没有流式”

不一定。  
有时流式已经生效，只是因为：

- fallback 太轻
- 内容块太小
- 首块和后续块间隔太短
- 压缩后肉眼不明显

### 9.3 “关了 Nginx 缓冲就一定行”

也不一定。  
如果前面还有 `CDN`、`WAF`、`LB`，任意一层都可能继续吞掉 chunk。

### 9.4 “Pages Router 下也能获得同样的流式页面体验”

通常不能等价理解。  
生产环境讨论流式 UI 时，应优先看 `App Router`。

---

## 10. 一份可复用的排障顺序

实际排查时建议按下面顺序走：

### 第 1 步：确认应用层能力

- 是否使用 `App Router`
- 是否有 `Suspense` 边界
- 是否存在慢组件或异步数据块
- 是否返回了 `X-Accel-Buffering: no`

### 第 2 步：确认 Nginx 配置

- 是否开启了 `proxy_buffering off`
- 是否启用了 `proxy_http_version 1.1`
- 调试阶段是否关闭了 `gzip`
- 是否有局部 `location` 覆盖了全局配置

### 第 3 步：确认网关链路

- 是否存在 CDN 动态压缩
- 是否存在边缘缓存
- 是否有 WAF 响应检查
- 是否有平台网关做响应聚合

### 第 4 步：做分层验证

- 直连 Node
- 经过 Nginx
- 经过最终公网域名

通过这三层对比，通常都能很快定位问题。

---

## 11. 推荐的实践方案

如果目标是让用户更早看到页面骨架，而不是等完整页面全部算完，推荐采用下面的组合：

1. 使用 `App Router`
2. 用 `Suspense` 拆分慢区域
3. `Next.js` 返回 `X-Accel-Buffering: no`
4. `Nginx` 关闭 `proxy_buffering`
5. 调试阶段关闭压缩
6. 对 `CDN / WAF / LB` 做链路排查

这是当前 `Next.js` 自托管流式渲染最稳妥的工程做法之一。

---

## 12. 面试回答模板

如果面试官问：

> `Nginx` 做 `Next.js` 服务端渲染请求中转时，流式传输会不会生效？如果不生效怎么解决？

可以直接回答：

`Next.js` 的流式 SSR 在经过 Nginx 转发时理论上是可以生效的，但前提是应用层真的用了 App Router 的流式能力，比如 Suspense、loading.tsx 或流式 Route Handler。同时 Nginx 不能把上游响应缓冲住。如果 Nginx 开了 proxy buffering，服务端虽然在分块输出，浏览器端看到的仍然可能是一次性返回。解决方案通常是关闭 proxy_buffering，使用 proxy_http_version 1.1，调试阶段关闭 gzip，并在 Next.js 侧返回 X-Accel-Buffering: no。如果链路前面还有 CDN、WAF 或负载均衡，也要继续排查这些层是否对响应做了缓冲或聚合。`

---

## 13. 速查清单

### 判断流式是否可能生效

- 是否是 `App Router`
- 是否使用 `Suspense`
- 是否存在异步边界

### 判断 Nginx 是否吞流

- 是否配置 `proxy_buffering off`
- 是否配置 `proxy_http_version 1.1`
- 是否返回 `X-Accel-Buffering: no`
- 是否关闭了调试阶段的 `gzip`

### 判断是不是链路其他层的问题

- 是否有 `CDN`
- 是否有 `WAF`
- 是否有 `LB / API Gateway`
- 是否做了动态压缩或响应缓存

---

## 14. 总结

`Next.js` 流式 SSR 不是“应用打开就天然直达浏览器”的能力，而是一个端到端能力。

只要链路中有一层做了缓冲，流式效果就会被削弱甚至直接失效。  
因此，生产环境里要把它当成一个完整链路问题来排查，而不是只盯着 `Next.js` 本身。

最核心的经验可以浓缩为一句话：

> 应用层要真的流，代理层要真的透，链路中间层不能偷偷缓冲。
