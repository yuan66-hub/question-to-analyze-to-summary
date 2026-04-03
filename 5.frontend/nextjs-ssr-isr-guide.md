# Next.js SSR 与 ISR 深度指南

## SSR（Server-Side Rendering）

每次请求都在服务器实时生成 HTML。

```js
// Pages Router
export async function getServerSideProps(context) {
  const data = await fetchData()
  return { props: { data } }
}

// App Router
export default async function Page() {
  const data = await fetch('...', { cache: 'no-store' }) // 每次请求重新获取
  return <div>{data}</div>
}
```

**特点：**
- 每次请求触发一次服务器渲染
- 数据始终是最新的
- TTFB 较高，无法被 CDN 缓存页面本身
- 适合：高度个性化内容、实时数据（股价、用户信息）

---

## ISR（Incremental Static Regeneration）

构建时生成静态页面，后台按时间周期重新生成，兼顾性能与数据新鲜度。

```js
// Pages Router
export async function getStaticProps() {
  const data = await fetchData()
  return {
    props: { data },
    revalidate: 60  // 60 秒后允许重新生成
  }
}

// App Router
export default async function Page() {
  const data = await fetch('...', { next: { revalidate: 60 } })
  return <div>{data}</div>
}
```

**特点：**
- 首次请求返回缓存的静态页面（极快）
- 过期后，下一次请求触发后台重新生成（stale-while-revalidate 模式）
- 可被 CDN 缓存
- 适合：博客、商品列表、新闻等低频更新内容

---

## SSR vs ISR 核心对比

| 维度 | SSR | ISR |
|------|-----|-----|
| 渲染时机 | 每次请求 | 构建时 + 按需重建 |
| 数据新鲜度 | 实时 | 有延迟（revalidate 周期） |
| 性能 | 较慢（服务器计算） | 快（静态文件） |
| CDN 缓存 | 不能缓存页面 | 可以缓存 |
| 服务器压力 | 高（每次请求都计算） | 低 |
| 适用场景 | 个性化/实时数据 | 共享内容/低频更新 |

---

## App Router 统一控制方式

Next.js 13+ 用 `fetch` 选项统一控制渲染策略：

```js
fetch(url, { cache: 'no-store' })        // SSR：每次请求都重新获取
fetch(url, { next: { revalidate: 60 } }) // ISR：60 秒重验证
fetch(url, { cache: 'force-cache' })     // SSG：永久缓存
```

---

## On-demand ISR（按需重验证）

不依赖时间间隔，通过主动触发精确控制页面重新生成。

### 两种重验证方式

#### 1. `revalidatePath` — 重验证指定路径

```ts
// app/api/revalidate/route.ts
import { revalidatePath } from 'next/cache'
import { NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret')

  if (secret !== process.env.REVALIDATE_SECRET) {
    return Response.json({ error: 'Invalid secret' }, { status: 401 })
  }

  const path = request.nextUrl.searchParams.get('path') || '/'
  revalidatePath(path)

  return Response.json({ revalidated: true, path })
}
```

#### 2. `revalidateTag` — 按标签批量重验证

在 fetch 时打标签：

```ts
// app/posts/page.tsx
const posts = await fetch('https://api.example.com/posts', {
  next: { tags: ['posts'] }
})

// app/posts/[id]/page.tsx
const post = await fetch(`https://api.example.com/posts/${params.id}`, {
  next: { tags: ['posts', `post-${params.id}`] }
})
```

触发重验证：

```ts
// app/api/revalidate/route.ts
import { revalidateTag } from 'next/cache'

export async function POST(request: NextRequest) {
  const { tag } = await request.json()
  revalidateTag(tag)  // 让所有带该标签的缓存失效
  return Response.json({ revalidated: true, tag })
}
```

---

### 典型场景：CMS Webhook

```ts
// app/api/webhook/route.ts
import { revalidateTag } from 'next/cache'

export async function POST(request: NextRequest) {
  const body = await request.json()

  // 验证 Webhook 签名
  const signature = request.headers.get('x-contentful-signature')
  if (!verifySignature(body, signature)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  switch (body.sys.type) {
    case 'Entry':
      revalidateTag(`entry-${body.sys.id}`)  // 只刷新该条目
      break
    case 'Asset':
      revalidateTag('assets')                // 刷新所有资源
      break
  }

  return Response.json({ revalidated: true })
}
```

---

### Server Action 中直接触发

```ts
// app/actions.ts
'use server'
import { revalidatePath, revalidateTag } from 'next/cache'

export async function publishPost(postId: string) {
  await db.post.update({ where: { id: postId }, data: { published: true } })

  revalidateTag('posts')             // 刷新列表页缓存
  revalidatePath(`/posts/${postId}`) // 刷新详情页缓存
}
```

---

### Pages Router 的 `res.revalidate()`

```ts
// pages/api/revalidate.ts
export default async function handler(req, res) {
  if (req.query.secret !== process.env.REVALIDATE_SECRET) {
    return res.status(401).json({ message: 'Invalid secret' })
  }

  try {
    await res.revalidate(req.query.path)  // 例如 '/posts/1'
    return res.json({ revalidated: true })
  } catch (err) {
    return res.status(500).send('Error revalidating')
  }
}
```

---

## 重验证方式对比

| 方式 | 触发时机 | 粒度 | 适用场景 |
|------|---------|------|---------|
| `revalidate: N` | 定时 | 单个 fetch | 更新频率固定 |
| `revalidatePath` | 主动调用 | 整个路由 | 内容发布、后台操作 |
| `revalidateTag` | 主动调用 | 跨路由批量 | CMS、多页面共享数据 |

**最佳实践：** 用 `revalidateTag` + CMS Webhook 组合——内容更新时自动触发，精准高效，不依赖时间轮询。

---

## SSR 内存过高问题

### 常见原因

| 原因 | 说明 |
|------|------|
| React 组件树内存未释放 | `renderToString` 每次请求创建完整虚拟 DOM |
| 大对象透传 Props | `getServerSideProps` 返回的数据过大，序列化占内存 |
| 全局变量泄漏 | 模块级变量在 SSR 中被多个请求共享且持续增长 |
| 未关闭的连接/定时器 | 数据库连接池、setInterval 未正确清理 |
| Node.js 默认堆较小 | 默认 ~1.5GB，高并发时容易 OOM |

### 解决方案

#### 1. 精简 Props 数据量

```ts
// BAD: 返回整个数据库对象
export async function getServerSideProps() {
  const posts = await db.post.findMany({ include: { author: true, comments: true } })
  return { props: { posts } } // 可能几 MB
}

// GOOD: 只返回页面需要的字段
export async function getServerSideProps() {
  const posts = await db.post.findMany({
    select: { id: true, title: true, excerpt: true, createdAt: true }
  })
  return { props: { posts } } // 几 KB
}
```

#### 2. 避免模块级全局状态泄漏

```ts
// BAD: 模块级缓存无上限
const cache = new Map()
export async function getServerSideProps() {
  cache.set(key, bigData) // 每次请求都往里塞，永不清理
}

// GOOD: 使用 LRU 缓存 + 设上限
import { LRUCache } from 'lru-cache'
const cache = new LRUCache({ max: 500, ttl: 1000 * 60 * 5 })
```

#### 3. 数据库连接池单例化

```ts
// lib/prisma.ts — 防止热重载时创建多个连接池
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
```

#### 4. 增大 Node.js 堆内存 + 监控

```bash
# 启动时增大堆内存
NODE_OPTIONS="--max-old-space-size=4096" next start

# 生产环境监控内存
NODE_OPTIONS="--max-old-space-size=4096 --expose-gc" next start
```

```ts
// middleware 中采集内存指标
export function middleware(req: NextRequest) {
  const mem = process.memoryUsage()
  console.log(`RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB, Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`)
}
```

#### 5. Streaming SSR 降低峰值内存

```tsx
// App Router 默认支持 streaming
// 配合 Suspense 分块传输，避免一次性渲染整棵树
export default async function Page() {
  return (
    <div>
      <Header />
      <Suspense fallback={<Loading />}>
        <HeavyContent />  {/* 异步流式传输 */}
      </Suspense>
    </div>
  )
}
```

---

## ISR 内存过高问题

### 根因

ISR 会在内存中缓存所有已生成的页面。如果有 10 万个动态路由，每个缓存页面 100KB，就是 ~10GB。

### 解决方案

#### 1. 限制预生成页面数量

```ts
// app/products/[id]/page.tsx
export async function generateStaticParams() {
  // 只预生成 Top 100 热门商品，其余按需生成
  const topProducts = await db.product.findMany({
    orderBy: { views: 'desc' },
    take: 100,
    select: { id: true }
  })
  return topProducts.map(p => ({ id: String(p.id) }))
}

export const dynamicParams = true // 允许未预生成的路径按需 ISR
```

#### 2. 使用外部缓存替代内存缓存

```js
// next.config.js — 用 Redis 做 ISR 缓存后端
module.exports = {
  cacheHandler: require.resolve('./cache-handler.js'),
  cacheMaxMemorySize: 0, // 禁用内存缓存，全部走 Redis
}
```

```js
// cache-handler.js
const Redis = require('ioredis')
const redis = new Redis(process.env.REDIS_URL)

module.exports = class CacheHandler {
  async get(key) {
    const data = await redis.get(key)
    return data ? JSON.parse(data) : null
  }
  async set(key, data, ctx) {
    const ttl = ctx.revalidate || 3600
    await redis.set(key, JSON.stringify(data), 'EX', ttl)
  }
  async revalidateTag(tag) {
    const keys = await redis.smembers(`tag:${tag}`)
    if (keys.length) await redis.del(...keys)
  }
}
```

---

## QPS 过高问题

### 分层架构

```
用户 → CDN → 反向代理(Nginx) → Rate Limiter → Next.js Server → 数据库
       ①        ②                    ③              ④              ⑤
```

### ① CDN 层缓存（最有效）

```js
// next.config.js — 设置 CDN 缓存头
module.exports = {
  async headers() {
    return [{
      source: '/products/:path*',
      headers: [{
        key: 'Cache-Control',
        // CDN 缓存 60s，客户端缓存 10s，过期后 stale 可用 300s
        value: 's-maxage=60, stale-while-revalidate=300, max-age=10'
      }]
    }]
  }
}
```

### ② Nginx 反向代理缓存 + 限流

```nginx
# 缓存配置
proxy_cache_path /tmp/nginx-cache levels=1:2 keys_zone=next_cache:100m max_size=10g inactive=60m;

# 限流配置
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

server {
    location / {
        proxy_cache next_cache;
        proxy_cache_valid 200 60s;
        proxy_cache_use_stale error timeout updating;
        proxy_pass http://localhost:3000;
    }

    location /api/ {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://localhost:3000;
    }
}
```

### ③ 应用层 Rate Limiting

```ts
// middleware.ts
import { NextRequest, NextResponse } from 'next/server'
import { LRUCache } from 'lru-cache'

const rateLimiter = new LRUCache<string, number[]>({
  max: 10000,
  ttl: 60_000, // 1 分钟窗口
})

export function middleware(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith('/api/')) return

  const ip = req.headers.get('x-forwarded-for') ?? 'unknown'
  const timestamps = rateLimiter.get(ip) ?? []
  const now = Date.now()
  const recent = timestamps.filter(t => now - t < 60_000)

  if (recent.length >= 100) { // 每分钟 100 次
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  recent.push(now)
  rateLimiter.set(ip, recent)
}
```

### ④ SSR → ISR 降级策略

高 QPS 最直接的方案：把 SSR 页面尽量转为 ISR。

```ts
// 之前：每次请求都渲染（SSR）
export default async function ProductPage({ params }) {
  const product = await fetch(`/api/products/${params.id}`, { cache: 'no-store' })
  return <Product data={product} />
}

// 之后：ISR，60 秒重验证，QPS 从 N 降到 1/60
export default async function ProductPage({ params }) {
  const product = await fetch(`/api/products/${params.id}`, {
    next: { revalidate: 60 }
  })
  return <Product data={product} />
}
```

### ⑤ 多实例水平扩展

```bash
# PM2 cluster 模式 — 利用多核
pm2 start npm --name "next" -i max -- start
```

```yaml
# k8s HPA 自动扩缩
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: nextjs-app
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

---

## 生产问题速查表

| 问题 | 优先解决方案 | 效果 |
|------|------------|------|
| SSR 内存高 | Streaming SSR + 精简 Props + LRU 缓存 | 降低 50-70% 峰值内存 |
| ISR 内存高 | `cacheMaxMemorySize: 0` + Redis 外部缓存 | 内存几乎不增长 |
| QPS 高 | SSR 转 ISR + CDN 缓存 + stale-while-revalidate | QPS 降到原来的 1/N |
| API QPS 高 | Nginx 限流 + 应用层 Rate Limit | 保护后端不被打垮 |

**面试建议：** 从架构分层角度（CDN → Nginx → 应用 → 数据库）逐层说明缓解手段，重点讲 ISR 缓存外置到 Redis 和 Streaming SSR 两个 Next.js 特有方案。
