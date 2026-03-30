# Node.js 内存泄漏排查指南

## 概述

Node.js 内存泄漏通常表现为 `heapUsed` 持续增长、RSS 内存不断上升。排查的核心方法是生成堆快照对比，结合 Chrome DevTools 分析对象增长。

---

## 核心工具

### 1. 基础内存监控

启动时添加监控标志：
```bash
node --expose-gc --inspect app.js
```

代码中定期输出内存使用：
```javascript
setInterval(() => {
  const mem = process.memoryUsage();
  console.log({
    rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
    external: Math.round(mem.external / 1024 / 1024) + 'MB'
  });
}, 5000);
```

### 2. heapdump - 堆快照生成

安装：
```bash
npm install heapdump
```

生成快照：
```javascript
const heapdump = require('heapdump');
heapdump.writeSnapshot('./heap-' + Date.now() + '.heapsnapshot');
```

### 3. clinic.js - 自动分析

安装：
```bash
npm install -g clinic
```

工具集：
| 命令 | 用途 |
|------|------|
| `clinic doctor` | 初诊，快速诊断问题类型 |
| `clinic heapprofiler` | 生成火焰图，精确定位 |

```bash
clinic doctor -- node app.js
clinic heapprofiler -- node app.js
```

### 4. v8-profiler-node8 - 运行时追踪

安装：
```bash
npm install v8-profiler-node8
```

使用：
```javascript
const profiler = require('v8-profiler-node8');

profiler.startProfiling();

setTimeout(() => {
  const profile = profiler.stopProfiling();
  require('fs').writeFileSync('./profile.json', JSON.stringify(profile));
}, 30000);
```

---

## 排查步骤

### Step 1: 确认内存泄漏

观察 `heapUsed` 是否持续增长，RSS 是否不断上升。如果只是短暂峰值后回落，属于正常 GC 行为。

### Step 2: 生成对比快照

```javascript
// 在稳定状态或问题初期生成 snapshot1
heapdump.writeSnapshot('./snapshot1.heapsnapshot');

// 运行一段时间后生成 snapshot2（泄漏累积后）
heapdump.writeSnapshot('./snapshot2.heapsnapshot');
```

### Step 3: Chrome DevTools 分析

1. 打开 `chrome://inspect`
2. 连接 Node 进程
3. 加载两个快照
4. 使用 **Comparison** 视图对比
5. 查找 **Detached** 字样的 DOM 树（常见泄漏源）

---

## 常见泄漏模式

| 类型 | 特征 | 排查方法 |
|------|------|----------|
| 全局变量 | `global.xxx` 持续增长 | 代码搜索全局变量引用 |
| 闭包 | 函数引用外部变量无法释放 | 堆快照中查找闭包 |
| 事件监听器 | 未移除的 `on('data')` 累积 | `process.on('exit')` 统计监听器数量 |
| 缓存 | Map/Set 无限增长 | 快照中查找大 Map/Set 对象 |
| Timer | `setInterval` 未清除 | 搜索定时器引用链 |
| console.log | 生产环境频繁调用 | 生产环境关闭或限流 |

---

## 快速定位代码的技巧

### 使用 console.trace 标记检查点

```javascript
console.trace('Memory check point A');
```

### FinalizationRegistry 追踪对象

```javascript
const registry = new FinalizationRegistry((name) => {
  console.log(`Object ${name} was garbage collected`);
});
```

---

## 推荐工具组合

```bash
npm install clinic heapdump --save
```

**排查流程：**
1. `clinic doctor` - 快速诊断问题是否存在
2. `clinic heapprofiler` - 生成火焰图定位热点
3. `heapdump` + Chrome DevTools - 深度分析对象增长

---

## 生产环境注意事项

1. **慎用 v8-profiler**：性能开销大，生产环境慎用
2. **heapdump 异步写入**：不阻塞主线程，但频繁生成影响性能
3. **设置内存上限**：防止泄漏导致系统内存耗尽
   ```bash
   node --max-old-space-size=4096 app.js
   ```
4. **监控告警**：设置内存阈值，超过后自动生成快照

---

## process.memoryUsage() 各字段详解

```javascript
const mem = process.memoryUsage();
// {
//   rss: 45678592,        // Resident Set Size
//   heapTotal: 20971520,  // V8 堆总大小
//   heapUsed: 15234567,   // V8 堆已用
//   external: 1234567,    // C++ 对象占用的内存
//   arrayBuffers: 234567  // ArrayBuffer/SharedArrayBuffer 占用
// }
```

| 字段 | 全称 | 含义 | 泄漏信号 |
|------|------|------|---------|
| **rss** | Resident Set Size | 进程占用的物理内存总量，包括代码段、堆、栈 | 持续增长（通常是外部模块或 native 模块泄漏） |
| **heapTotal** | Heap Total | V8 引擎分配的堆内存总量（已申请） | 随 heapUsed 增长而自动扩展 |
| **heapUsed** | Heap Used | 当前实际使用的堆内存（JS 对象、闭包等） | **最关键指标**，持续增长且 GC 后不降 → 内存泄漏 |
| **external** | External | Node.js C++ 层对象占用（Buffer、native 模块） | Buffer 未释放、native 插件泄漏时增长 |
| **arrayBuffers** | ArrayBuffers | ArrayBuffer 和 SharedArrayBuffer 占用 | 大文件处理或 WebSocket 未关闭时增长 |

### 判断泄漏的关键方法

```javascript
// 定期采样，判断趋势
const samples = [];

setInterval(() => {
  const mem = process.memoryUsage();
  samples.push({
    time: Date.now(),
    heapUsed: mem.heapUsed,
    rss: mem.rss,
  });

  // 保留最近 10 个样本
  if (samples.length > 10) samples.shift();

  // 线性回归判断趋势
  if (samples.length >= 5) {
    const trend = samples[samples.length - 1].heapUsed - samples[0].heapUsed;
    const avgGrowth = trend / samples.length;

    if (avgGrowth > 1024 * 1024) { // 平均每采样周期增长 > 1MB
      console.warn(`⚠️ 疑似内存泄漏：平均每周期增长 ${(avgGrowth / 1024 / 1024).toFixed(2)} MB`);
    }
  }
}, 30000);
```

---

## Docker / Kubernetes 容器环境调试

### 容器内调试限制

容器环境下调试 Node.js 内存泄漏有额外挑战：
- 容器默认不开启调试端口
- 堆快照文件需要挂载到宿主机
- K8s Pod 被 OOMKilled 后难以取证

### Docker 调试配置

```dockerfile
# Dockerfile.debug - 调试专用镜像
FROM node:20-alpine

# 安装调试工具
RUN npm install -g clinic heapdump

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .

# 暴露调试端口
EXPOSE 3000
EXPOSE 9229

# 启动时开启 inspector 和 expose-gc
CMD ["node", "--inspect=0.0.0.0:9229", "--expose-gc", "--max-old-space-size=512", "src/app.js"]
```

```yaml
# docker-compose.debug.yml
version: '3.8'
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile.debug
    ports:
      - "3000:3000"
      - "9229:9229"  # Chrome DevTools 调试端口
    volumes:
      - ./heapdumps:/app/heapdumps  # 堆快照挂载到宿主机
    environment:
      - NODE_ENV=development
      - HEAP_DUMP_PATH=/app/heapdumps
    mem_limit: 512m  # 限制内存，便于触发和观察泄漏
```

### Kubernetes 环境取证

```bash
# 1. 对运行中的 Pod 执行命令（前提：Pod 包含调试工具）
kubectl exec -it <pod-name> -- node -e "
const heapdump = require('heapdump');
heapdump.writeSnapshot('/tmp/heap-' + Date.now() + '.heapsnapshot');
console.log('Snapshot written');
"

# 2. 从 Pod 拷贝堆快照到本地
kubectl cp <pod-name>:/tmp/heap-*.heapsnapshot ./local-dump/

# 3. 使用 ephemeral container 调试（K8s 1.23+）
kubectl debug -it <pod-name> \
  --image=node:20 \
  --target=<container-name> \
  -- bash

# 4. 查看 OOMKilled 的 Pod 信息
kubectl describe pod <pod-name> | grep -A5 "OOMKilled\|Memory\|Limits"

# 5. 监控内存趋势（配合 kubectl top）
watch -n 5 kubectl top pod <pod-name> --containers
```

### K8s 内存限制与 Node.js 的关系

```yaml
# 关键：Node.js 默认堆大小约为系统内存的 25%
# 在容器中，系统内存 = 容器 limits.memory
resources:
  requests:
    memory: "256Mi"
  limits:
    memory: "512Mi"  # Node.js 默认堆约 128MB，可能不够

# 解决方案：显式设置 Node.js 堆大小
args:
  - "node"
  - "--max-old-space-size=400"  # 略小于 limits.memory，留余量给 rss 其他部分
  - "src/app.js"
```

---

## 常见框架中的内存泄漏模式

### Express.js 常见泄漏

```javascript
// ❌ 问题 1：中间件中存储请求引用
const requestCache = new Map(); // 全局缓存，无过期机制

app.use((req, res, next) => {
  requestCache.set(req.id, req); // 永远不清理
  next();
});

// ✅ 修复：使用 WeakMap 或添加清理逻辑
const requestCache = new WeakMap(); // 请求结束后自动 GC

// ❌ 问题 2：路由中注册事件监听器但不清理
app.get('/stream', (req, res) => {
  const dataSource = new EventEmitter();
  dataSource.on('data', (chunk) => res.write(chunk)); // req 结束后 listener 仍存在！

  // ✅ 修复：监听 req 的 close 事件清理
  req.on('close', () => {
    dataSource.removeAllListeners('data');
    dataSource.destroy?.();
  });
});

// ❌ 问题 3：session 存储无限增长
app.use(session({
  secret: 'key',
  store: new MemoryStore(), // 默认 MemoryStore 没有过期清理！
}));

// ✅ 修复：使用带 TTL 的存储
const RedisStore = require('connect-redis').default;
app.use(session({
  store: new RedisStore({ client: redisClient, ttl: 86400 }),
  secret: 'key',
}));
```

### NestJS 常见泄漏

```typescript
// ❌ 问题 1：Injectable 服务中存储无限增长的数据
@Injectable()
export class CacheService {
  private cache = new Map<string, any>(); // 无过期，无大小限制

  set(key: string, value: any) {
    this.cache.set(key, value); // 持续增长
  }
}

// ✅ 修复：使用 LRU 缓存或添加 TTL
@Injectable()
export class CacheService implements OnModuleDestroy {
  private cache = new LRUCache<string, any>({ max: 1000, ttl: 1000 * 60 * 10 });

  onModuleDestroy() {
    this.cache.clear(); // 模块销毁时清理
  }
}

// ❌ 问题 2：WebSocket 网关中未清理订阅
@WebSocketGateway()
export class EventsGateway {
  private subscriptions = new Map<string, Subscription>();

  handleConnection(client: Socket) {
    const sub = this.eventStream$.subscribe((event) => {
      client.emit('event', event);
    });
    this.subscriptions.set(client.id, sub); // 如果 disconnect 未处理则泄漏
  }

  handleDisconnect(client: Socket) {
    // ✅ 必须在断连时取消订阅
    this.subscriptions.get(client.id)?.unsubscribe();
    this.subscriptions.delete(client.id);
  }
}

// ❌ 问题 3：循环依赖导致 Provider 无法 GC
@Injectable()
export class ServiceA {
  constructor(private serviceB: ServiceB) {} // ServiceA → ServiceB → ServiceA
}
```

### Cluster 模式下的内存监控

```javascript
const cluster = require('cluster');
const os = require('os');

if (cluster.isPrimary) {
  // 主进程：监控各 Worker 内存
  const workers = {};

  for (let i = 0; i < os.cpus().length; i++) {
    const worker = cluster.fork();
    workers[worker.id] = worker;

    worker.on('message', (msg) => {
      if (msg.type === 'memoryUsage') {
        console.log(`Worker ${worker.id}:`, msg.data);

        // 内存超限，重启 Worker
        if (msg.data.heapUsed > 400 * 1024 * 1024) { // 400MB
          console.warn(`Worker ${worker.id} 内存超限，重启中...`);
          worker.kill();
        }
      }
    });
  }

  cluster.on('exit', (worker) => {
    console.log(`Worker ${worker.id} 退出，重新 fork`);
    cluster.fork();
  });

} else {
  // Worker 进程：定期上报内存
  setInterval(() => {
    process.send({
      type: 'memoryUsage',
      workerId: cluster.worker.id,
      data: process.memoryUsage(),
    });
  }, 10000);

  // 启动应用
  require('./app');
}
```

---

## Prometheus + Node.js 监控集成

### 安装依赖

```bash
npm install prom-client express
```

### 配置 Prometheus 指标

```javascript
const promClient = require('prom-client');
const express = require('express');

// 启用默认指标（包括内存、CPU、GC 等）
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({
  prefix: 'nodejs_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// 自定义业务内存指标
const heapUsedGauge = new promClient.Gauge({
  name: 'nodejs_heap_used_bytes_custom',
  help: '当前 V8 堆已用内存',
  collect() {
    this.set(process.memoryUsage().heapUsed);
  },
});

const arrayBuffersGauge = new promClient.Gauge({
  name: 'nodejs_arraybuffers_bytes',
  help: 'ArrayBuffer 占用内存',
  collect() {
    this.set(process.memoryUsage().arrayBuffers || 0);
  },
});

// 内存泄漏告警计数器
const memoryLeakAlerts = new promClient.Counter({
  name: 'nodejs_memory_leak_alerts_total',
  help: '内存泄漏告警次数',
  labelNames: ['severity'],
});

// 暴露 /metrics 端点
const app = express();
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});
```

### Prometheus 告警规则

```yaml
# prometheus-alerts.yml
groups:
  - name: nodejs-memory
    rules:
      # 堆内存持续增长告警
      - alert: NodeJSHeapMemoryLeaking
        expr: |
          increase(nodejs_heap_used_bytes_custom[10m]) > 50 * 1024 * 1024
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Node.js 进程内存持续增长"
          description: "实例 {{ $labels.instance }} 的堆内存 10 分钟内增长超过 50MB"

      # 堆内存使用率过高
      - alert: NodeJSHeapMemoryHigh
        expr: |
          nodejs_heap_used_bytes_custom / nodejs_heap_size_total_bytes > 0.85
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Node.js 堆内存使用率过高"
          description: "堆内存使用率 {{ $value | humanizePercentage }} 超过 85%"

      # RSS 异常增长
      - alert: NodeJSRSSMemoryHigh
        expr: nodejs_process_resident_memory_bytes > 1073741824  # 1GB
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Node.js 进程 RSS 超过 1GB"
```

### Grafana Dashboard 关键面板

```
推荐监控面板：
1. Heap Used（折线图）— 观察趋势，是否持续上升
2. GC Duration（热图）— GC 频率和耗时，频繁 GC 是压力信号
3. Event Loop Lag（折线图）— 超过 100ms 说明主线程被阻塞
4. Active Handles（折线图）— 持续增长说明事件监听器泄漏
5. HTTP Requests Rate — 请求量与内存增长的相关性分析
```

---

## WeakMap / WeakRef 最佳实践

### WeakMap：缓存与外部对象关联数据

```javascript
// ✅ 正确使用：用 DOM 元素或对象作为 key，value 会随 key 被 GC 自动清理
const domMetadata = new WeakMap();

function attachMetadata(element, data) {
  domMetadata.set(element, data);
  // 当 element 被 GC，data 也自动清理，无需手动删除
}

// ✅ 私有属性模拟（替代闭包）
const privateData = new WeakMap();

class User {
  constructor(name) {
    privateData.set(this, { name, loginCount: 0 });
  }

  login() {
    const data = privateData.get(this);
    data.loginCount++;
  }

  get loginCount() {
    return privateData.get(this).loginCount;
  }
}
// User 实例被 GC 时，privateData 中的记录也自动清理
```

### WeakRef：持有弱引用，不阻止 GC

```javascript
// ✅ 缓存场景：允许 GC 回收缓存项
class WeakCache {
  #cache = new Map(); // key → WeakRef(value)

  set(key, value) {
    this.#cache.set(key, new WeakRef(value));
  }

  get(key) {
    const ref = this.#cache.get(key);
    if (!ref) return undefined;

    const value = ref.deref(); // 尝试获取原始值
    if (value === undefined) {
      // 值已被 GC，清理缓存条目
      this.#cache.delete(key);
      return undefined;
    }
    return value;
  }
}

// ✅ 配合 FinalizationRegistry 做清理通知
const registry = new FinalizationRegistry((key) => {
  console.log(`缓存项 '${key}' 已被 GC 清理`);
  // 可在这里触发重新计算或日志记录
});

function cacheWithTracking(cache, key, value) {
  cache.set(key, value);
  registry.register(value, key); // value 被 GC 时，registry 回调会被调用
}
```

### WeakSet：追踪对象集合

```javascript
// ✅ 记录"已处理"状态，不阻止 GC
const processedRequests = new WeakSet();

async function processOnce(request) {
  if (processedRequests.has(request)) {
    return; // 已处理，跳过
  }
  processedRequests.add(request);
  await doProcess(request);
  // request 对象超出作用域后，WeakSet 中的条目自动清理
}
```
