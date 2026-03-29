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
