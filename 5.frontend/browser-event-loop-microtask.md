# 浏览器事件循环：微任务机制与调度 API

## 核心模型

浏览器主线程的执行模型可以概括为宏任务的循环，每个宏任务内部包含同步代码和微任务清空：

```
宏任务(同步 + 微任务) → [渲染?] → 宏任务(同步 + 微任务) → [渲染?] → ...
```

---

## 一、事件循环完整流程

```
┌─ 宏任务 ───────────────────────────────┐
│  1. 同步代码执行（调用栈）               │
│  2. 调用栈清空                          │
│  3. 微任务 checkpoint（清空全部微任务）    │
│     └─ 微任务中产生的微任务也在此轮清空    │
├─────────────────────────────────────────┤
│  4. 渲染机会（浏览器决定是否渲染）         │
│     - requestAnimationFrame              │
│     - Style → Layout → Paint            │
├─────────────────────────────────────────┤
│  5. requestIdleCallback（如有空闲时间）   │
└─────────────────────────────────────────┘
              ↓ 取下一个宏任务
```

**渲染不是每轮都发生**——通常约 16.6ms 一次（60fps），由浏览器自行决定。

---

## 二、宏任务与微任务分类

### 宏任务（Task）

| 来源 | 示例 |
|------|------|
| script 整体 | `<script>` 首次执行 |
| setTimeout / setInterval | 定时器回调 |
| I/O | 网络请求完成、文件读取 |
| UI 事件 | click、scroll、keydown |
| MessageChannel | `port.postMessage()` |
| requestIdleCallback | 空闲回调 |

### 微任务（Microtask）

| 来源 | 示例 |
|------|------|
| Promise | `.then()` / `.catch()` / `.finally()` |
| MutationObserver | DOM 变更观察 |
| queueMicrotask | `queueMicrotask(() => {})` |
| async/await | `await` 之后的代码 |

---

## 三、微任务为什么必须一次性清空

ECMAScript 规范要求：每当调用栈清空时，必须执行 **microtask checkpoint**——循环取出微任务队列中的所有任务直到队列为空，然后才能进入下一步。

### 1. 保证状态一致性

```js
Promise.resolve()
  .then(() => { state.a = 1; })
  .then(() => { state.b = state.a + 1; });
```

如果微任务之间插入渲染或其他宏任务，用户可能看到 `a=1, b=undefined` 的中间态。一次清空保证 Promise 链的**原子性**——外部观察者只能看到最终结果。

### 2. Promise 链的语义需要

Promise `.then()` 的设计意图是"同步逻辑的异步表达"。A→B→C 的 Promise 链在语义上是一个连续操作，不应被渲染帧或定时器打断。

### 3. MutationObserver 的正确性

```js
el.setAttribute('a', '1');  // 触发 MutationObserver 微任务
el.setAttribute('b', '2');  // 再触发
// 当前同步代码结束 → 微任务一次清空 → observer 回调拿到完整的变更批次
```

如果不一次清空，observer 可能只看到部分 DOM 变更，导致逻辑错误。

### 4. 避免宏任务之间的竞态

```js
fetch('/api').then(res => {
  // 如果这里不是微任务一次清空，
  // 中间可能插入 setTimeout 回调，修改了共享状态
  updateUI(res);
});
```

### 副作用：微任务可以"饿死"渲染

正因为必须一次清空，如果微任务无限递归产生新微任务，浏览器永远无法进入渲染阶段：

```js
function loop() {
  Promise.resolve().then(loop); // 永远有新微任务，页面卡死
}
loop();
```

这也是为什么长任务应该用 `setTimeout` / `requestAnimationFrame` 拆分到宏任务。

---

## 四、执行顺序验证

```js
console.log('1');                    // 宏任务1：同步

setTimeout(() => {                   // 注册宏任务2
  console.log('5');                  // 宏任务2：同步
  Promise.resolve().then(() => {
    console.log('6');                // 宏任务2：微任务
  });
}, 0);

Promise.resolve().then(() => {
  console.log('3');                  // 宏任务1：微任务
  Promise.resolve().then(() => {
    console.log('4');                // 微任务中产生的微任务，同轮清空
  });
});

console.log('2');                    // 宏任务1：同步
```

**输出：`1 2 3 4 5 6`**

```
宏任务1                         宏任务2
├─ 同步: 1, 2                  ├─ 同步: 5
├─ 微任务: 3                   ├─ 微任务: 6
├─ 微任务(新产生): 4            │
├─ [渲染?]                     ├─ [渲染?]
```

---

## 五、async/await 的微任务拆解

```js
async function foo() {
  console.log('A');          // 同步
  await bar();               // bar() 同步执行，await 之后的代码变成微任务
  console.log('C');          // 微任务
}

async function bar() {
  console.log('B');          // 同步
}

foo();
console.log('D');
```

**输出：`A B D C`**

`await` 本质是 `Promise.then()` 的语法糖，`await` 之后的代码在微任务中执行。

---

## 六、requestAnimationFrame vs requestIdleCallback

两者都在宏任务和微任务体系之外，但**插入时机完全不同**：

```
宏任务 → 微任务清空 → 【rAF 回调】→ Style → Layout → Paint → Composite → 【rIC 回调】
                       ↑ 渲染前                                          ↑ 渲染后有空闲时
```

### requestAnimationFrame（rAF）

**时机**：下一次渲染**之前**，约 16.6ms 一次（跟随屏幕刷新率）

**用途**：视觉相关的工作——动画、DOM 读写、样式变更

```js
function animate() {
  element.style.transform = `translateX(${x++}px)`; // 保证每帧只更新一次
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
```

**关键特性**：
- 页面不可见时（切到后台标签页）自动暂停，节省资源
- 一帧内多次调用 rAF，回调会**合并到同一帧**执行
- 回调参数是高精度时间戳 `DOMHighResTimeStamp`

### requestIdleCallback（rIC）

**时机**：一帧渲染**完成后**，如果还有剩余时间才执行

```
  一帧 16.6ms
  ├── 宏任务 + 微任务: 4ms
  ├── rAF + 渲染: 6ms
  ├── 空闲时间: 6.6ms ← rIC 在这里执行
  └── 下一帧开始
```

**用途**：低优先级、不紧急的工作——数据上报、预加载、缓存计算

```js
requestIdleCallback((deadline) => {
  // deadline.timeRemaining() 返回当前帧剩余毫秒数
  while (deadline.timeRemaining() > 0 && tasks.length > 0) {
    doTask(tasks.shift());
  }
  if (tasks.length > 0) {
    requestIdleCallback(doMore); // 没做完，等下一次空闲
  }
}, { timeout: 2000 }); // 最多等 2s，超时强制执行
```

**关键特性**：
- 回调提供 `deadline` 对象，可以判断剩余时间
- **不保证执行**——如果主线程一直很忙，可能迟迟不调用
- `timeout` 参数可以设置最大等待时间，防止饿死
- **不应该在 rIC 中修改 DOM**——会触发强制回流，破坏已完成的渲染

### 核心对比

| | rAF | rIC |
|---|---|---|
| **执行时机** | 渲染前 | 渲染后空闲时 |
| **频率** | 每帧必调（~60fps） | 不保证，有空闲才调 |
| **适合做** | 动画、DOM 操作 | 数据上报、预计算 |
| **能操作 DOM 吗** | 推荐 | 不推荐 |
| **后台标签页** | 暂停 | 暂停 |
| **回调参数** | timestamp | deadline 对象 |
| **兼容性** | 全部主流浏览器 | Safari 不支持 |

### 实际应用场景

```js
// rAF：平滑动画
function smoothScroll() {
  window.scrollBy(0, 2);
  if (window.scrollY < target) {
    requestAnimationFrame(smoothScroll);
  }
}

// rIC：非关键数据上报
requestIdleCallback(() => {
  analytics.send(performanceData);
});

// React Scheduler 的启发：
// rIC 频率太低（一秒约 20 次），React 自己用 MessageChannel 实现了 5ms 时间切片
```

### Safari 兼容方案

Safari 不支持 `requestIdleCallback`，常用 polyfill：

```js
window.requestIdleCallback = window.requestIdleCallback || function (cb) {
  const start = Date.now();
  return setTimeout(() => {
    cb({
      didTimeout: false,
      timeRemaining: () => Math.max(0, 50 - (Date.now() - start)),
    });
  }, 1);
};
```

---

## 七、面试一句话总结

> 事件循环的本质是 **宏任务驱动、微任务保序**：每个宏任务执行完同步代码后，必须一次性清空所有微任务（包括执行过程中新产生的），保证逻辑原子性；然后浏览器决定是否渲染（rAF 在渲染前执行，rIC 在渲染后空闲时执行），再取下一个宏任务。
