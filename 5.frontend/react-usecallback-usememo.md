# React useCallback 与 useMemo 深度指南

## 目录

1. [性能优化方式概览](#一性能优化方式概览)
2. [什么时候不该用](#二什么时候不该用)
3. [性能开销](#三性能开销)
4. [实际使用场景](#四实际使用场景)
5. [底层原理](#五底层原理)
6. [常见错误用法](#六常见错误用法)

---

## 一、性能优化方式概览

### 避免不必要的函数重建

**`useCallback`** — 缓存函数引用

```jsx
// 坏：每次渲染都创建新函数，导致子组件重渲染
const handleClick = () => doSomething(id);

// 好：函数引用稳定
const handleClick = useCallback(() => doSomething(id), [id]);
```

**`useMemo`** — 缓存计算结果

```jsx
// 坏：每次渲染重新计算
const filtered = items.filter(x => x.active);

// 好：仅在依赖变化时重新计算
const filtered = useMemo(() => items.filter(x => x.active), [items]);
```

### 避免不必要的组件重渲染

**`React.memo`** — 包裹纯展示组件

```jsx
const Child = React.memo(({ onClick }) => <button onClick={onClick}>Click</button>);
```

> `React.memo` + `useCallback` 配合使用才有意义，缺一不可。

### 函数式 setState — 保证回调稳定

```jsx
// 坏：依赖 count，useCallback 需要 count 作为依赖
const increment = useCallback(() => setCount(count + 1), [count]);

// 好：不依赖外部 count，useCallback 依赖为空
const increment = useCallback(() => setCount(c => c + 1), []);
```

### 用 Ref 处理高频更新的值

```jsx
// 好：用 ref 存储，不触发重渲染
const posRef = useRef({ x: 0, y: 0 });
const handleMouseMove = (e) => {
  posRef.current = { x: e.clientX, y: e.clientY };
};
```

### 避免在回调中订阅不必要的 State

```jsx
// 好：用 ref 存储最新值，回调无需依赖
const inputRef = useRef('');
const handleChange = (e) => { inputRef.current = e.target.value; };
const handleSubmit = useCallback(() => {
  api.post(inputRef.current);
}, []); // 稳定引用
```

### 非紧急更新用 `startTransition`

```jsx
const handleSearch = (e) => {
  setQuery(e.target.value);           // 紧急：输入框立即响应
  startTransition(() => {
    setList(heavyFilter(e.target.value)); // 非紧急：可被打断
  });
};
```

### 总结对照表

| 场景 | 方案 |
|------|------|
| 传给子组件的回调 | `useCallback` + `React.memo` |
| 昂贵计算结果 | `useMemo` |
| 高频更新不需渲染 | `useRef` |
| 回调内读取最新值 | `useRef` 存值（useLatest 模式） |
| 非紧急 UI 更新 | `startTransition` |
| setState 避免闭包陷阱 | 函数式 `setState(prev => ...)` |

---

## 二、什么时候不该用

### 最核心原则：它们本身有成本

每次渲染都会执行：
1. 调用 Hook 本身的开销
2. 比较依赖数组（每个元素 `Object.is` 比较）
3. 缓存存储开销

**缓存收益必须大于缓存成本，否则适得其反。**

### 不该用的场景

**1. 原始值或简单表达式**

```jsx
// 没意义：比较 + 缓存的开销 > 直接计算
const double = useMemo(() => count * 2, [count]);
const label = useMemo(() => `Hello ${name}`, [name]);

// 直接写
const double = count * 2;
const label = `Hello ${name}`;
```

**2. 子组件没有用 `React.memo` 包裹**

```jsx
// useCallback 完全无效：Child 没有 memo，父渲染就重渲染
const handleClick = useCallback(() => doSomething(), []);
return <Child onClick={handleClick} />; // Child 是普通函数组件
```

**3. 依赖项频繁变化**

```jsx
// 每次 items 变化都重新计算，和不写一样，还多了 diff 开销
const result = useMemo(() => items.map(transform), [items]);
// items 如果每次渲染都是新引用（比如来自 API），缓存永远失效
```

**4. 组件本身渲染很少**

```jsx
// 这个组件只在页面加载时渲染一次
function Header() {
  const style = useMemo(() => ({ color: 'red' }), []); // 没意义
  return <h1 style={style}>Title</h1>;
}
```

**5. 计算本身非常廉价**

```jsx
// 数组长度 < 100、简单对象构造、基础过滤 —— 都不值得 memo
const isValid = useMemo(() => email.includes('@'), [email]);

// 直接写
const isValid = email.includes('@');
```

**6. 作为 `useEffect` 的依赖来"稳定"引用**

```jsx
// 常见错误写法
const options = useMemo(() => ({ method: 'GET' }), []);
useEffect(() => {
  fetch(url, options);
}, [url, options]);

// 正确：直接把对象移进 effect 内部
useEffect(() => {
  fetch(url, { method: 'GET' });
}, [url]);
```

### 判断是否要用的流程

```
计算/函数是否昂贵？
├── 否 → 不用
└── 是 → 结果是否传给 React.memo 子组件，或是 useEffect 依赖？
         ├── 否 → 不用
         └── 是 → 依赖项是否变化不频繁？
                  ├── 否 → 不用（缓存总失效）
                  └── 是 → 用
```

> React 官方建议：用 `console.time` 测量，**超过 1ms** 才考虑优化。

---

## 三、性能开销

### 每次渲染的固定开销

| 操作 | 开销 |
|------|------|
| 读取 Fiber 上的 Hook 节点 | ~1ns |
| 遍历 deps 数组，执行 `Object.is` | ~1ns × deps 数量 |
| 读/写 memoizedState | ~1ns |

**deps 命中缓存时总开销：约 2–5ns**

### 实测数量级对比

```js
// 场景 A：直接计算
const double = count * 2;
// 耗时：~0.1ns

// 场景 B：useMemo 包裹（deps 命中）
const double = useMemo(() => count * 2, [count]);
// 耗时：~3–5ns（慢 30–50 倍）

// 场景 C：useMemo 包裹（deps 未命中）
// 耗时：~10–15ns（慢 100 倍）
```

### 与其他操作的开销对比

```
useMemo 本身开销：       ~5ns（命中）/ ~15ns（未命中）
一次 React reconcile：   ~50–500μs
一次 DOM 重排/重绘：     ~1–10ms
一次网络请求：           ~10–500ms
```

> useMemo 的开销在整个渲染链路中几乎可忽略，真正的瓶颈是子树重渲染、DOM 操作、数据请求。

### deps 的注意事项

```jsx
// deps 越多，比较开销越大
useMemo(() => compute(), [a, b, c, d, e]); // 每次比较 5 次

// 引用类型 deps，Object.is 永远 false，缓存永远失效！
useMemo(() => compute(), [{ id }]); // 每次都是新对象
```

---

## 四、实际使用场景

### `useCallback` 场景

**场景 1：传给 `React.memo` 子组件的回调**

```jsx
const TodoItem = React.memo(({ todo, onDelete }) => (
  <div>
    {todo.text}
    <button onClick={() => onDelete(todo.id)}>删除</button>
  </div>
));

function TodoList() {
  const [todos, setTodos] = useState([]);

  // filter 变化时，handleDelete 引用不变，TodoItem 不重渲染
  const handleDelete = useCallback((id) => {
    setTodos(prev => prev.filter(t => t.id !== id));
  }, []); // 函数式 setState，deps 为空

  return todos.map(todo => (
    <TodoItem key={todo.id} todo={todo} onDelete={handleDelete} />
  ));
}
```

**场景 2：作为 `useEffect` 的依赖**

```jsx
function useUserData(userId) {
  const [data, setData] = useState(null);

  // 没有 useCallback：fetchUser 每次渲染都是新函数 → useEffect 每次执行 → 无限请求
  const fetchUser = useCallback(async () => {
    const res = await api.get(`/users/${userId}`);
    setData(res.data);
  }, [userId]); // userId 变化才重新请求

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  return data;
}
```

**场景 3：自定义 Hook 对外暴露稳定函数**

```jsx
function useModal() {
  const [isOpen, setIsOpen] = useState(false);

  const open   = useCallback(() => setIsOpen(true), []);
  const close  = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen(p => !p), []);

  return { isOpen, open, close, toggle };
}
```

**场景 4：防抖 / 节流函数**

```jsx
function SearchBox() {
  const [query, setQuery] = useState('');

  // 没有 useCallback：每次渲染创建新的 debounce 实例，防抖计时器被重置，完全失效
  const debouncedSearch = useCallback(
    debounce((q) => api.search(q), 300),
    [] // 只创建一次
  );

  return (
    <input
      value={query}
      onChange={e => {
        setQuery(e.target.value);
        debouncedSearch(e.target.value);
      }}
    />
  );
}
```

### `useMemo` 场景

**场景 1：大列表过滤 / 排序**

```jsx
function ProductList({ products, keyword, sortBy }) {
  const processed = useMemo(() => {
    return products
      .filter(p => p.name.includes(keyword))
      .sort((a, b) => a[sortBy] - b[sortBy]);
  }, [products, keyword, sortBy]);

  return processed.map(p => <ProductCard key={p.id} product={p} />);
}
```

**场景 2：避免子组件因对象引用变化而重渲染**

```jsx
const Chart = React.memo(({ config }) => <canvas {...config} />);

function Dashboard({ theme, data }) {
  // 没有 useMemo：每次渲染 config 是新对象，React.memo 失效
  const config = useMemo(() => ({
    colors: theme.palette,
    datasets: data.map(transformForChart),
    animation: { duration: 300 },
  }), [theme, data]);

  return <Chart config={config} />;
}
```

**场景 3：Context value 防止全量重渲染**

```jsx
function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState('');

  // 没有 useMemo：每次父组件渲染，value 是新对象
  // → 所有 useContext(AuthContext) 的组件都重渲染
  const value = useMemo(() => ({
    user,
    token,
    login: (u, t) => { setUser(u); setToken(t); },
    logout: () => { setUser(null); setToken(''); },
  }), [user, token]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
```

**场景 4：复杂派生数据计算**

```jsx
function OrderSummary({ orders }) {
  const stats = useMemo(() => {
    let total = 0, count = 0, maxOrder = null;
    for (const order of orders) {
      total += order.amount;
      count++;
      if (!maxOrder || order.amount > maxOrder.amount) maxOrder = order;
    }
    return { total, count, average: total / count, maxOrder };
  }, [orders]);

  return (
    <div>
      <p>总金额：{stats.total}</p>
      <p>平均：{stats.average}</p>
      <p>最大单：{stats.maxOrder?.id}</p>
    </div>
  );
}
```

### 使用场景总结

```
useCallback 值得用：
  ✓ 传给 React.memo 子组件
  ✓ 作为 useEffect 依赖
  ✓ 自定义 Hook 对外暴露的函数
  ✓ 防抖/节流函数（必须用）

useMemo 值得用：
  ✓ 大数据量的 filter/sort/map（>1000 条或耗时 >1ms）
  ✓ 传给 React.memo 子组件的对象/数组 props
  ✓ Context value 对象
  ✓ 需要复用的派生数据（多处读取同一计算结果）
```

---

## 五、底层原理

### Hooks 存储结构

React 每个组件对应一个 **Fiber 节点**，Hooks 以**链表**形式挂在 `fiber.memoizedState` 上：

```
Fiber 节点
└── memoizedState
    ├── Hook1 (useState)    → { memoizedState: value, next → }
    ├── Hook2 (useMemo)     → { memoizedState: [result, deps], next → }
    └── Hook3 (useCallback) → { memoizedState: [fn, deps], next → }
```

### `useMemo` 源码核心

```ts
// 首次渲染（mount）
function mountMemo(factory, deps) {
  const hook = mountWorkInProgressHook();
  const value = factory();                 // 执行计算函数
  hook.memoizedState = [value, deps];      // 缓存 [结果, 依赖]
  return value;
}

// 后续渲染（update）
function updateMemo(factory, deps) {
  const hook = updateWorkInProgressHook();
  const [prevValue, prevDeps] = hook.memoizedState;

  if (areHookInputsEqual(deps, prevDeps)) {
    return prevValue; // deps 未变 → 直接返回缓存
  }

  const value = factory();               // deps 变了 → 重新计算
  hook.memoizedState = [value, deps];
  return value;
}

// 依赖比较：逐项 Object.is
function areHookInputsEqual(nextDeps, prevDeps) {
  for (let i = 0; i < nextDeps.length; i++) {
    if (!Object.is(nextDeps[i], prevDeps[i])) return false;
  }
  return true;
}
```

### `useCallback` 是 `useMemo` 的语法糖

```ts
// useCallback 源码本质
function useCallback(callback, deps) {
  return useMemo(() => callback, deps);
  //     ↑ factory 返回函数本身，而不是执行函数
}

// 两者等价：
useCallback(fn, deps) === useMemo(() => fn, deps)
```

| | `useMemo` | `useCallback` |
|---|---|---|
| 存储结构 | `[value, deps]` | `[fn, deps]` |
| factory | 执行并缓存**返回值** | 缓存**函数本身** |
| 本质关系 | 基础实现 | `useMemo(() => fn, deps)` 的语法糖 |

### 完整执行流程

```
组件渲染触发
     │
     ▼
React 遍历 Fiber 链表，找到对应 Hook 节点
     │
     ▼
读取 hook.memoizedState = [cachedValue, prevDeps]
     │
     ▼
遍历新 deps，逐个 Object.is(new, prev)
     │
   ┌─┴──────────────┐
全部相等           有不同
   │                 │
   ▼                 ▼
返回 cachedValue   执行 factory()
（跳过计算）       更新 memoizedState
                   返回新值
```

### 为什么引用类型 deps 总是失效

```js
// 每次渲染 options 都是新对象，Object.is 比较引用地址
Object.is({ page: 1 }, { page: 1 }); // false！

// 解决：传原始值作为 deps
useMemo(() => fetch({ page }), [page]); // page 是数字，比较值
```

---

## 六、常见错误用法

### 错误 1：deps 遗漏导致 Stale Closure（闭包陷阱）

```jsx
// 错误：deps 为空，handleLog 永远闭包了初始的 count = 0
const handleLog = useCallback(() => {
  console.log('当前 count:', count); // 永远打印 0
}, []); // ← 缺少 count
```

修复：

```jsx
// 方案 A：加入正确 deps
const handleLog = useCallback(() => {
  console.log('当前 count:', count);
}, [count]);

// 方案 B：用 ref 存最新值（函数引用更稳定）
const countRef = useRef(count);
useEffect(() => { countRef.current = count; }, [count]);

const handleLog = useCallback(() => {
  console.log('当前 count:', countRef.current);
}, []);
```

### 错误 2：deps 包含引用类型，缓存永远失效

```jsx
// 错误：config 是对象，每次父组件渲染都是新引用，memo 永远失效
const results = useMemo(() => heavySearch(config), [config]);

// 父组件每次渲染都创建新对象
return <SearchPanel config={{ page: 1, size: 20 }} />;
```

修复：

```jsx
// 传原始值
const results = useMemo(() => heavySearch({ page, size }), [page, size]);
```

### 错误 3：子组件没有 `React.memo`，`useCallback` 完全无效

```jsx
// Child 是普通组件 → 父渲染必然触发 Child 重渲染 → useCallback 无意义
function Child({ onClick }) { ... }

function Parent() {
  const handleClick = useCallback(() => doSomething(), []);
  return <Child onClick={handleClick} />; // Child 仍然每次重渲染
}
```

修复：

```jsx
const Child = React.memo(({ onClick }) => { ... });
```

### 错误 4：在 `useMemo` 内部产生副作用

```jsx
// 错误：StrictMode 下 React 会执行两次，副作用执行两次
const data = useMemo(() => {
  fetch('/api/data').then(setResult); // 副作用！
  document.title = 'Loading';         // DOM 操作！
  return processData(raw);
}, [raw]);
```

修复：

```jsx
// 副作用放 useEffect，useMemo 只做纯计算
useEffect(() => {
  fetch('/api/data').then(setResult);
}, [raw]);

const data = useMemo(() => processData(raw), [raw]);
```

### 错误 5：形成 memo 链

```jsx
// 错误：难以追踪，收益递减
const step1 = useMemo(() => transform(raw), [raw]);
const step2 = useMemo(() => filter(step1), [step1]);
const step3 = useMemo(() => sort(step2), [step2]);
```

修复：

```jsx
// 合并为一个 useMemo
const result = useMemo(() => {
  return paginate(sort(filter(transform(raw))));
}, [raw]);
```

### 错误 6：用 `useMemo` 稳定 `useEffect` 依赖

```jsx
// 错误：多此一举
const options = useMemo(() => ({ method: 'POST' }), []);
useEffect(() => { fetch(url, options); }, [url, options]);

// 正确：直接移进 effect
useEffect(() => { fetch(url, { method: 'POST' }); }, [url]);
```

### 错误 7：deps 写 `[]` 但实际依赖了 props/state

```jsx
// 错误：提交时永远是初始的 formData {}
const handleSave = useCallback(() => {
  onSave(formData); // formData 永远是初始值
}, []); // ← 缺少 formData 和 onSave
```

修复：

```jsx
// 方案 A：正确写 deps
const handleSave = useCallback(() => {
  onSave(formData);
}, [formData, onSave]);

// 方案 B：用 ref 获取最新值
const formDataRef = useRef(formData);
useEffect(() => { formDataRef.current = formData; }, [formData]);

const handleSave = useCallback(() => {
  onSave(formDataRef.current);
}, [onSave]);
```

### 错误总览

| 错误 | 后果 | 修复方向 |
|------|------|----------|
| deps 遗漏 | Stale closure，读到旧值 | 补全 deps 或用 ref |
| deps 含引用类型 | 缓存永远失效 | 改用原始值 |
| 子组件无 `React.memo` | `useCallback` 无效 | 加 `React.memo` |
| `useMemo` 里写副作用 | 副作用执行时机不可控 | 移到 `useEffect` |
| memo 链过深 | 难维护，收益递减 | 合并为单个 `useMemo` |
| deps 写 `[]` 但有隐式依赖 | 取到初始值 | 补全 deps 或用 ref |
| 内部调用函数未稳定 | 缓存仍然失效 | 将纯函数提到组件外 |
