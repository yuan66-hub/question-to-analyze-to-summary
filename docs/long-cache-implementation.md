# 长缓存实现方案

## 1. HTTP 强缓存（浏览器端）

### Content Hash 文件名 + 长 Cache-Control

```nginx
# Nginx 配置
location /static/ {
    # 带 hash 的静态资源，缓存 1 年
    add_header Cache-Control "public, max-age=31536000, immutable";
}

location /index.html {
    # 入口文件不缓存
    add_header Cache-Control "no-cache";
}
```

**关键点：** 构建工具（Webpack/Vite）输出文件名带 contenthash，如 `app.3a7b2c.js`，内容变则文件名变，实现**缓存自动失效**。

```js
// webpack
output: {
  filename: '[name].[contenthash:8].js',
  chunkFilename: '[name].[contenthash:8].chunk.js',
}
```

### 分层缓存策略

| 资源类型 | 缓存策略 | 原因 |
|---------|---------|------|
| HTML 入口 | `no-cache` / `max-age=0` | 保证获取最新资源引用 |
| JS/CSS (带 hash) | `max-age=1y, immutable` | 内容变则 URL 变 |
| 图片/字体 (带 hash) | `max-age=1y, immutable` | 同上 |
| API 响应 | `max-age=60` / `stale-while-revalidate` | 按业务需求 |

## 2. Service Worker 缓存

```js
// sw.js - Cache First 策略（适合长缓存资源）
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      // 命中缓存直接返回，否则请求网络并存入缓存
      return cached || fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open('v1').then((cache) => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
```

**常用策略：**

- **Cache First** — 静态资源，优先缓存
- **Network First** — API 数据，优先网络
- **Stale While Revalidate** — 先返回缓存，后台更新

## 3. 内存/本地存储缓存（应用层）

### Map 内存缓存 + TTL

```ts
class LongCache<T> {
  private cache = new Map<string, { data: T; expiry: number }>();

  set(key: string, data: T, ttlMs: number) {
    this.cache.set(key, { data, expiry: Date.now() + ttlMs });
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }
}
```

### IndexedDB 持久化缓存（大数据量）

```ts
async function cacheToIDB(key: string, data: any, ttlMs: number) {
  const db = await openDB('app-cache', 1, {
    upgrade(db) { db.createObjectStore('cache'); },
  });
  await db.put('cache', { data, expiry: Date.now() + ttlMs }, key);
}

async function getFromIDB(key: string) {
  const db = await openDB('app-cache', 1);
  const entry = await db.get('cache', key);
  if (!entry || Date.now() > entry.expiry) return null;
  return entry.data;
}
```

## 4. 服务端缓存

### Redis 长缓存

```ts
// 带版本号的缓存 key，数据变更时递增版本
const cacheKey = `product:${id}:v${version}`;
await redis.set(cacheKey, JSON.stringify(data), 'EX', 86400 * 30); // 30 天
```

### CDN 缓存

```nginx
# 源站响应头
Cache-Control: public, max-age=31536000, s-maxage=31536000
Surrogate-Control: max-age=31536000
```

**主动失效：** 内容更新时调用 CDN Purge API 清除缓存。

## 5. 核心原则

```
内容寻址 = 最佳长缓存策略

URL 包含内容 hash → 内容不变则 URL 不变 → 可安全设置超长过期时间
                   → 内容变则 URL 变   → 自动获取新版本
```

**最佳实践总结：**

1. **静态资源**：contenthash 文件名 + `immutable` + 1 年过期
2. **入口文件**：`no-cache`，每次验证
3. **API 数据**：根据业务设置合理 TTL + `stale-while-revalidate`
4. **大数据**：IndexedDB 持久化 + 版本控制
5. **服务端**：Redis 多级缓存 + CDN + 主动失效机制
