# Node.js 核心原理

> 涵盖事件循环、模块系统、流与 Buffer、进程与线程、内存管理、HTTP 网络、错误处理、性能监控、安全、TypeScript 集成、现代 API

---

## 目录

1. [事件循环与异步](#1-事件循环与异步)
2. [模块系统](#2-模块系统)
3. [流与 Buffer](#3-流与-buffer)
4. [进程与线程](#4-进程与线程)
5. [内存管理与 GC](#5-内存管理与-gc)
6. [HTTP 与网络](#6-http-与网络)
7. [文件系统](#7-文件系统)
8. [错误处理](#8-错误处理)
9. [性能优化与监控](#9-性能优化与监控)
10. [安全](#10-安全)
11. [TypeScript 与 Node.js](#11-typescript-与-nodejs)
12. [现代 API 与生态](#12-现代-api-与生态)

---

## 1. 事件循环与异步

### Node.js 事件循环的六个阶段

```
       ┌───────────────────────────┐
    ┌─>│         timers            │ ← setTimeout / setInterval 回调
    │  └──────────────┬────────────┘
    │  ┌──────────────┴────────────┐
    │  │     pending callbacks     │ ← I/O 错误回调（上一轮延迟执行）
    │  └──────────────┬────────────┘
    │  ┌──────────────┴────────────┐
    │  │       idle, prepare       │ ← 仅 Node.js 内部使用
    │  └──────────────┬────────────┘
    │  ┌──────────────┴────────────┐
    │  │           poll            │ ← 执行 I/O 回调，若队列为空则等待
    │  └──────────────┬────────────┘
    │  ┌──────────────┴────────────┐
    │  │           check           │ ← setImmediate 回调
    │  └──────────────┬────────────┘
    │  ┌──────────────┴────────────┐
    └──│      close callbacks      │ ← socket.on('close') 等
       └───────────────────────────┘
```

**微任务队列**：
- `process.nextTick` 队列：**优先级最高**，在每个阶段切换前清空
- `Promise` 微任务队列：在 nextTick 队列后执行

---

### 执行顺序分析

```javascript
setTimeout(() => console.log('setTimeout'), 0);
setImmediate(() => console.log('setImmediate'));
Promise.resolve().then(() => console.log('promise'));
process.nextTick(() => console.log('nextTick'));
console.log('sync');
```

输出顺序：
```
sync
nextTick
promise
setTimeout  ← 或 setImmediate（在主模块中顺序不确定）
setImmediate
```

**注意**：在 I/O 回调内部，`setImmediate` **一定先于** `setTimeout` 执行。

---

### process.nextTick 的风险

`process.nextTick` 属于微任务，在当前操作完成后、进入下一个事件循环阶段之前，立即执行整个 nextTick 队列。

**风险：递归调用导致 I/O 饥饿（I/O Starvation）**

```javascript
// ❌ 危险：nextTick 递归调用导致事件循环永远无法进入 poll 阶段
function recursiveNextTick() {
  process.nextTick(recursiveNextTick); // I/O 回调永远无法执行！
}
```

**最佳实践**：使用 `setImmediate` 替代 `process.nextTick` 做递归调度，让 I/O 有机会执行。

---

### 背压（Backpressure）问题

背压是指**数据生产速度超过消费速度**时，缓冲区无限增长的问题。

```javascript
// ❌ 不处理背压
readable.on('data', (chunk) => {
  writable.write(chunk); // write() 返回 false 时应该暂停读取
});

// ✅ 正确处理：使用 pipe（自动处理背压）
readable.pipe(writable);

// ✅ 手动处理背压
readable.on('data', (chunk) => {
  const canContinue = writable.write(chunk);
  if (!canContinue) {
    readable.pause(); // 暂停读取
    writable.once('drain', () => readable.resume()); // 缓冲区清空后恢复
  }
});
```

---

## 2. 模块系统

### CommonJS 与 ESM 的核心区别

| 特性 | CommonJS (CJS) | ES Modules (ESM) |
|------|----------------|------------------|
| 语法 | `require` / `module.exports` | `import` / `export` |
| 加载时机 | **同步**，运行时加载 | **异步**，编译时静态分析 |
| 导出性质 | 值的拷贝（基本类型是快照） | **实时绑定**（live binding） |
| `this` | `module.exports` | `undefined` |
| 循环依赖 | 返回未完成的导出对象 | 静态分析可检测 |
| 顶层 `await` | 不支持 | **支持**（Node.js 14.8+） |

**ESM 实时绑定**：
```javascript
// counter.mjs
export let count = 0;
export function increment() { count++; }

// main.mjs
import { count, increment } from './counter.mjs';
console.log(count); // 0
increment();
console.log(count); // 1 ← ESM 实时绑定，值已更新

// CommonJS 版本：count 是值拷贝，不会更新
```

---

### CommonJS 循环依赖

```javascript
// a.js
const b = require('./b');
console.log('a: b.done =', b.done);
exports.done = true;

// b.js
const a = require('./a');
console.log('b: a.done =', a.done);
exports.done = true;

// 输出：
// b: a.done = undefined  ← a 尚未执行完，拿到的是未完成的导出对象
// a: b.done = true
```

---

### 混用 ESM 和 CommonJS

```javascript
// ESM 中引入 CJS（支持）
import cjsModule from './legacy.cjs';
// 只能导入 default，不能 named import CJS 导出

// CJS 中引入 ESM（不直接支持，需要动态 import）
async function loadESM() {
  const { default: fn } = await import('./modern.mjs');
  fn();
}

// package.json 配置双格式包（Dual Package）
{
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs"
    }
  }
}
```

---

## 3. 流与 Buffer

### 四种流类型

| 类型 | 描述 | 示例 |
|------|------|------|
| **Readable** | 可读流 | `fs.createReadStream`、`http.IncomingMessage` |
| **Writable** | 可写流 | `fs.createWriteStream`、`http.ServerResponse` |
| **Duplex** | 可读可写（独立） | `net.Socket`、TCP connection |
| **Transform** | 转换流（读写联动） | `zlib.createGzip`、`crypto.createCipher` |

### Transform 流实现

```javascript
const { Transform } = require('stream');

class UpperCaseTransform extends Transform {
  _transform(chunk, encoding, callback) {
    this.push(chunk.toString().toUpperCase());
    callback();
  }

  _flush(callback) {
    this.push('\n[END]');
    callback();
  }
}

process.stdin
  .pipe(new UpperCaseTransform())
  .pipe(process.stdout);
```

### Buffer.alloc vs Buffer.allocUnsafe

```javascript
// Buffer.alloc：安全分配，初始化为 0（推荐用于安全场景）
const safe = Buffer.alloc(1024); // 全部填充 0，防止内存信息泄漏

// Buffer.allocUnsafe：不初始化，可能包含旧内存数据（更快）
const fast = Buffer.allocUnsafe(1024); // 必须完全写入后再使用
```

**安全准则**：对外暴露的网络数据用 `Buffer.alloc`；内部纯写入场景可用 `Buffer.allocUnsafe`。

### 处理 5GB 大文件

```javascript
async function processLargeCSV(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let batch = [];
  let lineCount = 0;

  for await (const line of rl) {
    if (lineCount === 0) { lineCount++; continue; } // 跳过 header

    batch.push(parseLine(line));
    lineCount++;

    if (batch.length >= 1000) {
      await db.batchInsert(batch); // 批量写入，减少 DB 压力
      batch = [];
    }
  }

  if (batch.length > 0) await db.batchInsert(batch);
}
```

**关键原则**：
- 避免 `fs.readFileSync` 读取大文件（会导致 OOM）
- 使用 `pipeline` 而非手动 `pipe`（错误时自动销毁所有流）
- 批量写入比逐行写入 DB 性能提升 10-100 倍

---

## 4. 进程与线程

### Node.js 的单线程与 libuv 线程池

Node.js **JavaScript 执行是单线程**的，但 libuv 维护一个**线程池**（默认 4 个线程）处理：
- 文件系统 I/O（`fs` 模块）
- DNS 查询（`dns.lookup`）
- `crypto` 中的某些操作（如 `pbkdf2`、`scrypt`）
- `zlib` 压缩

```bash
# 调整线程池大小（最大 128）
UV_THREADPOOL_SIZE=16 node app.js
```

**关键点**：`net`、`http` 模块的 TCP/UDP 网络 I/O 使用**操作系统异步 I/O**（epoll/kqueue），**不占用线程池**。

---

### cluster 模块与 worker_threads 模块

| 特性 | cluster | worker_threads |
|------|---------|----------------|
| 本质 | 多**进程**（fork） | 多**线程** |
| 内存 | 独立内存空间 | 共享内存（SharedArrayBuffer） |
| 通信 | IPC 消息传递 | SharedArrayBuffer / MessageChannel |
| 崩溃隔离 | Worker 崩溃不影响 Master | 线程崩溃可能影响整个进程 |
| 适用场景 | HTTP 服务负载均衡 | CPU 密集型计算（图像处理、加密） |

```javascript
// cluster：HTTP 服务多核利用
if (cluster.isPrimary) {
  for (let i = 0; i < os.cpus().length; i++) {
    cluster.fork();
  }
  cluster.on('exit', (worker) => cluster.fork()); // 自动重启
} else {
  http.createServer((req, res) => res.end('Hello')).listen(3000);
}

// worker_threads：CPU 密集型任务（零拷贝共享内存）
const sharedBuffer = new SharedArrayBuffer(1024 * 1024 * 100); // 100MB
const worker = new Worker(__filename, { workerData: { sharedBuffer } });
```

### 优雅关机（Graceful Shutdown）

```javascript
const server = http.createServer(app);
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  server.close(async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, 5000)); // 等待请求完成
      await db.end();
      await mqConnection.close();
      process.exit(0);
    } catch (err) {
      process.exit(1);
    }
  });

  // 超时强制退出（防止卡死）
  setTimeout(() => process.exit(1), 30000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Docker/K8s 停止容器
process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C
process.on('unhandledRejection', (reason) => {
  console.error('未处理的 Promise 拒绝:', reason);
  gracefulShutdown('unhandledRejection');
});
```

---

## 5. 内存管理与 GC

### process.memoryUsage() 各字段含义

| 字段 | 含义 | 泄漏信号 |
|------|------|---------|
| `rss` | 进程物理内存总量（含代码段、堆、栈） | native 模块或 Buffer 泄漏 |
| `heapTotal` | V8 堆已分配总量 | 随 heapUsed 增长自动扩展 |
| `heapUsed` | **最关键**：JS 对象实际占用 | GC 后仍持续增长 = 泄漏 |
| `external` | C++ 对象占用（Buffer、native 插件） | Buffer 未释放时增长 |
| `arrayBuffers` | ArrayBuffer/SharedArrayBuffer | WebSocket 或文件处理未关闭时增长 |

**判断泄漏**：`heapUsed` 在每次 GC 后的基线值持续上升（而非正常的锯齿波形）。

---

### 常见内存泄漏模式

```javascript
// 1. 全局变量意外增长
global.requestLog = []; // ❌ 没有清理机制
// ✅ 使用 LRUCache 或 Map + TTL 定期清理

// 2. 事件监听器未移除
emitter.on('data', handleData);
req.on('close', () => emitter.off('data', handleData)); // ✅ 连接关闭时清理

// 3. 闭包引用大型对象
function createFixed() {
  const bigData = Buffer.alloc(1024 * 1024 * 100);
  const length = bigData.length; // 只保留需要的值，不保留整个 Buffer
  return function() { console.log(length); };
}

// 4. 定时器未清除
class Service {
  start() { this._timer = setInterval(() => this.poll(), 1000); }
  stop() { clearInterval(this._timer); } // ✅ 必须清理
}

// 5. 缓存无限增长
const LRU = require('lru-cache');
const cache = new LRU({ max: 500, ttl: 1000 * 60 * 10 }); // ✅ 限制大小
```

---

### V8 GC 策略

**V8 堆结构**：
```
┌─────────────────────────────────────────┐
│              V8 Heap                    │
├────────────────┬────────────────────────┤
│  Young Gen     │      Old Gen           │
│  (1-8MB)       │  (默认 ~1.5GB)         │
├──────┬─────────┤                        │
│ From │   To   │  Large Object Space     │
│Space │  Space  │  Code Space            │
└──────┴─────────┴────────────────────────┘
```

**Scavenge GC（新生代）**：
- 采用 Cheney's 半空间算法
- From Space → 存活对象复制到 To Space → 交换角色
- 速度极快（毫秒级），对象经过 2 次 Scavenge 存活后晋升到老生代

**Mark-Sweep & Mark-Compact（老生代）**：
- Mark-Sweep：标记所有可达对象，清除不可达对象（会产生内存碎片）
- Mark-Compact：在 Mark-Sweep 基础上压缩内存，消除碎片（较慢）
- **增量标记**（Incremental Marking）：将标记分成小步骤，减少 Stop-The-World 时间

```bash
node --max-old-space-size=4096  # 设置老生代最大 4GB
node --max-semi-space-size=128  # 设置新生代 Semi Space 大小
```

---

## 6. HTTP 与网络

### 原生 http 模块

```javascript
const http = require('http');

const server = http.createServer((req, res) => {
  // req: http.IncomingMessage（Readable Stream）
  // res: http.ServerResponse（Writable Stream）

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: body }));
  });
});

server.listen(3000, '0.0.0.0');
```

Express 是对 `http.createServer` 的封装，核心是中间件洋葱模型。

### HTTP/2 服务器

```javascript
const http2 = require('http2');

const server = http2.createSecureServer({
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.crt'),
});

server.on('stream', (stream, headers) => {
  const path = headers[':path'];

  // Server Push：主动推送关联资源
  if (path === '/') {
    stream.pushStream({ ':path': '/style.css' }, (err, pushStream) => {
      if (!err) {
        pushStream.respond({ ':status': 200, 'content-type': 'text/css' });
        pushStream.end(fs.readFileSync('style.css'));
      }
    });
  }

  stream.respond({ ':status': 200 });
  stream.end('<html>Hello HTTP/2</html>');
});
```

### WebSocket vs SSE

```javascript
// WebSocket（双向通信）
const wss = new WebSocket.Server({ port: 8080 });
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    // 广播
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    });
  });
});

// SSE（服务器单向推送，基于 HTTP）
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ time: Date.now() })}\n\n`);
  }, 1000);
  req.on('close', () => clearInterval(interval));
});
```

| 特性 | WebSocket | SSE |
|------|-----------|-----|
| 方向 | 双向 | 服务器→客户端单向 |
| 协议 | ws:// 自定义帧格式 | HTTP/1.1 长连接 |
| 自动重连 | 需手动实现 | **浏览器原生支持** |
| 代理/防火墙 | 可能被拦截 | HTTP 天然兼容 |
| 适用场景 | 游戏、聊天、协同编辑 | 日志流、通知、AI 流式输出 |

---

## 7. 文件系统

### readFile vs createReadStream

| 场景 | 推荐方案 |
|------|---------|
| < 1MB 的配置文件 | `readFile` |
| > 10MB 的日志/数据文件 | `createReadStream` |
| 需要实时处理数据 | `createReadStream` |
| 文件需要完整内容后处理 | `readFile` |

```javascript
// 流式读取（适合大文件）
const stream = fs.createReadStream('huge-log.txt', {
  encoding: 'utf8',
  highWaterMark: 64 * 1024, // 每次读取 64KB
});

// 文件监听（生产推荐 chokidar）
const chokidar = require('chokidar');
const watcher = chokidar.watch('./src', {
  ignored: /node_modules/,
  persistent: true,
});
watcher.on('change', debounce((path) => {
  console.log(`文件修改：${path}`);
}, 100));
```

---

## 8. 错误处理

### 操作性错误 vs 程序性错误

```javascript
// 自定义错误类型
class AppError extends Error {
  constructor(message, code, statusCode = 500, isOperational = true) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

class NotFoundError extends AppError {
  constructor(resource) {
    super(`${resource} not found`, 'NOT_FOUND', 404);
  }
}

// Express 错误中间件
app.use((err, req, res, next) => {
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
    });
  }
  // 程序性错误：记录日志，触发重启
  console.error('严重错误:', err);
  res.status(500).json({ message: 'Internal Server Error' });
  process.exit(1);
});
```

### async/await 错误处理

```javascript
// Go 风格错误处理（避免 try/catch 嵌套）
async function to(promise) {
  try {
    const data = await promise;
    return [null, data];
  } catch (err) {
    return [err, null];
  }
}

async function processOrder(orderId) {
  const [orderErr, order] = await to(getOrder(orderId));
  if (orderErr) return handleOrderError(orderErr);

  const [userErr, user] = await to(getUser(order.userId));
  if (userErr) return handleUserError(userErr);

  const [chargeErr, result] = await to(chargeUser(user, order.amount));
  if (chargeErr) return handleChargeError(chargeErr);

  return result;
}
```

---

## 9. 性能优化与监控

### CPU 性能分析

```bash
# 内建 profiler
node --prof app.js
node --prof-process isolate-*.log > profile.txt

# clinic.js（推荐，自动生成火焰图）
npm install -g clinic
clinic flame -- node app.js

# 0x（专用火焰图工具）
npm install -g 0x
0x app.js
```

**火焰图解读**：
- X 轴表示时间占比，Y 轴是调用栈深度
- 宽而平的块 = CPU 热点

### 全链路监控方案

```javascript
// 1. 结构化日志（配合 ELK Stack）
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { pid: process.pid, service: 'api-server' },
});

// 2. 请求链路追踪（OpenTelemetry）
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: 'http://jaeger:4318/v1/traces' }),
  instrumentations: [getNodeAutoInstrumentations()],
});

// 3. 指标收集（Prometheus）
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP 请求耗时（毫秒）',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [10, 50, 100, 200, 500, 1000, 2000],
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    httpRequestDuration
      .labels(req.method, req.route?.path || req.path, res.statusCode)
      .observe(Date.now() - start);
  });
  next();
});

// 4. 健康检查
app.get('/health', async (req, res) => {
  const [dbOk, redisOk] = await Promise.all([
    db.query('SELECT 1').then(() => true).catch(() => false),
    redis.ping().then(() => true).catch(() => false),
  ]);
  res.status(dbOk && redisOk ? 200 : 503).json({
    status: 'ok',
    dependencies: { db: dbOk ? 'ok' : 'down', redis: redisOk ? 'ok' : 'down' },
  });
});
```

---

## 10. 安全

### 常见安全漏洞与防护

```javascript
// 1. 路径遍历（Path Traversal）
// ❌ 危险
const filePath = path.join(__dirname, req.query.name); // ../../../../etc/passwd

// ✅ 修复：只取文件名
const safeName = path.basename(req.query.name);
const filePath = path.join(__dirname, 'uploads', safeName);
if (!filePath.startsWith(path.join(__dirname, 'uploads'))) {
  return res.status(403).send('Forbidden');
}

// 2. 命令注入（Command Injection）
// ❌ 危险
exec(`convert ${req.body.filename} output.pdf`);
// 攻击者输入："a; rm -rf /"

// ✅ 修复：使用 execFile + 参数白名单
const filename = /^[\w\-. ]+$/.test(req.body.filename) ? req.body.filename : null;
if (!filename) return res.status(400).send('Invalid filename');
execFile('convert', [filename, 'output.pdf'], callback);

// 3. 原型链污染
function safeMerge(target, source) {
  for (let key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    target[key] = source[key];
  }
}

// 4. 使用 helmet 中间件
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"] } },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));
```

### Node.js 权限模型（Node.js 20+）

```bash
# 只允许读取特定目录
node --experimental-permission \
  --allow-fs-read=/home/user/data \
  --allow-fs-write=/tmp \
  app.js
```

```javascript
// 代码中检查权限
const { permission } = require('node:process');
if (permission.has('fs.read', '/sensitive/path')) {
  // 有读取权限才执行
}
```

---

## 11. TypeScript 与 Node.js

### tsconfig.json 针对 Node.js 的关键配置

```json
{
  "compilerOptions": {
    "target": "ES2022",           // 匹配 Node.js 18+ 支持的 ES 版本
    "module": "Node16",           // 支持 CJS 和 ESM 混用
    "moduleResolution": "Node16", // 新的模块解析算法
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,      // 允许 import CJS 模块
    "skipLibCheck": true,
    "sourceMap": true,
    "declaration": true,          // 生成 .d.ts 声明文件
    "incremental": true,          // 增量编译
    "types": ["node"],
    "paths": { "@/*": ["./src/*"] }
  }
}
```

### 为 Express 中间件编写类型

```typescript
import { Request, Response, NextFunction } from 'express';

// 扩展 Request 类型
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: string };
      requestId?: string;
    }
  }
}

// 高阶函数：创建带权限验证的中间件
function requireRole(role: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.user.role !== role) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// 带类型的路由 handler
app.post<{}, CreateUserResponse, CreateUserBody>(
  '/users',
  async (req, res) => {
    const { name, email } = req.body; // 类型安全
    const user = await UserService.create({ name, email });
    res.status(201).json(user);
  }
);
```

---

## 12. 现代 API 与生态

### Node.js 18+ 内建 Fetch API

```javascript
// 基本使用
const response = await fetch('https://api.example.com/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'value' }),
  signal: AbortSignal.timeout(5000), // Node.js 17.3+ 内建超时
});

if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
const data = await response.json();

// 流式响应（AI 接口等）
const streamResponse = await fetch('/api/stream');
const reader = streamResponse.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  process.stdout.write(decoder.decode(value));
}
```

| 场景 | 推荐 |
|------|------|
| 简单 HTTP 请求 | 内建 `fetch` |
| 需要请求/响应拦截器 | `axios` |
| 流式响应 | `fetch` (ReadableStream 更原生) |
| 需要上传进度 | `axios` |

---

### AsyncLocalStorage（异步上下文追踪）

```javascript
const { AsyncLocalStorage } = require('async_hooks');
const requestContext = new AsyncLocalStorage();

// Express 中间件：为每个请求创建上下文
app.use((req, res, next) => {
  const context = {
    requestId: crypto.randomUUID(),
    userId: req.user?.id,
    startTime: Date.now(),
  };

  requestContext.run(context, next);
});

// 任意位置读取当前请求的上下文（无需参数传递）
function getLogger() {
  const ctx = requestContext.getStore();
  return {
    info: (msg) => logger.info({ requestId: ctx?.requestId, userId: ctx?.userId, msg }),
    error: (msg) => logger.error({ requestId: ctx?.requestId, userId: ctx?.userId, msg }),
  };
}
```

---

## 速查表

| 主题 | 核心知识点 |
|------|---------|
| 事件循环 | 6 阶段（timers→poll→check）、nextTick 优先级最高、微任务清空时机 |
| 模块 | CJS 同步运行时/值拷贝，ESM 静态分析/实时绑定 |
| 流 | pipe 自动背压、pipeline 自动清理、Transform 转换流 |
| 进程 | cluster 多进程负载均衡，worker_threads CPU 密集任务 |
| 内存 | heapUsed 持续增长 = 泄漏，新生代 Scavenge，老生代 Mark-Sweep |
| 安全 | 路径遍历、命令注入、原型污染、helmet 中间件 |
| 监控 | pino 结构化日志、OpenTelemetry 链路追踪、Prometheus 指标 |
| 现代 API | 内建 fetch、AsyncLocalStorage 请求上下文、权限模型 |
