# React 流式输出渲染优化

> AI 逐字输出时，每生成一个 token 就触发一次状态更新，导致组件树频繁重渲染。以下是针对这一问题的优化策略。

## 1. 批量更新（最常用）

```tsx
// 累积字符，定时批量更新而非逐字更新
const [displayText, setDisplayText] = useState('');

// 用 ref 存储中间值，只在视觉需要时同步到 state
const bufferRef = useRef('');

useEffect(() => {
  const interval = setInterval(() => {
    if (bufferRef.current !== displayText) {
      setDisplayText(bufferRef.current);
    }
  }, 50); // 50-100ms 的批量窗口
}, [displayText]);

// AI 流式回调只更新 ref
onToken: (token) => { bufferRef.current += token; }
```

## 2. useDeferredValue

```tsx
const [text, setText] = useState('');
const deferredText = useDeferredValue(text);

// deferredText 可以安全地用于渲染，不阻塞用户交互
```

## 3. useTransition

```tsx
const [isPending, startTransition] = useTransition();

onToken: (token) => {
  startTransition(() => {
    setText(prev => prev + token);
  });
}
```

## 4. Ref + 最小化 State 同步

```tsx
// 完全避免逐字渲染，用 ref 累计，外部容器按需更新
const contentRef = useRef('');
const [, forceUpdate] = useReducer(x => x + 1, 0);

onToken: (token) => {
  contentRef.current += token;
  forceUpdate(); // 或用 requestAnimationFrame 控制频率
}
```

## 5. 独立渲染层

```tsx
// 将流式文本渲染隔离到独立子组件，避免父组件重渲染
const StreamingText = memo(({ text }) => <p>{text}</p>);
```

## 6. requestAnimationFrame 节流

```tsx
onToken: (token) => {
  bufferRef.current += token;
  if (!rafScheduled.current) {
    rafScheduled.current = true;
    requestAnimationFrame(() => {
      setDisplayText(bufferRef.current);
      rafScheduled.current = false;
    });
  }
}
```

## 优化方案对比

| 场景 | 推荐方案 |
|------|---------|
| 简单场景 | setInterval 批量 + ref |
| 复杂 UI 需保持响应 | useDeferredValue + memo |
| 需要显示 loading 状态 | useTransition + isPending |
| 超长文本（几千+字符） | virtual list + 批量渲染 |

## 性能对比

| 方案 | 渲染次数 |
|------|---------|
| 无优化 | 每 token 触发一次完整重渲染 |
| 批量 50ms | 约 20 次/秒 |
| RAF 节流 | 约 60 次/秒（与屏幕刷新率同步）|

## 推荐实践

**方案 1（批量更新）+ 方案 5（独立组件）** 的组合效果最好，实现简单且性能收益明显。

```tsx
// 完整示例：批量更新 + 独立组件
const StreamingMessage = memo(({ text }) => <p>{text}</p>);

function ChatMessage({ onToken }) {
  const [displayText, setDisplayText] = useState('');
  const bufferRef = useRef('');
  const rafRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => {
      if (bufferRef.current !== displayText) {
        setDisplayText(bufferRef.current);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [displayText]);

  return <StreamingText text={displayText} />;
}
```
