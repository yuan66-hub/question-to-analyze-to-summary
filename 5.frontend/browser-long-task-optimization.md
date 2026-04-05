# 浏览器主线程长任务优化：调度、中断与 DevTools 调试

## 核心问题

浏览器主线程是单线程模型，长任务（>50ms）会阻塞用户交互、渲染和动画，导致页面卡顿。优化目标：将长任务切片，按优先级调度，让高优任务能中断低优任务，保持主线程流畅。

---

## 一、识别长任务

### PerformanceObserver 监控

```js
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    console.log('Long Task:', entry.duration, 'ms', entry);
  }
});
observer.observe({ type: 'longtask', buffered: true });
```

### Long Animation Frames API（Chrome 123+）

比 Long Task API 更精确，能拿到具体脚本和函数信息：

```js
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    console.group(`🔴 Long Frame: ${entry.duration.toFixed(0)}ms`);
    for (const script of entry.scripts) {
      console.log({
        invoker:      script.invoker,            // "BUTTON#search.onclick"
        sourceURL:    script.sourceURL,           // "https://app.com/search.js"
        sourceFnName: script.sourceFunctionName,  // "handleSearch"
        duration:     script.duration,
      });
    }
    console.groupEnd();
  }
});
observer.observe({ type: 'long-animation-frame', buffered: true });
```

---

## 二、任务分片（Time Slicing）

### 1. 让出主线程的方式

```js
function yieldToMain() {
  // 方案1：scheduler.yield()（最优，Chrome 129+）
  if ('scheduler' in globalThis && 'yield' in scheduler) {
    return scheduler.yield();
  }
  // 方案2：MessageChannel（微任务之后、setTimeout 之前执行）
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = resolve;
    ch.port2.postMessage(undefined);
  });
  // 方案3：setTimeout(0)（有 4ms 最小延迟，不推荐高频使用）
}
```

### 2. 分片执行大量数据处理

```js
async function processLargeArray(items, processFn) {
  const CHUNK_TIME = 5; // ms
  let i = 0;
  let startTime = performance.now();

  while (i < items.length) {
    processFn(items[i]);
    i++;

    if (performance.now() - startTime > CHUNK_TIME) {
      await yieldToMain();
      startTime = performance.now();
    }
  }
}
```

---

## 三、基于优先级的任务调度

### 1. Scheduler API（原生方案，Chrome 94+）

```js
// 优先级从高到低：user-blocking > user-visible > background
scheduler.postTask(() => updateSearchResults(), { priority: 'user-blocking' });
scheduler.postTask(() => renderRecommendations(), { priority: 'user-visible' });
scheduler.postTask(() => sendAnalytics(), { priority: 'background' });
```

### 2. AbortController 实现任务中断

```js
let bgController = new AbortController();

scheduler.postTask(() => processBackgroundData(), {
  priority: 'background',
  signal: bgController.signal,
});

function onUserInput() {
  bgController.abort();                         // 中断后台任务
  bgController = new AbortController();

  scheduler.postTask(() => handleUserInput(), {
    priority: 'user-blocking',                   // 立即响应用户
  });
}
```

### 3. 手写优先级调度器（兼容方案，类 React Scheduler）

```js
class PriorityScheduler {
  static IMMEDIATE = 1;     // 用户输入、动画
  static USER_BLOCKING = 2; // 用户可感知的更新
  static NORMAL = 3;        // 普通更新
  static LOW = 4;           // 预加载
  static IDLE = 5;          // 空闲任务

  // 每个优先级对应的超时时间（超时后强制执行，防饿死）
  static TIMEOUT = {
    1: -1,        // 立即执行
    2: 250,       // 250ms
    3: 5000,      // 5s
    4: 10000,     // 10s
    5: Infinity,  // 永不超时，等空闲
  };

  constructor() {
    this.queue = [];
    this.isRunning = false;
    this.currentTask = null;
    this.channel = new MessageChannel();
    this.channel.port1.onmessage = () => this._workLoop();
  }

  scheduleTask(callback, priority = PriorityScheduler.NORMAL) {
    const now = performance.now();
    const task = {
      callback,
      priority,
      expirationTime: now + PriorityScheduler.TIMEOUT[priority],
      cancelled: false,
    };
    this.queue.push(task);
    this._sortQueue();

    if (!this.isRunning) {
      this.isRunning = true;
      this.channel.port2.postMessage(null);
    }

    return { cancel: () => { task.cancelled = true; } };
  }

  _sortQueue() {
    const now = performance.now();
    this.queue.sort((a, b) => {
      const aExpired = a.expirationTime <= now;
      const bExpired = b.expirationTime <= now;
      if (aExpired !== bExpired) return aExpired ? -1 : 1;
      return a.priority - b.priority;
    });
  }

  _workLoop() {
    const startTime = performance.now();
    const FRAME_BUDGET = 5;

    while (this.queue.length > 0) {
      this._sortQueue();
      const task = this.queue[0];

      if (task.cancelled) { this.queue.shift(); continue; }

      const now = performance.now();
      const isExpired = task.expirationTime <= now;
      if (!isExpired && (now - startTime > FRAME_BUDGET)) {
        this.channel.port2.postMessage(null); // 下一帧继续
        return;
      }

      this.currentTask = this.queue.shift();
      const continuationFn = this.currentTask.callback();

      // 支持可恢复任务：callback 返回函数表示未完成
      if (typeof continuationFn === 'function') {
        this.currentTask.callback = continuationFn;
        this.queue.unshift(this.currentTask);
      }
      this.currentTask = null;
    }

    this.isRunning = false;
  }
}
```

**使用示例**：

```js
const scheduler = new PriorityScheduler();

// 可恢复的低优先级任务
function processItems(items) {
  let index = 0;
  function work() {
    const start = performance.now();
    while (index < items.length && performance.now() - start < 3) {
      renderItem(items[index]);
      index++;
    }
    if (index < items.length) return work; // 未完成，返回 continuation
  }
  scheduler.scheduleTask(work, PriorityScheduler.LOW);
}

// 高优先级中断
button.addEventListener('click', () => {
  scheduler.scheduleTask(() => handleClick(), PriorityScheduler.IMMEDIATE);
});
```

---

## 四、`requestIdleCallback`——空闲时段执行

```js
function processIdleWork(deadline) {
  while (taskQueue.length > 0 && deadline.timeRemaining() > 1) {
    const task = taskQueue.shift();
    task();
  }
  if (taskQueue.length > 0) {
    requestIdleCallback(processIdleWork, { timeout: 2000 });
  }
}

requestIdleCallback(processIdleWork);
```

---

## 五、React 并发模式（Fiber + Lane）

React 的并发模式是这套方案的工业级实现：

```
Lanes (优先级通道)
┌──────────────────┐
│ SyncLane         │ ← 离散事件 (click)
│ InputContinuous  │ ← 连续事件 (scroll/drag)
│ DefaultLane      │ ← setState 普通更新
│ TransitionLane   │ ← startTransition 低优
│ IdleLane         │ ← offscreen / 预渲染
└──────────────────┘

Fiber 架构
┌──────┐    ┌──────┐    ┌──────┐
│Fiber │───▶│Fiber │───▶│Fiber │  链表结构，可中断遍历
│  A   │    │  B   │    │  C   │
└──────┘    └──────┘    └──────┘

每处理一个 Fiber 节点后检查：
1. 是否超过 5ms 时间片？
2. 是否有更高优先级任务插入？
→ 是：中断当前渲染，让出主线程
→ 高优先级任务完成后恢复
```

关键机制：

- **Fiber 链表**：将递归的树遍历改为可中断的链表迭代
- **Lane 模型**：用二进制位表示优先级，支持批量合并
- **时间切片**：每 5ms 检查一次是否需要让出
- **`startTransition`**：标记低优先级更新，可被用户输入打断

```jsx
import { startTransition, useDeferredValue } from 'react';

function SearchPage() {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  return (
    <>
      <input onChange={(e) => {
        setQuery(e.target.value);           // 高优先级：立即更新输入框
        startTransition(() => {
          filterResults(e.target.value);     // 低优先级：可中断的过滤
        });
      }} />
      <Results query={deferredQuery} />
    </>
  );
}
```

---

## 六、Chrome DevTools 调试分析长任务

### 1. Performance 面板录制

```
1. F12 → Performance 面板
2. 勾选配置：
   ☑ Screenshots
   ☑ Web Vitals
   ☑ CPU throttling → 4x slowdown（模拟中低端设备）
   ☑ Network → Fast 3G（模拟弱网）
3. ⏺ 录制 → 执行用户操作 → Stop
4. 录制 3-5 秒，聚焦单个交互，避免数据噪声
```

### 2. 识别长任务

```
┌─ Performance 面板 ──────────────────────────────────────────┐
│                                                             │
│  Main:                                                      │
│  ┌─────────────────────────────────────────┐                │
│  │ Task (120ms)             ⚠ 红色三角标记  │ ← 长任务 >50ms │
│  │ ┌────────────────────────────────────┐  │                │
│  │ │ ┌───────────┐ ┌────────────────┐  │  │                │
│  │ │ │ parseData │ │ renderList     │  │  │                │
│  │ │ │  45ms     │ │  68ms ⚠       │  │  │                │
│  │ │ └───────────┘ └────────────────┘  │  │                │
│  │ └────────────────────────────────────┘  │                │
│  └─────────────────────────────────────────┘                │
│                                                             │
│  ⚠ 右上角红色三角 = Long Task                                │
│  超过 50ms 部分有红色斜线填充                                 │
│  灰色条纹区域 = 主线程被阻塞                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3. 火焰图（Flame Chart）逐层下钻

```
点击长任务 → 火焰图展开调用栈

Task ████████████████████████████████████████ 156ms
 └─ Event(click) ██████████████████████████████ 152ms
    └─ handleSearch ████████████████████████████ 148ms
       ├─ fetchAndParse █████████████ 62ms
       │  ├─ JSON.parse █████ 23ms
       │  └─ transformData ██████ 38ms     ← 热点函数 ⚠
       │     └─ Array.map ████ 35ms
       └─ renderResults ██████████████ 82ms ← 最大热点 ⚠
          ├─ createElement ████ 18ms
          ├─ computeStyles ████████ 41ms   ← Layout Thrashing
          └─ appendChild ███ 15ms

颜色含义：
  黄色 = JavaScript 执行
  紫色 = Layout / Recalculate Style
  绿色 = Paint / Composite
  灰色 = 系统任务 / Idle

快捷键：W/S 缩放，A/D 水平移动
```

### 4. Bottom-Up 面板——找最耗时函数

```
点击长任务 → 底部 Bottom-Up 标签

Self Time ▼ │ Total Time │ Activity
────────────┼────────────┼──────────────────────────────
  41.2 ms   │   41.2 ms  │ Recalculate Style
  35.1 ms   │   38.0 ms  │ transformData  (app.js:142)  ⚠
  18.3 ms   │   18.3 ms  │ createElement
  15.0 ms   │   15.0 ms  │ appendChild
  12.4 ms   │   62.0 ms  │ fetchAndParse  (api.js:87)
   8.2 ms   │   82.0 ms  │ renderResults  (render.js:23) ⚠

Self Time = 函数自身执行时间（不含子调用）→ 高则函数本身有问题
Total Time = 函数总时间（含子调用）→ 高但 Self 低则问题在子函数
点击函数名 → 跳转到 Sources 面板对应源码行
```

### 5. Call Tree 面板——从入口追踪完整路径

```
切换到 Call Tree 标签

Total Time │ Self Time │ Activity
───────────┼───────────┼──────────────────────────────────
 152 ms    │   2 ms    │ ▼ Event(click)
 148 ms    │   4 ms    │   ▼ handleSearch     (search.js:15)
  62 ms    │  12 ms    │     ▼ fetchAndParse  (api.js:87)
  23 ms    │  23 ms    │       ● JSON.parse
  38 ms    │  35 ms    │       ▼ transformData (app.js:142)
  35 ms    │  35 ms    │         ● items.map   (app.js:158)
  82 ms    │   8 ms    │     ▼ renderResults  (render.js:23)
  41 ms    │  41 ms    │       ● Recalculate Style
  18 ms    │  18 ms    │       ● createElement
  15 ms    │  15 ms    │       ● appendChild

完整瓶颈链路：click → handleSearch → renderResults → Recalculate Style
```

### 6. 强制同步布局（Layout Thrashing）检测

```
火焰图中出现紫色块 + 底部 Warning：

⚠ Warning: Forced reflow while executing JavaScript
Layout Forced  │  41.2 ms  │  render.js:34
First invalidated: render.js:28  ← 哪行代码导致了样式失效
```

**问题代码与修复**：

```js
// ❌ 问题：读写交替 = Layout Thrashing
items.forEach(item => {
  item.el.style.width = newWidth + 'px';    // 写（触发样式失效）
  const height = item.el.offsetHeight;       // 读（强制同步布局）
  item.el.style.height = height * 2 + 'px'; // 写
});

// ✅ 修复：读写分离
const heights = items.map(item => item.el.offsetHeight); // 批量读
items.forEach((item, i) => {
  item.el.style.width = newWidth + 'px';                 // 批量写
  item.el.style.height = heights[i] * 2 + 'px';
});
```

### 7. performance.measure 标记业务函数

在代码中插桩，在 DevTools Timings 轨道中显示自定义标记：

```js
function handleSearch(query) {
  performance.mark('search-start');

  performance.mark('parse-start');
  const data = parseResponse(rawData);
  performance.mark('parse-end');
  performance.measure('parseResponse', 'parse-start', 'parse-end');

  performance.mark('transform-start');
  const transformed = transformData(data);
  performance.mark('transform-end');
  performance.measure('transformData', 'transform-start', 'transform-end');

  performance.mark('render-start');
  renderResults(transformed);
  performance.mark('render-end');
  performance.measure('renderResults', 'render-start', 'render-end');

  performance.measure('handleSearch(total)', 'search-start', 'render-end');
}
```

在 Timings 轨道显示为：

```
handleSearch(total) ████████████████████████████ 148ms
parseResponse       ████████ 23ms
transformData            █████████████ 38ms
renderResults                         ████████████████ 82ms

→ 一眼看出 renderResults 占了 55% 的时间
```

### 8. 封装可复用的性能追踪工具

```js
const IS_DEV = process.env.NODE_ENV === 'development';

export function trace(label, fn) {
  if (!IS_DEV) return fn();
  performance.mark(`${label}-start`);
  const result = fn();
  performance.mark(`${label}-end`);
  performance.measure(label, `${label}-start`, `${label}-end`);
  const entry = performance.getEntriesByName(label).pop();
  if (entry && entry.duration > 16) {
    console.warn(`⚠ Slow: ${label} took ${entry.duration.toFixed(1)}ms`);
  }
  return result;
}

export async function traceAsync(label, fn) {
  if (!IS_DEV) return fn();
  performance.mark(`${label}-start`);
  const result = await fn();
  performance.mark(`${label}-end`);
  performance.measure(label, `${label}-start`, `${label}-end`);
  return result;
}

// 使用
const data = trace('parseResponse', () => parseResponse(rawData));
const transformed = trace('transformData', () => transformData(data));
trace('renderResults', () => renderResults(transformed));
```

### 9. Console API 辅助分析

```js
// CPU 采样 → 结果在 JavaScript Profiler 面板
console.profile('handleSearch');
handleSearch(query);
console.profileEnd('handleSearch');

// 快速计时
console.time('renderList');
renderList(items);
console.timeEnd('renderList'); // → renderList: 82.34ms

// 在 Performance 录制中插入标记
console.timeStamp('chunk-0-start');
```

---

## 七、完整调试流程示例

以搜索功能卡顿为例，从发现到修复：

```
步骤1: 录制
  Performance → Record → 输入搜索词 → Stop

步骤2: 定位长任务
  Main 轨道 → 找到 click 事件后的红色 ⚠ 长任务 (156ms)

步骤3: 火焰图下钻
  Task (156ms)
   └─ click (152ms)
      └─ handleSearch (148ms)          search.js:15
         ├─ fetchAndParse (62ms)       api.js:87
         │  └─ transformData (38ms)    app.js:142   [Self: 35ms]
         └─ renderResults (82ms)       render.js:23 [Self: 8ms]
            └─ Recalculate Style (41ms) ⚠ Forced Reflow

步骤4: Bottom-Up 确认热点
  Self Time 排序：
    1. Recalculate Style  41ms  ← 强制同步布局
    2. transformData      35ms  ← JS 计算过重
    3. createElement      18ms  ← DOM 创建过多

步骤5: 定位根因
  问题1: render.js:31 读写交替导致 Layout Thrashing
  问题2: app.js:142 对 10000 条数据同步 map 计算
  问题3: render.js:45 一次性创建所有 DOM 节点

步骤6: 针对性优化
  修复1: 读写分离，消除强制同步布局
  修复2: transformData 分片 + Web Worker
  修复3: 虚拟列表，只渲染可视区域 DOM

步骤7: 验证
  再次录制 → 同样操作 → Task 从 156ms 降至 12ms ✅
```

---

## 八、决策树

```
任务耗时 > 50ms？
├─ 否 → 直接执行
└─ 是 → 需要优化
    ├─ 可以移到 Worker？
    │   └─ 是 → Web Worker / OffscreenCanvas
    ├─ 需要操作 DOM？
    │   └─ 是 → 任务分片 + 优先级调度
    │       ├─ 原生 Scheduler API 可用？ → scheduler.postTask()
    │       ├─ React 项目？ → startTransition + useDeferredValue
    │       └─ 其他 → 手写优先级调度器
    └─ 不紧急？
        └─ requestIdleCallback
```

---

## 九、速查表

| 目标 | 工具/面板 | 操作 |
|------|----------|------|
| 找到长任务 | Performance → Main 轨道 | 找红色 ⚠ 标记 |
| 定位具体函数 | 火焰图 + Bottom-Up | Self Time 排序 |
| 追踪调用链 | Call Tree | 从入口逐层展开 |
| 检测布局抖动 | Summary → Warning | 看 Forced Reflow 警告 |
| 标记业务函数 | `performance.measure()` | Timings 轨道查看 |
| 精确到函数名 | LoAF API | `entry.scripts[].sourceFunctionName` |
| 快速计时 | `console.time/timeEnd` | Console 面板 |
| CPU 采样 | `console.profile` | JavaScript Profiler |
| 生产环境监控 | LoAF + PerformanceObserver | 上报到监控平台 |
