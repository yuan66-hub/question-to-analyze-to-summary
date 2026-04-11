# 分页竞态问题（Race Condition）

## 问题背景

频繁切换页码时，先发的请求可能后返回，导致页面显示的数据与当前页码不一致。

```
点击第2页 → 请求A发出（慢）
点击第3页 → 请求B发出（快）
请求B返回 → 显示第3页 ✓
请求A返回 → 覆盖为第2页 ✗  ← 问题所在
```

---

## 方案一：AbortController 取消过期请求（推荐）

```js
let controller = null;

async function fetchPage(page) {
  // 取消上一次请求
  controller?.abort();
  controller = new AbortController();

  try {
    const res = await fetch(`/api/list?page=${page}`, {
      signal: controller.signal,
    });
    const data = await res.json();
    renderList(data);
  } catch (e) {
    if (e.name === 'AbortError') return; // 被取消的请求，静默忽略
    throw e;
  }
}
```

**优点**：真正取消网络请求，节省带宽和服务端资源。

## 方案二：请求标识（ID 比对）

```js
let latestRequestId = 0;

async function fetchPage(page) {
  const requestId = ++latestRequestId;

  const res = await fetch(`/api/list?page=${page}`);
  const data = await res.json();

  // 只有最新的请求才更新 UI
  if (requestId === latestRequestId) {
    renderList(data);
  }
}
```

**优点**：实现简单，兼容不支持 AbortController 的场景（如 WebSocket）。

---

## 方案三：React 中的处理

### useEffect cleanup

```jsx
useEffect(() => {
  const controller = new AbortController();

  fetch(`/api/list?page=${page}`, { signal: controller.signal })
    .then(res => res.json())
    .then(setList)
    .catch(e => {
      if (e.name !== 'AbortError') throw e;
    });

  return () => controller.abort(); // 页码变化时自动取消上次请求
}, [page]);
```

### 自定义 Hook 封装

```js
function useLatestFetch(url) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    fetch(url, { signal: controller.signal })
      .then(res => res.json())
      .then(data => { setData(data); setLoading(false); })
      .catch(e => {
        if (e.name !== 'AbortError') { setLoading(false); throw e; }
      });

    return () => controller.abort();
  }, [url]);

  return { data, loading };
}

// 使用
const { data, loading } = useLatestFetch(`/api/list?page=${page}`);
```

---

## 方案四：Vue 中的处理

### watchEffect 自动清理

```vue
<script setup>
import { ref, watchEffect } from 'vue';

const page = ref(1);
const list = ref([]);

watchEffect((onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());

  fetch(`/api/list?page=${page.value}`, { signal: controller.signal })
    .then(res => res.json())
    .then(data => { list.value = data; })
    .catch(e => {
      if (e.name !== 'AbortError') throw e;
    });
});
</script>
```

---

## 方案对比

| 方案 | 取消网络请求 | 实现复杂度 | 适用场景 |
|------|:-----------:|:----------:|---------|
| AbortController | 是 | 低 | fetch/axios 请求 |
| 请求 ID 比对 | 否 | 最低 | 任意异步操作 |
| useEffect cleanup | 是 | 低 | React 组件 |
| watchEffect onCleanup | 是 | 低 | Vue 3 组件 |

## 面试回答要点

1. **定位问题**：先发后至导致数据覆盖，本质是异步竞态
2. **首选 AbortController**：真正取消请求，配合框架的清理机制（useEffect return / onCleanup）
3. **兜底用请求 ID**：不支持取消的场景用 ID 比对丢弃过期响应
4. **补充优化**：可配合切换时加 loading 态、禁用分页按钮防止连续点击
