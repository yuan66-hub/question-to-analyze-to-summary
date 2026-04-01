# React 核心原理

> 涵盖 Hooks 原理、Fiber 架构、Scheduler 调度、性能优化、状态管理、Diff 算法、并发特性

---

## 目录

1. [Hooks 原理](#一hooks-原理)
2. [性能优化](#二性能优化)
3. [Fiber 双缓存机制](#三fiber-双缓存机制)
4. [Scheduler 优先级调度](#四scheduler-优先级调度)
5. [状态管理](#五状态管理)
6. [React 18 并发特性](#六react-18-并发特性)
7. [Commit 三阶段](#七commit-三阶段)
8. [Reconciler Diff 算法](#八reconciler-diff-算法)
9. [手写实现](#九手写实现)

---

## 一、Hooks 原理

### 1. Hook 为什么不能在条件/循环中调用？

React 在 Fiber 节点上用**单向链表**存储所有 Hook 的状态，每次渲染按调用顺序依次读取链表节点。

```js
// Fiber 节点上的结构（简化）
fiber.memoizedState = {
  memoizedState: 0,        // useState 的值
  next: {
    memoizedState: false,  // 第二个 useState 的值
    next: {
      memoizedState: null, // useEffect 的 effect
      next: null
    }
  }
}
```

```js
// ❌ 错误：条件中使用 Hook
function Comp() {
  if (condition) {
    const [a, setA] = useState(0) // 链表位置 1
  }
  const [b, setB] = useState('')  // condition=false 时变成位置 1 → 状态错乱
}

// ✅ 正确：Hook 始终在顶层
function Comp() {
  const [a, setA] = useState(0)   // 始终是位置 1
  const [b, setB] = useState('')  // 始终是位置 2
  if (!condition) return null     // 条件逻辑放内部
}
```

> mount 阶段调用 `mountState`，update 阶段调用 `updateState`，分别操作 `workInProgressHook` 指针遍历链表。

---

### 2. useState 批量更新（Batching）

```js
// React 17：只在合成事件中批处理
setTimeout(() => {
  setA(1)  // 触发一次渲染
  setB(2)  // 再触发一次渲染（共 2 次）
})

// React 18：自动批处理（Automatic Batching）
setTimeout(() => {
  setA(1)
  setB(2)  // 只触发一次渲染 ✅
})

// 退出批处理
import { flushSync } from 'react-dom'
flushSync(() => setA(1)) // 立即渲染
flushSync(() => setB(2)) // 再次立即渲染
```

---

### 3. useEffect vs useLayoutEffect

```
React render → commit DOM → useLayoutEffect（同步，阻塞绘制）
                          ↓
                      浏览器绘制（Paint）
                          ↓
                       useEffect（异步）
```

| | `useEffect` | `useLayoutEffect` |
|--|--|--|
| 执行时机 | 绘制**后**异步执行 | DOM 更新后、绘制**前**同步执行 |
| 会阻塞绘制 | 否 | 是 |
| 适用场景 | 数据请求、订阅 | 读取/修改 DOM 尺寸、避免闪烁 |
| SSR | 可用（有 warning） | 不可用 |

```js
// 经典场景：useLayoutEffect 避免闪烁
function Tooltip() {
  const [pos, setPos] = useState({ top: 0 })
  const ref = useRef()

  useLayoutEffect(() => {
    // 在绘制前同步计算位置，避免位置跳动
    const rect = ref.current.getBoundingClientRect()
    setPos({ top: rect.bottom })
  }, [])

  return <div ref={ref} style={pos}>tooltip</div>
}
```

---

### 4. useCallback / useMemo 依赖陷阱

**错误一：遗漏依赖（闭包陷阱）**
```js
const [count, setCount] = useState(0)

// ❌ count 变化后 fn 不更新，始终打印旧值
const fn = useCallback(() => {
  console.log(count)
}, []) // 缺少 count

// ✅ 方案一：加入依赖
const fn = useCallback(() => {
  console.log(count)
}, [count])

// ✅ 方案二：useRef 存最新值（不触发重渲染）
const countRef = useRef(count)
useEffect(() => { countRef.current = count }, [count])
const fn = useCallback(() => {
  console.log(countRef.current) // 始终最新
}, [])
```

**错误二：对象依赖引用每次变化**
```js
// ❌ options 每次渲染是新对象，useCallback 无效
const options = { method: 'GET' }
const fetchData = useCallback(() => doFetch(options), [options])

// ✅ 用 useMemo 稳定对象引用
const options = useMemo(() => ({ method: 'GET' }), [])
```

**何时真正需要 useMemo/useCallback？**
```
需要：
  ✅ 计算开销大（> 1ms）的纯计算
  ✅ 作为其他 Hook 的依赖项
  ✅ 传给已 memo 化子组件的引用类型

不需要：
  ❌ 简单计算（filter 少量数组等）
  ❌ 没有下游依赖的普通变量
```

---

### 5. 自定义 Hook

**useRequest**
```js
function useRequest(fetcher, deps = []) {
  const [state, setState] = useState({
    data: null, loading: false, error: null,
  })

  useEffect(() => {
    let cancelled = false
    setState(s => ({ ...s, loading: true }))

    fetcher()
      .then(data => {
        if (!cancelled) setState({ data, loading: false, error: null })
      })
      .catch(error => {
        if (!cancelled) setState({ data: null, loading: false, error })
      })

    return () => { cancelled = true } // 防止竞态条件
  }, deps)

  return state
}
```

**useDebounce**
```js
function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debounced
}
```

**useFetch（带取消功能）**
```js
function useFetch(url) {
  const [state, setState] = useState({
    data: null, loading: false, error: null,
  })
  const abortRef = useRef(null)

  const fetchData = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const res = await fetch(url, { signal: abortRef.current.signal })
      const data = await res.json()
      setState({ data, loading: false, error: null })
    } catch (err) {
      if (err.name === 'AbortError') return
      setState({ data: null, loading: false, error: err })
    }
  }, [url])

  useEffect(() => {
    fetchData()
    return () => abortRef.current?.abort()
  }, [fetchData])

  return { ...state, refetch: fetchData }
}
```

---

## 二、性能优化

### 1. React.memo + 三件套

```js
const Child = React.memo(({ onClick, data }) => {
  return <div onClick={onClick}>{data.name}</div>
})

function Parent() {
  const [count, setCount] = useState(0)

  const handleClick = useCallback(() => {
    console.log('clicked')
  }, [])

  const data = useMemo(() => ({ name: 'Alice' }), [])

  return (
    <>
      <button onClick={() => setCount(c => c + 1)}>{count}</button>
      <Child onClick={handleClick} data={data} /> {/* 不会重渲染 */}
    </>
  )
}
```

**React.memo 自定义比较**
```js
const Child = React.memo(
  ({ list }) => <List data={list} />,
  (prev, next) => prev.list.length === next.list.length // true = 跳过渲染
)
```

**React.memo 失效场景**：
1. 每次传入新对象/数组/函数
2. Context 变化（memo 跳不过订阅触发的重渲染）
3. 子组件内部有 useState/useReducer（自身状态变化不受 memo 影响）

---

### 2. 虚拟列表

核心原理：只渲染可视区域的 DOM 节点。

```js
import { useVirtual } from '@tanstack/react-virtual'

function VirtualList({ items }) {
  const parentRef = useRef()
  const rowVirtualizer = useVirtual({
    size: items.length,
    parentRef,
    estimateSize: useCallback(() => 50, []),
  })

  return (
    <div ref={parentRef} style={{ height: '400px', overflow: 'auto' }}>
      <div style={{ height: rowVirtualizer.totalSize }}>
        {rowVirtualizer.virtualItems.map(row => (
          <div
            key={row.index}
            style={{
              position: 'absolute',
              top: 0,
              transform: `translateY(${row.start}px)`,
              height: `${row.size}px`,
            }}
          >
            {items[row.index]}
          </div>
        ))}
      </div>
    </div>
  )
}
```

**不定高处理**：
1. 预估高度（estimateSize）先占位
2. 渲染后用 ResizeObserver 测量真实高度，更新位置映射表
3. 维护累计高度数组，用二分查找定位 startIndex

---

### 3. Code Splitting

```js
// 路由级别拆分
const Page = React.lazy(() => import('./pages/Page'))

function App() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route path="/page" element={<Page />} />
      </Routes>
    </Suspense>
  )
}

// 组件级别：弹窗、重型编辑器
const RichEditor = React.lazy(() => import('./RichEditor'))
function Form() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>打开编辑器</button>
      {open && (
        <Suspense fallback={<Spin />}>
          <RichEditor />
        </Suspense>
      )}
    </>
  )
}
```

---

### 4. startTransition / useDeferredValue（React 18）

```
用户输入 → 高优先级更新（输入框响应，不可中断）
         → 低优先级更新（搜索结果渲染，可被打断）
```

```js
// startTransition：标记非紧急更新（控制触发方）
function SearchPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])

  function handleChange(e) {
    setQuery(e.target.value)                       // 紧急：立即响应

    startTransition(() => {
      setResults(search(e.target.value))           // 非紧急：可被打断
    })
  }
  return <input onChange={handleChange} value={query} />
}

// useDeferredValue：延迟派生值（控制消费方）
function SearchResults({ query }) {
  const deferredQuery = useDeferredValue(query)
  const results = useMemo(() => heavySearch(deferredQuery), [deferredQuery])

  return (
    <div style={{ opacity: query !== deferredQuery ? 0.5 : 1 }}>
      {results.map(r => <Item key={r.id} data={r} />)}
    </div>
  )
}
```

| | `startTransition` | `useDeferredValue` |
|--|--|--|
| 控制位置 | 状态更新的**触发方** | 状态的**消费方** |
| 适用 | 自己掌控 setState | 接收外部 props/state |

**startTransition 和防抖的本质区别**：
- 防抖：延迟执行，有人为 delay 延迟感
- startTransition：立即计算但可被打断，输入框始终实时响应，无人为延迟

---

### 5. 渲染优化分层策略

```
第一层：避免不必要的重渲染
  → React.memo / useCallback / useMemo 稳定引用

第二层：减少单次渲染耗时
  → 虚拟列表（长列表）
  → useDeferredValue（降级渲染）

第三层：减少 JS 执行量
  → Code Splitting / 懒加载

第四层：架构层面
  → 状态下放（靠近使用处）
  → Context 细粒度拆分
  → Zustand selector 精确订阅
```

---

## 三、Fiber 双缓存机制

### 核心概念

React 同时维护两棵 Fiber 树：
- **current 树**：对应当前屏幕显示的内容
- **workInProgress 树**：在内存中构建的新树
- 两者通过 `alternate` 字段互相引用

### 完整渲染流程

```
触发更新
    ↓
【Render 阶段】（可中断，在内存中）
    ├── beginWork：自顶向下 diff，构建 workInProgress Fiber 树
    └── completeWork：自底向上收集副作用
    ↓
【Commit 阶段】（不可中断，同步执行）
    ├── Before Mutation：getSnapshotBeforeUpdate，调度 useEffect
    ├── Mutation：操作真实 DOM（插入/更新/删除）
    └── Layout：执行 useLayoutEffect，current 指针切换
    ↓
浏览器绘制
    ↓
异步执行 useEffect
```

### Fiber 节点关键字段

```js
function FiberNode(tag, pendingProps, key) {
  // 树结构（链表）
  this.return = null          // 父节点
  this.child = null           // 第一个子节点
  this.sibling = null         // 右边兄弟节点

  // 双缓存核心
  this.alternate = null       // 指向另一棵树的对应节点

  // 动态工作单元
  this.memoizedState = null   // 当前 state（Hooks 链表头）
  this.flags = NoFlags        // 副作用标记：Placement | Update | Deletion

  // 调度优先级
  this.lanes = NoLanes
}
```

### bailout 优化

```js
// props/context/lanes 均未变化时，直接复用整棵子树（O(1)）
if (
  oldProps === newProps &&       // props 引用相等
  !hasContextChanged() &&        // context 未变
  !includesSomeLane(renderLanes, workInProgress.lanes)
) {
  return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes)
}
// 这是 React.memo / PureComponent 有效的底层原因
```

### flags 副作用标记

```js
export const Placement  = 0b000010  // 插入
export const Update     = 0b000100  // 更新
export const Deletion   = 0b001000  // 删除
export const Passive    = 0b001000000000  // useEffect

// 用位运算操作
fiber.flags |= Placement   // 添加
fiber.flags & Placement    // 检查
fiber.flags &= ~Placement  // 清除
```

> React 18 用 `subtreeFlags` 替代 `effectList`，commit 阶段可快速跳过无副作用子树。

---

## 四、Scheduler 优先级调度

### 两层调度系统

```
Lane 模型（React 层）
  描述"这次更新有多紧急"
  SyncLane / InputContinuousLane / DefaultLane / TransitionLane
       ↓ 转换
Scheduler（独立 npm 包）
  描述"任务在浏览器中如何调度"
  ImmediatePriority / UserBlockingPriority / NormalPriority / ...
```

### Lane 模型

```js
// 优先级从高到低
export const SyncLane            = 0b00000000000000000000000000000010  // 点击等离散事件
export const InputContinuousLane = 0b00000000000000000000000000001000  // 拖拽/滚动
export const DefaultLane         = 0b00000000000000000000000000100000  // 普通 setState
export const TransitionLane1     = 0b00000000000000000000001000000000  // startTransition
export const OffscreenLane       = 0b10000000000000000000000000000000  // 离屏渲染

// 位运算高效操作
const renderLanes = SyncLane | DefaultLane         // 合并
includesSomeLane(set, subset) = (set & subset) !== 0  // 检查
getHighestPriorityLane(lanes) = lanes & -lanes        // 取最高优先级（最低有效位）
```

**事件类型对应 Lane**

| 事件类型 | Lane | Scheduler 优先级 |
|---------|------|----------------|
| click / keydown | SyncLane | Immediate（-1ms） |
| drag / scroll | InputContinuousLane | UserBlocking（250ms） |
| 普通 setState | DefaultLane | Normal（5000ms） |
| startTransition | TransitionLane | Normal（5000ms） |
| 离屏渲染 | OffscreenLane | Idle（永不过期） |

---

### Scheduler 时间切片（MessageChannel）

```js
// 为什么选 MessageChannel 而非 setTimeout？
// setTimeout 最小 4ms 延迟，MessageChannel 无强制延迟

const channel = new MessageChannel()
channel.port1.onmessage = performWorkUntilDeadline

function performWorkUntilDeadline() {
  const deadline = getCurrentTime() + 5  // 5ms 时间片

  const hasMoreWork = scheduledHostCallback(true, currentTime)

  if (hasMoreWork) {
    port.postMessage(null)  // 下一帧继续
  }
}

// 判断是否让出主线程
function shouldYieldToHost() {
  const timeElapsed = getCurrentTime() - startTime
  if (timeElapsed < 5) return false        // 5ms 内不让出
  if (navigator.scheduling?.isInputPending()) return true  // 有用户输入立即让出
  return timeElapsed >= 300               // 超 300ms 无条件让出
}
```

**时间片为什么是 5ms？** 16ms 是一帧总时间，浏览器还需要样式计算、布局、绘制（约 6~8ms），React 留 5ms 给自己，剩余时间给浏览器保证 60fps。

### 饥饿问题（Starvation）

低优先级任务不断被打断 → 过期时间到达后强制同步执行：

```js
while (currentTask !== null) {
  if (
    currentTask.expirationTime > currentTime &&
    (!hasTimeRemaining || shouldYieldToHost())
  ) {
    break  // 普通情况：让出主线程
  }
  // 过期的任务（expirationTime <= currentTime）
  // 即使 shouldYieldToHost()=true 也不让出，强制执行 ✅
  callback(didTimeout)
}
```

---

## 五、状态管理

### Context 性能问题与解决

```js
// ❌ 问题：一个 Context 包多个值，任意一个变化都触发所有消费者
const AppContext = createContext()

// ✅ 解决一：拆分 Context
const UserContext = createContext()
const ThemeContext = createContext()

// ✅ 解决二：useMemo 稳定 value
function Provider({ children }) {
  const [user, setUser] = useState(null)
  const value = useMemo(() => ({ user, setUser }), [user])
  return <UserContext.Provider value={value}>{children}</UserContext.Provider>
}

// ✅ 解决三：换用 Zustand（天然 selector 订阅）
```

### Zustand vs Redux

```js
// Redux：样板代码多
const slice = createSlice({
  name: 'counter',
  initialState: { value: 0 },
  reducers: { increment: state => { state.value++ } }
})

// Zustand：极简
const useStore = create((set) => ({
  count: 0,
  increment: () => set(state => ({ count: state.count + 1 })),
}))

// 只订阅 count，其他字段变化不触发重渲染
const count = useStore(state => state.count)
```

---

## 六、React 18 并发特性

### useTransition + Suspense 数据获取

```js
import { useState, useTransition, Suspense } from 'react'

function ContentSearch() {
  const [category, setCategory] = useState('all')
  const [isPending, startTransition] = useTransition()

  function handleSelect(newCategory) {
    startTransition(() => {
      setCategory(newCategory)    // 非紧急：允许被用户输入打断
    })
  }

  return (
    <>
      <CategoryPicker onSelect={handleSelect} />
      <div style={{ opacity: isPending ? 0.6 : 1, transition: 'opacity 0.2s' }}>
        <Suspense fallback={<ContentSkeleton />}>
          <ContentList category={category} />
        </Suspense>
      </div>
    </>
  )
}
```

### Suspense 数据获取（use + Promise）

```js
// 缓存层：防止每次渲染重复创建 Promise
function createResource(promise) {
  let status = 'pending'
  let result
  const suspender = promise.then(
    data => { status = 'success'; result = data },
    err  => { status = 'error';   result = err  }
  )
  return {
    read() {
      if (status === 'pending') throw suspender   // Suspense 捕获
      if (status === 'error')   throw result       // ErrorBoundary 捕获
      return result
    }
  }
}

// 组件直接同步读取，无需 loading 状态
function DataList({ id }) {
  const resource = useMemo(() => createResource(fetchData(id)), [id])
  const data = resource.read()  // 挂起或返回数据

  return data.map(item => <Card key={item.id} data={item} />)
}

// React 18 新增 use() Hook（实验性，更简洁）
import { use } from 'react'
function DataList({ dataPromise }) {
  const data = use(dataPromise)  // 自动处理 Suspense
  return data.map(item => <Card key={item.id} data={item} />)
}
```

### ErrorBoundary + Suspense 完整组合

```js
class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return <ErrorPage error={this.state.error} onRetry={() => this.setState({ hasError: false })} />
    }
    return this.props.children
  }
}

// 嵌套结构：外层捕获错误，内层提供加载状态
function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageSkeleton />}>
        <MainPage />
      </Suspense>
    </ErrorBoundary>
  )
}
```

### React Server Components（RSC）

| 维度 | SSR | RSC |
|------|-----|-----|
| 执行位置 | 服务端渲染 HTML | 服务端执行，返回 RSC Payload |
| 水合 | 需要客户端重建组件树（hydration） | 无需水合，直接合并到客户端树 |
| 状态 | 服务端渲染后客户端接管 | Server Component 无客户端状态 |
| 数据获取 | getServerSideProps 等 | async/await 直接写在组件内 |
| Bundle | 组件代码下发到客户端 | Server Component 代码不进客户端 Bundle |

**RSC 优势**：减少 JS bundle、直接访问数据库/文件系统、自动 streaming。

---

## 七、Commit 三阶段

### 总览

```
commitRoot(root)
    ↓
【Before Mutation 阶段】commitBeforeMutationEffects
    ├── 遍历 effectList（subtreeFlags）
    ├── 调用 getSnapshotBeforeUpdate（class 组件）
    └── scheduleCallback 异步调度 useEffect（Passive effect）
    ↓
【Mutation 阶段】commitMutationEffects
    ├── 处理 ContentReset：清空文本节点
    ├── 处理 Ref：解绑旧 ref（ref.current = null）
    ├── 处理 Placement：插入新 DOM
    ├── 处理 Update：更新 DOM 属性
    └── 处理 Deletion：删除 DOM + 调用 componentWillUnmount / useEffect cleanup
    ↓
【切换 current 指针】
    root.current = finishedWork
    ↓
【Layout 阶段】commitLayoutEffects
    ├── 调用 componentDidMount / componentDidUpdate（class）
    ├── 调用 useLayoutEffect callback（同步，阻塞绘制）
    └── 绑定新 ref（ref.current = DOM/instance）
    ↓
浏览器绘制
    ↓
【异步】flushPassiveEffects
    ├── 执行上一轮 useEffect cleanup
    └── 执行本轮 useEffect callback
```

### 关键时序：current 指针何时切换？

```
Mutation 阶段末尾 / Layout 阶段开始前切换

原因：
  componentWillUnmount 需要访问旧 DOM → Mutation 阶段 current 仍是旧树
  componentDidMount/Update 需要访问新 DOM → Layout 阶段 current 已是新树
```

---

## 八、Reconciler Diff 算法

### 单节点 Diff

| key | type | 结果 |
|-----|------|------|
| 相同 | 相同 | 复用 Fiber，更新 props |
| 相同 | 不同 | 删除旧节点，创建新节点 |
| 不同 | - | 删除旧节点，继续找 |
| 未找到 | - | 创建新节点 |

### 多节点 Diff（两轮遍历）

```
旧：A  B  C  D
新：A  B  E  C

第一轮：处理更新（顺序不变，只是改内容）
  i=0: 旧A 新A → key/type 相同 → 复用，i++
  i=1: 旧B 新B → key/type 相同 → 复用，i++
  i=2: 旧C 新E → key 不同 → 跳出第一轮

第二轮：处理新增/删除/移动
  将剩余旧节点（C D）存入 existingChildren Map<key, fiber>
  继续遍历新节点（E C）：
    E → Map 中找不到 → 创建新 Fiber（Placement）
    C → Map 中找到 → 复用，判断是否需要移动

移动判断（lastPlacedIndex 算法）：
  维护 lastPlacedIndex = 上一个复用节点在旧数组中的索引
  若复用节点在旧数组中的 index >= lastPlacedIndex → 不需移动
  若复用节点在旧数组中的 index <  lastPlacedIndex → 需要移动（打 Placement 标记）
```

### 经典移动场景

```
旧：A(0) B(1) C(2) D(3)
新：D    A    B    C

第一轮：D-A key 不同，直接退出
第二轮：Map = { A:0, B:1, C:2, D:3 }，lastPlacedIndex = 0

处理 D：oldIndex=3 >= lastPlacedIndex=0 → 不移动，lastPlacedIndex=3
处理 A：oldIndex=0 <  lastPlacedIndex=3 → 移动！打 Placement
处理 B：oldIndex=1 <  lastPlacedIndex=3 → 移动！打 Placement
处理 C：oldIndex=2 <  lastPlacedIndex=3 → 移动！打 Placement

结论：只移动 A/B/C 三次，而非移动 D 一次
→ 头部插入比尾部插入开销大（头部插入导致所有节点都被标记移动）
```

### key 的本质作用

```js
// ❌ 无 key：React 按 index 对比，类型变化就重建
[<A/>, <B/>, <C/>]  →  [<X/>, <A/>, <B/>, <C/>]
// index 0: A→X type 不同 → 删除 A，创建 X ... 全部重建

// ✅ 有 key：React 按 key 对比，精准找到可复用节点
[<A key="a"/>, <B key="b"/>, <C key="c"/>]
→ [<X key="x"/>, <A key="a"/>, <B key="b"/>, <C key="c"/>]
// X 新增，A/B/C 全部复用，只移动位置
```

---

## 九、手写实现

### Promise 任务调度器

```js
// 限制最大并发数为 2
class Scheduler {
  constructor(max = 2) {
    this.max = max
    this.running = 0
    this.queue = []
  }

  add(promiseCreator) {
    return new Promise((resolve, reject) => {
      this.queue.push(() => promiseCreator().then(resolve, reject))
      this.run()
    })
  }

  run() {
    while (this.running < this.max && this.queue.length) {
      const task = this.queue.shift()
      this.running++
      task().finally(() => {
        this.running--
        this.run()
      })
    }
  }
}
```

### 手写 useReducer

```js
function useReducer(reducer, initialState) {
  const [state, setState] = useState(initialState)
  const dispatch = useCallback((action) => {
    setState(prev => reducer(prev, action))
  }, [reducer])
  return [state, dispatch]
}
```

---

## 速查对比

| 主题 | 核心要点 |
|------|---------|
| Hooks 链表 | mount → mountState，update → updateState，按顺序读取 |
| Fiber | 链表代替递归，可中断，双缓存保证 UI 一致性 |
| Lane | 位运算表示优先级，SyncLane 直接同步，其他走 Scheduler |
| Commit | Before Mutation → Mutation → current 切换 → Layout → useEffect |
| Diff | 单节点 key+type，多节点两轮遍历 + lastPlacedIndex |
| React 18 | Automatic Batching、startTransition、useDeferredValue、Suspense 数据获取 |
