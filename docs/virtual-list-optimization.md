# 虚拟列表优化场景全景梳理

## 一、场景类型分类

| 场景 | 核心难点 | 方案 |
|------|----------|------|
| **固定高度列表** | 最基础场景 | 直接计算偏移，性能最优 |
| **动态高度列表** | 高度未知、回流重排 | 预估高度 + `ResizeObserver` 滚动后修正 |
| **瀑布流** | 多列不等高定位 | 多列虚拟列表 + 绝对定位 |
| **虚拟树** | 展开/折叠节点管理 | 扁平化 + 虚拟滚动 |
| **虚拟表格** | 二维虚拟化 | 虚拟行 + 虚拟列（行列同时窗口化） |
| **聊天记录** | 反向滚动、新消息插入 | 反向虚拟列表 + sticky scroll |
| **日历/时间轴** | 双向无限滚动 | 双向缓冲区 + 动态数据加载 |

---

## 二、数据更新优化

### 2.1 增量渲染

仅更新变化的 DOM 节点，避免全量重绘。结合稳定的 `key` 复用已有 DOM 元素，让框架的 diff 算法高效匹配。

```jsx
// 稳定 key：使用业务唯一 ID，而非 index
<VirtualList>
  {items.map(item => (
    <Row key={item.id} data={item} />
  ))}
</VirtualList>
```

### 2.2 不可变数据结构

使用 Immutable.js 或 `structuredClone`，通过引用比较快速判断是否需要重渲染，减少深层 diff 开销。

```js
// 引用不变 → 跳过渲染
const nextItems = produce(items, draft => {
  draft[index].name = 'updated';
});
// 只有 items[index] 的引用变了，其他项引用不变
```

### 2.3 数据分片处理

配合 `requestIdleCallback` / `requestAnimationFrame` 分批处理大量数据变更，避免长任务阻塞主线程。

```js
function batchInsert(newItems, chunkSize = 100) {
  let i = 0;
  function processChunk(deadline) {
    while (i < newItems.length && deadline.timeRemaining() > 0) {
      const chunk = newItems.slice(i, i + chunkSize);
      appendToList(chunk);
      i += chunkSize;
    }
    if (i < newItems.length) {
      requestIdleCallback(processChunk);
    }
  }
  requestIdleCallback(processChunk);
}
```

### 2.4 Memoization 缓存

`React.memo` / `useMemo` / Vue `computed` 缓存行渲染结果，避免无关行的重渲染。

```jsx
const Row = React.memo(({ data, style }) => (
  <div style={style}>{data.name}</div>
));
// 只有当 data 引用变化时才重新渲染该行
```

### 2.5 resetAfterIndex()

react-window 提供的 API，当动态高度项数据变化时，只重新计算变化项之后的布局，避免全量重算。

```js
// 第 50 项高度变了，只重算 50 之后的偏移
listRef.current.resetAfterIndex(50, false);
```

---

## 三、滚动性能优化

### 3.1 缓冲区 Overscan

上下多渲染 N 行，减少快速滚动时的白屏闪烁。

```
┌──────────────┐
│  overscan 3  │  ← 视口上方多渲染 3 行
├──────────────┤
│              │
│   可视区域    │  ← 用户实际看到的内容
│              │
├──────────────┤
│  overscan 3  │  ← 视口下方多渲染 3 行
└──────────────┘
```

```jsx
<FixedSizeList overscanCount={5}>
  {Row}
</FixedSizeList>
```

### 3.2 IntersectionObserver 替代 scroll 事件

减少事件触发频率，浏览器级别的高效监听，无需手动节流。

```js
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      renderItem(entry.target.dataset.index);
    }
  });
}, { root: scrollContainer, rootMargin: '200px 0px' });
```

### 3.3 CSS content-visibility: auto

浏览器原生懒渲染，中小列表(< 10k 项)的轻量替代方案。

```css
.list-item {
  content-visibility: auto;
  contain-intrinsic-size: 0 50px; /* 预估高度，维持滚动条 */
}
```

**优势**：无需 JS，浏览器自动跳过离屏元素的渲染
**局限**：DOM 节点仍然存在（内存开销），超大列表仍需 JS 虚拟化

### 3.4 GPU 加速

```css
.virtual-list-container {
  will-change: transform;
  transform: translateZ(0); /* 创建合成层 */
}
```

### 3.5 滚动节流 / rAF 驱动

```js
let ticking = false;
container.addEventListener('scroll', () => {
  if (!ticking) {
    requestAnimationFrame(() => {
      updateVisibleRange(container.scrollTop);
      ticking = false;
    });
    ticking = true;
  }
});
```

### 3.6 DOM 回收 (DOM Recycling)

不销毁/创建 DOM 节点，而是复用已有节点替换内容，减少 GC 压力和布局抖动。

```
滚动前:  [A] [B] [C] [D] [E]
滚动后:  [C] [D] [E] [F] [G]

DOM 回收: 节点 A 的 DOM → 内容替换为 F
          节点 B 的 DOM → 内容替换为 G
          节点 C/D/E 的 DOM 不变
```

---

## 四、实时数据流场景 (WebSocket / Live Feed)

### 4.1 批量缓冲更新 (Batch Updates)

缓冲 WebSocket 消息，按 `requestAnimationFrame` 周期刷新，避免高频逐条渲染。

```js
let buffer = [];
let rafId = null;

ws.onmessage = (event) => {
  buffer.push(JSON.parse(event.data));

  if (!rafId) {
    rafId = requestAnimationFrame(() => {
      // 一次性刷入所有缓冲数据
      setItems(prev => [...buffer, ...prev]);
      buffer = [];
      rafId = null;
    });
  }
};
```

### 4.2 环形缓冲区 (Ring Buffer)

固定大小数组替代无限增长，防止内存泄漏。

```js
class RingBuffer {
  constructor(maxSize = 10000) {
    this.buffer = new Array(maxSize);
    this.head = 0;
    this.size = 0;
    this.maxSize = maxSize;
  }

  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.maxSize;
    this.size = Math.min(this.size + 1, this.maxSize);
  }
}
```

### 4.3 Web Worker 数据处理

将排序/过滤/聚合等计算卸载到 Worker 线程，主线程只负责渲染。

```js
// worker.js
self.onmessage = ({ data }) => {
  const sorted = data.items.sort((a, b) => b.timestamp - a.timestamp);
  const filtered = sorted.filter(item => item.score > threshold);
  self.postMessage({ result: filtered });
};
```

### 4.4 Sticky Scroll & 滚动位置保持

```js
function handleNewMessages(newMessages) {
  const isAtBottom = container.scrollHeight - container.scrollTop
                     <= container.clientHeight + 50;

  appendMessages(newMessages);

  if (isAtBottom) {
    // 用户在底部 → 自动滚动到最新
    container.scrollTop = container.scrollHeight;
  } else {
    // 用户在阅读历史 → 保持当前位置不跳动
    // 通过补偿 scrollTop 维持视觉位置
    container.scrollTop += getInsertedHeight(newMessages);
  }
}
```

---

## 五、搜索/过滤场景优化

### 5.1 过滤前置于虚拟化

先过滤数据集，再交给虚拟列表渲染，避免虚拟列表内部做无意义的遍历。

```js
const filteredItems = useMemo(
  () => items.filter(item => item.name.includes(keyword)),
  [items, keyword]
);

<VirtualList items={filteredItems} />
```

### 5.2 Debounce 输入

搜索输入防抖 200-300ms，减少中间态渲染。

```js
const debouncedKeyword = useDebouncedValue(keyword, 300);
```

### 5.3 跳转到匹配项

```js
const matchIndex = filteredItems.findIndex(item => item.id === targetId);
listRef.current.scrollToIndex(matchIndex);
```

---

## 六、无障碍 (Accessibility) 优化

### 6.1 ARIA 属性

虚拟列表只渲染部分 DOM，屏幕阅读器无法感知完整列表，需要 ARIA 属性补偿。

```html
<div role="listbox" aria-label="用户列表">
  <div
    role="option"
    aria-setsize="10000"
    aria-posinset="42"
    aria-selected="true"
  >
    Item 42
  </div>
</div>
```

- `aria-setsize`：告知屏幕阅读器列表总项数
- `aria-posinset`：当前项在列表中的位置

### 6.2 键盘导航

```js
function handleKeyDown(e) {
  switch (e.key) {
    case 'ArrowDown':
      setActiveIndex(prev => Math.min(prev + 1, total - 1));
      listRef.current.scrollToIndex(activeIndex + 1);
      break;
    case 'ArrowUp':
      setActiveIndex(prev => Math.max(prev - 1, 0));
      listRef.current.scrollToIndex(activeIndex - 1);
      break;
    case 'Home':
      setActiveIndex(0);
      listRef.current.scrollToIndex(0);
      break;
    case 'End':
      setActiveIndex(total - 1);
      listRef.current.scrollToIndex(total - 1);
      break;
  }
}
```

### 6.3 焦点管理

使用 `aria-activedescendant` 管理虚拟焦点，避免真实 DOM 焦点丢失。

```html
<div role="listbox" aria-activedescendant={`item-${activeIndex}`}>
  {visibleItems.map(item => (
    <div id={`item-${item.index}`} role="option">
      {item.content}
    </div>
  ))}
</div>
```

---

## 七、其他进阶方向

| 方向 | 说明 |
|------|------|
| **SSR 兼容** | 服务端无容器高度，需骨架屏占位 + 客户端 hydrate 后切换虚拟列表 |
| **预加载 & 骨架屏** | 未测量的项显示 Skeleton，测量后替换为真实内容 |
| **Hybrid 方案** | 小列表用 `content-visibility: auto`，大列表用 JS 虚拟化，按数据量自动切换 |
| **多级缓存** | 可视区(精确渲染) → 缓冲区(简化渲染) → 离屏(不渲染) 三级策略 |
| **拖拽排序** | 虚拟列表中的拖拽需特殊处理，拖出可视区后 DOM 不存在，需维护虚拟占位 |
| **选择状态管理** | 全选/批量操作时在数据层维护选中态，而非依赖 DOM checkbox 状态 |

---

## 八、主流库对比 (2024-2025)

| 库 | 框架 | 特点 |
|----|------|------|
| **@tanstack/react-virtual** | 框架无关 | headless、最灵活、社区活跃 |
| **react-window** | React | 轻量、API 简洁、固定/动态高度 |
| **react-virtuoso** | React | 自动测量高度、内置分组/反向滚动/无限加载 |
| **vue-virtual-scroller** | Vue | Vue 生态首选，支持动态高度 |
| **Angular CDK Virtual Scroll** | Angular | 官方支持，与 Angular 生态深度集成 |

---

## 九、面试串讲思路

推荐从浅到深的讲解路线：

```
基础虚拟化原理（固定高度）
    ↓
动态高度处理（预估 + ResizeObserver 修正）
    ↓
滚动性能优化（Overscan / rAF / GPU 加速）
    ↓
数据更新优化（不可变数据 / Memo / 增量渲染）
    ↓
实时数据流（批量缓冲 / 环形缓冲区 / Worker）
    ↓
DOM 回收 vs content-visibility 混合方案
    ↓
无障碍（ARIA / 键盘导航 / 焦点管理）
```
