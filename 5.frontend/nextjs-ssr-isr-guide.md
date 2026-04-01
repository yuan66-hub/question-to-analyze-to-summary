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
