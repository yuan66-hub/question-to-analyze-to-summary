# 计时器劫持模拟（Timer Hijacking / Fake Timers）

## 核心思路

替换全局的 `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`，用同步队列控制时间推进，实现对时间的完全掌控。

这是 Jest `jest.useFakeTimers()` 和 Sinon `sinon.useFakeTimers()` 的核心原理。

---

## 最简实现

```js
function useFakeTimers() {
  const originals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    Date: globalThis.Date,
  };

  let now = 0;        // 虚拟时钟
  let id = 0;         // 递增 timer ID
  const timers = [];  // 待执行队列（简化用数组，生产级用最小堆）

  // ---- 替换 setTimeout ----
  globalThis.setTimeout = (cb, delay = 0, ...args) => {
    const timerId = ++id;
    timers.push({ id: timerId, cb, args, time: now + delay, interval: null });
    return timerId;
  };

  // ---- 替换 setInterval ----
  globalThis.setInterval = (cb, delay = 0, ...args) => {
    const timerId = ++id;
    timers.push({ id: timerId, cb, args, time: now + delay, interval: delay });
    return timerId;
  };

  // ---- 替换 clear ----
  globalThis.clearTimeout = globalThis.clearInterval = (timerId) => {
    const idx = timers.findIndex((t) => t.id === timerId);
    if (idx !== -1) timers.splice(idx, 1);
  };

  // ---- 替换 Date.now ----
  globalThis.Date = class FakeDate extends originals.Date {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  };

  return {
    // 推进时间 ms 毫秒，按时间顺序触发到期回调
    tick(ms) {
      const target = now + ms;
      while (true) {
        timers.sort((a, b) => a.time - b.time);
        const next = timers[0];
        if (!next || next.time > target) break;

        now = next.time;
        timers.shift();

        // interval 需要重新入队
        if (next.interval !== null) {
          timers.push({ ...next, time: now + next.interval });
        }

        next.cb(...next.args);
      }
      now = target;
    },

    // 触发所有待执行 timer（直到队列清空）
    runAll() {
      const limit = 1000; // 防止无限循环
      let count = 0;
      while (timers.length && count++ < limit) {
        timers.sort((a, b) => a.time - b.time);
        const next = timers.shift();
        now = next.time;
        if (next.interval !== null) {
          timers.push({ ...next, time: now + next.interval });
        }
        next.cb(...next.args);
      }
    },

    // 恢复真实计时器
    restore() {
      Object.assign(globalThis, originals);
    },

    getNow: () => now,
  };
}
```

---

## 使用示例

```js
const clock = useFakeTimers();

let called = false;
setTimeout(() => { called = true; }, 1000);

console.log(called);       // false
clock.tick(500);
console.log(called);       // false — 只过了 500ms，未到期
clock.tick(500);
console.log(called);       // true  — 累计 1000ms，触发回调
console.log(Date.now());   // 1000  — 虚拟时钟同步

clock.restore(); // 恢复真实计时器
```

---

## 关键设计要点

| 要点 | 说明 |
|------|------|
| **虚拟时钟** | 维护 `now` 变量，`tick()` 推进而非真实等待 |
| **有序触发** | 按 `time` 排序，保证先到期的先执行 |
| **interval 重入队** | `setInterval` 回调执行后按 `interval` 重新计算下次触发时间 |
| **Date 同步** | `Date.now()` 返回虚拟时钟值，保持与 timer 一致 |
| **嵌套 timer** | 回调中注册的新 timer 自动进入队列，下轮循环可触发 |
| **防无限循环** | `runAll` 加上限（1000 次），防止 interval 无限触发 |

---

## 执行流程图

```
useFakeTimers()
  │
  ├─ 保存原始 API → originals
  ├─ 初始化 now=0, id=0, timers=[]
  └─ 替换 globalThis 上的 setTimeout/setInterval/clear*/Date

setTimeout(cb, 1000)
  └─ 入队 { id:1, cb, time:1000, interval:null }

tick(500)
  │ target = 500
  └─ 队列中最近 timer.time=1000 > 500 → 不触发，now=500

tick(500)
  │ target = 1000
  ├─ 队列中 timer.time=1000 ≤ 1000 → 出队执行
  │   ├─ now = 1000
  │   ├─ interval === null → 不重入队
  │   └─ cb()
  └─ 无更多 timer → now = 1000

restore()
  └─ 还原 globalThis 上的原始 API
```

---

## 进阶：生产级方案需额外处理

| 扩展点 | 说明 |
|--------|------|
| `requestAnimationFrame` / `cancelAnimationFrame` | 动画帧劫持，模拟 16.67ms 帧间隔 |
| `process.nextTick` / `queueMicrotask` | 微任务劫持，保证执行顺序正确 |
| `performance.now()` | 高精度时钟同步 |
| 最小堆替代数组排序 | 排序从 O(n log n) 优化到插入/弹出 O(log n) |
| Promise-based tick | `tick` 返回 Promise，支持 async 回调中的异步操作 |
| 嵌套深度限制 | 防止回调中递归注册 timer 导致栈溢出 |

---

## 面试回答要点

1. **原理一句话**：保存并替换全局 timer API，用虚拟时钟 + 有序队列模拟时间推进
2. **核心数据结构**：timer 队列（按触发时间排序）+ 虚拟时钟变量
3. **tick 的本质**：同步遍历队列，将 `now` 推进到目标时间，依次执行到期回调
4. **interval vs timeout**：interval 执行后重新入队，timeout 执行后丢弃
5. **Date 一致性**：`Date.now()` 必须与虚拟时钟同步，否则业务代码中的时间判断会不一致
6. **恢复机制**：`restore()` 还原所有被替换的 API，防止测试间污染
