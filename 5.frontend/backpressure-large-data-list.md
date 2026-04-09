# 接口大数据列表背压（Backpressure）策略

## 核心问题

接口一次返回海量数据 → 全量接收并解析 → 内存瞬间飙升 → 页面卡顿甚至崩溃。

**背压的本质**：消费者告诉生产者"我还没处理完，你先别发"。

## 完整背压链路

```
数据库 → 后端服务 → 网络传输 → 前端消费 → 用户可见
  ↑         ↑          ↑          ↑
  各层都需要背压控制，任何一环失控都会内存暴增
```

---

## 一、前端背压策略

### 1. 流式拉取（ReadableStream）

```javascript
async function fetchLargeList(url, onChunk) {
  const response = await fetch(url);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // 按换行符切割（NDJSON 格式）
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 保留不完整的最后一行

    for (const line of lines) {
      if (line.trim()) {
        await onChunk(JSON.parse(line)); // await 产生背压
      }
    }
  }
}
```

关键点：`await onChunk()` — 消费端未处理完，生产端暂停读取，这就是背压。

### 2. 游标分页 + 消费控制

当服务端不支持流式时，用游标分页 + 消费节奏控制模拟背压：

```javascript
async function fetchWithBackpressure({ fetchPage, process, pageSize = 200 }) {
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const { data, nextCursor } = await fetchPage({ cursor, pageSize });

    // 等待消费完成后才拉下一页 —— 背压核心
    await process(data);

    cursor = nextCursor;
    hasMore = !!nextCursor;
  }
}

fetchWithBackpressure({
  fetchPage: ({ cursor, pageSize }) =>
    api.get('/items', { params: { cursor, limit: pageSize } }),
  process: async (batch) => {
    renderBatch(batch);
    await new Promise(r => requestIdleCallback(r));
  },
});
```

### 3. 虚拟滚动 + 增量渲染

```
┌──────────────────────────┐
│     Viewport (可见区)     │  ← 只渲染这部分 DOM
├──────────────────────────┤
│   Buffer Zone (缓冲区)    │  ← 上下各预渲染少量
├──────────────────────────┤
│   未渲染区域（仅保留数据）  │  ← 不创建 DOM 节点
└──────────────────────────┘
```

配合 `react-window` / `vue-virtual-scroller` 等库，DOM 节点始终保持在几十个级别。

### 4. Web Worker 卸载解析压力

大数据的 JSON 解析会阻塞主线程，将解析移入 Worker：

```javascript
// worker.js
self.onmessage = async (e) => {
  const { url } = e.data;
  const res = await fetch(url);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    const parsed = lines.filter(l => l.trim()).map(JSON.parse);
    self.postMessage({ type: 'batch', data: parsed });
  }
  self.postMessage({ type: 'done' });
};
```

---

## 二、后端背压策略

背压必须是端到端的。前端做了背压，后端不配合，后端自身也会因全量查询而 OOM。

### 1. 数据库 → 后端：游标 / 流式读取

```java
// ❌ 全量加载到内存
List<Item> items = jdbcTemplate.queryForList("SELECT * FROM items");

// ✅ 游标流式读取
@Transactional(readOnly = true)
public void streamItems(Consumer<Item> consumer) {
    jdbcTemplate.query(
        con -> {
            PreparedStatement ps = con.prepareStatement(
                "SELECT * FROM items",
                ResultSet.TYPE_FORWARD_ONLY,
                ResultSet.CONCUR_READ_ONLY
            );
            ps.setFetchSize(200); // 每次从 DB 拉 200 条
            return ps;
        },
        (rs, rowNum) -> {
            consumer.accept(mapRow(rs));
            return null;
        }
    );
}
```

### 2. 后端 → 前端：流式响应（NDJSON）

边查边吐，不攒完再发：

```javascript
// Node.js 流式响应
app.get('/api/items', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');

  const cursor = db.collection('items').find().batchSize(200);

  for await (const doc of cursor) {
    const canContinue = res.write(JSON.stringify(doc) + '\n');

    if (!canContinue) {
      // TCP 缓冲区满，前端消费不过来 → 暂停写入
      await new Promise(resolve => res.once('drain', resolve));
    }
  }

  res.end();
});
```

`res.write()` 返回 `false` + 监听 `drain` — Node.js 内置背压机制。

### 3. Stream Pipeline（推荐）

```javascript
const { pipeline, Transform } = require('stream');

app.get('/api/items', (req, res) => {
  const dbStream = db.query('SELECT * FROM items').stream();

  const toNDJSON = new Transform({
    objectMode: true,
    transform(row, _, cb) {
      cb(null, JSON.stringify(row) + '\n');
    }
  });

  // pipeline 自动处理背压和错误
  pipeline(dbStream, toNDJSON, res, (err) => {
    if (err) console.error('Stream failed:', err);
  });
});
```

---

## 三、后端不配合时的前端降级方案

```javascript
async function degradedBackpressure(totalPages) {
  const CONCURRENCY = 3; // 控制并发，不打满

  for (let i = 0; i < totalPages; i += CONCURRENCY) {
    const batch = Array.from(
      { length: Math.min(CONCURRENCY, totalPages - i) },
      (_, j) => fetch(`/api/items?page=${i + j + 1}`)
    );

    const results = await Promise.all(batch);

    for (const res of results) {
      const data = await res.json();
      await renderAndYield(data); // 渲染完再拉下一批
    }
  }
}
```

---

## 四、各层背压手段对比

| 层级 | 不处理的后果 | 背压手段 |
|------|------------|---------|
| **DB → 服务** | OOM，服务崩溃 | 游标查询、`fetchSize`、流式读取 |
| **服务内部** | 线程/协程阻塞堆积 | 有界队列、限流、响应式流（Reactor/RxJava） |
| **服务 → 前端** | 响应体过大，网络超时 | chunked 传输、NDJSON、SSE、`drain` 事件 |
| **多服务之间** | 上游打爆下游 | 消息队列（Kafka）、gRPC flow control |

## 五、前端策略对比

| 策略 | 内存控制 | 实现复杂度 | 需要服务端配合 |
|------|---------|-----------|--------------|
| 流式拉取（NDJSON/SSE） | 极好 | 中 | 是 |
| 游标分页 + 消费控制 | 好 | 低 | 部分 |
| 虚拟滚动 | 渲染层好 | 低（有库） | 否 |
| Web Worker 解析 | 主线程好 | 中 | 否 |
| AbortController 取消 | 防堆积 | 低 | 否 |

---

## 六、面试回答要点

背压必须是端到端的，前端四层 + 后端三层形成完整体系：

**前端四层背压**：
1. **网络层**：`ReadableStream` 的 `reader.read()` 控制拉取节奏
2. **数据层**：分页请求，上一页处理完才请求下一页
3. **渲染层**：虚拟滚动，只渲染可视区域
4. **计算层**：Web Worker 隔离，`requestIdleCallback` 让出主线程

**后端三层背压**：
1. **数据库层**：游标查询，设置 `fetchSize`，不全量加载
2. **服务层**：Stream / Pipeline 边读边写，监听 `drain`
3. **传输层**：chunked 编码、NDJSON / SSE 流式协议

任何一环缺失，压力就会在该层堆积。
