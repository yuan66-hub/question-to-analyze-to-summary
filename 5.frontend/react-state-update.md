# React 状态更新后、渲染前获取最新数据

## 核心问题

`setState` 是异步批处理的，直接读取 state 拿到的仍是旧值：

```js
setCount(count + 1);
console.log(count); // 还是旧值！
```

---

## 方案一：用局部变量（最简单）

**计算新值 → 同时赋给变量和 setState**：

```js
const handleClick = () => {
  const newCount = count + 1;
  setCount(newCount);
  // 直接用 newCount，不依赖 state
  doSomething(newCount);
};
```

---

## 方案二：`useRef` 同步追踪最新值

```js
const countRef = useRef(count);

const setCountSync = (val) => {
  countRef.current = val;
  setCount(val);
};

// countRef.current 始终是最新值，渲染前也能读到
```

---

## 方案三：`flushSync`（强制同步更新，React 18+）

```js
import { flushSync } from 'react-dom';

flushSync(() => {
  setCount(count + 1);
});
// 这一行之后 DOM 已更新，state 已生效
console.log(countRef.current); // 结合 ref 读取
```

> 注意：`flushSync` 会强制触发同步渲染，影响性能，谨慎使用。

---

## 方案四：`useLayoutEffect`（渲染后、浏览器绘制前）

```js
useLayoutEffect(() => {
  // DOM 已更新，但用户还没看到画面
  // 可以在这里基于最新 state 做同步操作（如测量 DOM）
  console.log(count); // 是最新值
}, [count]);
```

适合需要读取 DOM 尺寸/位置等场景。

---

## 方案五：`useReducer`（复杂状态逻辑）

```js
function reducer(state, action) {
  const newState = { ...state, count: state.count + 1 };
  // reducer 内可以基于完整的新状态做派生计算
  return { ...newState, derived: computeDerived(newState) };
}
```

---

## 总结

| 场景 | 推荐方案 |
|------|---------|
| 需要新值做后续逻辑 | 局部变量 |
| 跨渲染同步读取 | `useRef` |
| 强制同步渲染（少用）| `flushSync` |
| 渲染后操作 DOM | `useLayoutEffect` |
| 复杂状态派生 | `useReducer` |

**最佳实践：优先用局部变量**，避免依赖 state 的异步特性。
