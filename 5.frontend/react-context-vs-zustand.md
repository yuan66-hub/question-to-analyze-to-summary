# React Context vs Zustand 深度对比

## 1. 核心区别

| 特性 | React Context | Zustand |
|------|--------------|---------|
| **用途** | 跨组件树传递数据，避免 props drilling | 轻量级状态管理库 |
| **API** | `createContext()` + `useContext()` | `create((set) => ({ ... }))` |
| **更新机制** | Provider value 变化时，所有消费该 Context 的组件都会重渲染 | 基于 subscription（发布订阅），只有订阅了特定 state 的组件才会更新 |
| **性能** | 容易产生不必要的重渲染，需配合 `memo`、`useMemo` 优化 | 细粒度更新，默认不会导致无关组件重渲染 |
| **状态管理** | 本身不是状态管理库，只是依赖注入机制 | 原生支持状态管理，支持 middleware、持久化等 |
| **样板代码** | 较多：createContext → Provider → useContext | 极少，API 简洁 |
| **Provider 依赖** | 需要嵌套 Provider | 不需要，store 是独立的 |

### 核心区别图示

```
React Context:  Provider value 变化 → 所有消费的组件重渲染（粗粒度）
Zustand:        store 变化 → 只更新实际使用该 slice 的组件（细粒度）
```

### 何时选谁

- **React Context**：低频更新、简单的跨层级数据传递（如主题、locale、用户信息）
- **Zustand**：高频更新、需要多个独立状态 slice、追求性能的复杂应用

---

## 2. 让 React Context 接近 Zustand 的效果

核心原则：**按状态维度拆分 Context，避免一个大 Context 包含所有状态**

### 问题示例

```jsx
// ❌ 一个大 Context，问题：任何状态变化都导致所有消费者重渲染
const AppContext = createContext({
  user, setUser,
  theme, setTheme,
  notifications, setNotifications,
});
```

### 方案一：拆分多个独立 Context

```jsx
// ✅ 每个状态独立的 Context，变化时只影响订阅者
const UserContext = createContext();
const ThemeContext = createContext();
const NotificationContext = createContext();
```

使用时按需引入，不会相互影响。

### 方案二：使用 useContextSelector

利用 `use-context-selector` 库实现"只订阅需要的部分"：

```jsx
import { createContext, useContextSelector } from 'use-context-selector';

const AppContext = createContext({ user: null, theme: 'dark' });

// 只订阅 user，不受 theme 变化影响
const UserDisplay = () => {
  const user = useContextSelector(AppContext, (state) => state.user);
  return <div>{user.name}</div>;
};
```

### 方案三：使用 useRef 缓存 + memo

```jsx
const ThemeContext = createContext();

const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState('dark');

  // 使用 useMemo 确保 value 稳定
  const value = useMemo(() => ({ theme, setTheme }), [theme]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};

// 消费组件用 memo 包裹
const ThemeToggle = memo(() => {
  const { theme, setTheme } = useContext(ThemeContext);
  return <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>Toggle</button>;
});
```

### 关键技巧总结

| 技巧 | 效果 |
|------|------|
| **拆分 Context** | 每个 Context 独立，变化范围最小化 |
| **useMemo 缓存 value** | 避免 Provider value 引用变化导致的不必要重渲染 |
| **memo 包裹消费组件** | 防止父组件重渲染时子组件被迫重渲染 |
| **useContextSelector** | 真正做到只订阅需要的 state slice |
| **Context 放在叶节点** | 让 Provider 尽量靠近消费者，减少影响范围 |

---

## 3. useContextSelector 深入解析

### 它解决什么问题

React Context 的根本问题：**Provider value 变化时，所有 useContext 的组件全部重渲染，即使它们只用了一小部分状态**。

`useContextSelector` 的核心能力：**让组件只订阅它需要的那个字段，其他字段变化不会触发更新**。

### 内部实现思路

```jsx
// useContextSelector 伪代码实现
function useContextSelector(context, selector) {
  const ctx = useContext(context);

  // 1. 用 selector 提取需要的 slice
  const selected = selector(ctx);

  // 2. 用 ref 记录上次的 selected 值
  const prevSelectedRef = useRef(selected);

  // 3. 用 useReducer 强制更新（只有真正变化时才触发）
  const [, forceUpdate] = useReducer(x => x + 1);

  // 4. 浅比较判断是否真的变化了
  if (!shallowEqual(prevSelectedRef.current, selected)) {
    prevSelectedRef.current = selected;
    forceUpdate(); // 触发更新
  }

  return selected;
}
```

关键点：**不是状态变化就更新，而是通过比较确定"我关心的值真的变了"才更新**。

### 主流实现库

| 库 | 特点 |
|---|------|
| **use-context-selector** | 最流行，React 官方推荐的 Context 优化方案 |
| **@preprandio/use-context-selector** | 早期实现，已停止维护 |
| **zustand/context** | Zustand 提供的 Context 桥接方案 |

### use-context-selector 完整示例

#### 1. 安装

```bash
npm install use-context-selector
```

#### 2. 创建 Store（传统 React Context 方式）

```jsx
import { createContext } from 'react';
import { useContextSelector } from 'use-context-selector';

// 创建一个普通的 Context（不是 zustand store）
const CounterContext = createContext(null);

// Provider 组件
const CounterProvider = ({ children }) => {
  const [count, setCount] = useState(0);
  const [theme, setTheme] = useState('dark');

  const value = { count, setCount, theme, setTheme };

  return (
    <CounterContext.Provider value={value}>
      {children}
    </CounterContext.Provider>
  );
};
```

#### 3. 组件中使用

```jsx
// 只订阅 count，不受 theme 变化影响
const CounterDisplay = () => {
  const count = useContextSelector(
    CounterContext,
    (ctx) => ctx.count  // 只取 count
  );

  console.log('CounterDisplay rendered'); // count 变化时才打印
  return <div>Count: {count}</div>;
};

// 只订阅 theme，不受 count 变化影响
const ThemeDisplay = () => {
  const theme = useContextSelector(
    CounterContext,
    (ctx) => ctx.theme  // 只取 theme
  );

  console.log('ThemeDisplay rendered'); // theme 变化时才打印
  return <div>Theme: {theme}</div>;
};
```

#### 4. 验证效果

```jsx
const App = () => {
  return (
    <CounterProvider>
      <button onClick={() => setCount(c => c + 1)}>Increment</button>
      <button onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>Toggle Theme</button>

      <CounterDisplay />  {/* 只在 count 变化时重渲染 */}
      <ThemeDisplay />   {/* 只在 theme 变化时重渲染 */}
    </CounterProvider>
  );
};
```

点击 `Increment` → 只有 `CounterDisplay` 重渲染，`ThemeDisplay` 不重渲染

点击 `Toggle Theme` → 只有 `ThemeDisplay` 重渲染，`CounterDisplay` 不重渲染

### useContextSelector vs Zustand 对比

| 特性 | use-context-selector | Zustand |
|------|----------------------|---------|
| **状态来源** | 普通 React Context | 独立的 Store |
| **使用方式** | 需要改用 `useContextSelector` | `useStore(selector)` |
| **学习成本** | 较低（概念一致） | 需学习新 API |
| **middleware** | 不支持 | 支持（持久化、日志等） |
| **DevTools** | 无 | 有（Zustand DevTools） |
| **生产验证** | 较少 | 大量生产使用案例 |

---

## 4. Zustand 原理详解

### 核心设计思想

Zustand = **Flux 思想 + 订阅发布模式 + 最小化重渲染**

```
传统 React:  state → UI（单向数据流）
Zustand:     store → subscription → UI（发布订阅模式）
```

### 核心原理图

```
┌─────────────────────────────────────────────────────────┐
│                        Store                            │
│  ┌─────────────────────────────────────────────────┐   │
│  │  state: { count: 0, theme: 'dark' }             │   │
│  │  setState: (partial) => state = { ...state, ...partial } │
│  │  subscribers: Set<listener>                     │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
              │                           ▲
              │ update                     │ subscribe
              ▼                           │
┌─────────────────────┐    ┌────────────────────────────┐
│    setCount(1)      │    │  useStore(state => state.x) │
│         │           │    │           │                │
│    store.setState() │    │     selector(state)        │
│         │           │    │           │                │
│  subscribers.forEach│    │   prevSlice !== currSlice? │
│       (listener)    │    │           │                │
└─────────────────────┘    │     forceUpdate()         │
                           └────────────────────────────┘
```

### 源码核心实现

#### 1. createStore（最简实现）

```jsx
// 极简版 Zustand 原理
function createStore(initializer) {
  let state;                           // 状态存储
  const subscribers = new Set();       // 订阅者集合

  const setState = (partial) => {
    const nextState = typeof partial === 'function'
      ? partial(state)
      : partial;
    state = { ...state, ...nextState }; // 合并状态
    subscribers.forEach(listener => listener(state)); // 通知所有订阅者
  };

  const getState = () => state;

  const subscribe = (listener) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener); // 返回取消订阅函数
  };

  state = initializer(setState, getState, { setState, getState, subscribe });

  return { getState, setState, subscribe };
}
```

#### 2. useStore（Hook 实现）

```jsx
function useStore(selector) {
  const store = useContext(Context); // 从 Context 获取 store 引用

  const [slice, setSlice] = useState(() => selector(store.getState()));
  const sliceRef = useRef(slice);

  useEffect(() => {
    const callback = (state) => {
      const nextSlice = selector(state);
      // 关键：只有 slice 真的变了才触发更新
      if (!shallowEqual(sliceRef.current, nextSlice)) {
        sliceRef.current = nextSlice;
        setSlice(nextSlice);
      }
    };

    const unsubscribe = store.subscribe(callback);
    return unsubscribe;
  }, [store]);

  return slice;
}
```

### 关键机制解析

#### 机制一：单一数据源 + 发布订阅

```jsx
const useStore = create((set, get) => ({
  count: 0,
  increment: () => set(state => ({ count: state.count + 1 })),
  decrement: () => set(state => ({ count: state.count - 1 })),
}));

// 内部只有一个 store 实例，所有组件共享
// 状态变化时，发布给所有订阅者
```

#### 机制二：Selector 细粒度订阅

```jsx
const ComponentA = () => {
  // 只订阅 count，theme 变化不会触发更新
  const count = useStore(state => state.count);
};

const ComponentB = () => {
  // 只订阅 theme，count 变化不会触发更新
  const theme = useStore(state => state.theme);
};
```

**Selector 比较逻辑**（源码简化）：

```jsx
const subscribe = (listener) => {
  let currentSlice = selector(getState()); // 初始值

  subscribers.add((state) => {
    const nextSlice = selector(state);
    if (!shallowEqual(currentSlice, nextSlice)) {
      const prevSlice = currentSlice;
      currentSlice = nextSlice;
      listener(prevSlice, nextSlice); // 真正变化时才通知
    }
  });
};
```

#### 机制三：Shallow Equal 比较

```jsx
// 默认比较器：浅比较
function shallowEqual(objA, objB) {
  if (Object.is(objA, objB)) return true;

  if (typeof objA !== 'object' || A === null ||
      typeof objB !== 'object' || B === null) return false;

  const keysA = Object.keys(A);
  const keysB = Object.keys(B);

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.is(A[key], B[key])) return false;
  }

  return true;
}
```

### 完整数据流

```
┌──────────────────────────────────────────────────────────────┐
│                          App                                 │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                    createStore()                       │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │  state = { count: 0 }                            │  │  │
│  │  │  setState = (partial) => {                       │  │  │
│  │  │    state = merge(state, partial)                 │  │  │
│  │  │    subscribers.forEach(listener => listener())  │  │  │
│  │  │  }                                               │  │  │
│  │  │  subscribers = Set()                             │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                 │
│         ┌──────────────────┼──────────────────┐             │
│         ▼                  ▼                  ▼             │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐        │
│  │ useStore(s=> │   │ useStore(s=> │   │ useStore(s=> │        │
│  │   s.count)  │   │   s.count)  │   │   s.count)  │        │
│  │             │   │             │   │             │        │
│  │ sliceRef    │   │ sliceRef    │   │ sliceRef    │        │
│  │ prev=0 cur=0│   │ prev=0 cur=0│   │ prev=0 cur=0│        │
│  └─────────────┘   └─────────────┘   └─────────────┘        │
│         │                  │                  │             │
│         └──────────────────┼──────────────────┘             │
│                            │                                 │
│                     subscribers.add()                        │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼ setCount(1) called
              ┌───────────────────────────────────┐
              │   store.setState({ count: 1 })   │
              │             │                    │
              │    state = { count: 1 }          │
              │             │                    │
              │   subscribers.forEach(listener)  │
              │             │                    │
              │   每个 listener 执行 selector    │
              │   比较 prevSlice vs currSlice    │
              │   只有变化了才 forceUpdate()     │
              └───────────────────────────────────┘
```

### Middleware 机制

Zustand 通过中间件模式扩展功能：

```jsx
// persist middleware 示例
const useStore = create(
  persist(
    (set, get) => ({
      count: 0,
      increment: () => set(state => ({ count: state.count + 1 })),
    }),
    { name: 'storage' } // 配置项
  )
);

// middleware 签名
const persist = (createStore, options) => (set, get, api) => {
  const originalSet = set;
  const originalGet = get;

  // 劫持 set 和 get，注入额外逻辑
  set = (partial) => {
    // 持久化到 localStorage
    const result = originalSet(partial);
    saveToStorage(options.name, result);
    return result;
  };

  return createStore(set, (() => loadFromStorage(options.name))(), api);
};
```

### 总结：Zustand 的三大支柱

1. **单一 Store** - 集中管理状态，避免 Provider nesting hell
2. **Selector 订阅** - 组件只订阅需要的 slice，最小化重渲染
3. **Shallow Equal** - 精细比较，确保"真正变化"才更新 UI
