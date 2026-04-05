# 浏览器回流（Reflow）与重绘（Repaint）底层机制深度分析

## 一、渲染管线中的位置

浏览器渲染管线是理解回流和重绘的基础：

```
DOM Tree + CSSOM → Render Tree → Layout（回流）→ Paint（重绘）→ Composite
```

**关键点：回流一定在重绘之前。** 这不是"优先级"问题，而是管线顺序——Layout 阶段在 Paint 阶段之前。

## 二、回流（Layout / Reflow）

### 底层做了什么

回流的本质是 **几何计算**——遍历 Render Tree，为每个节点计算精确的位置和尺寸（盒模型）。

```
对每个 RenderObject:
  1. 计算 width/height（受 parent 约束）
  2. 计算 x/y 偏移量（相对于包含块）
  3. 如果该节点的几何变化影响了兄弟/子节点 → 递归重算
```

Chromium（Blink）内部调用链：

```
LayoutObject::SetNeedsLayout()
  → 向上标记 dirty bit 到根节点
  → 在下一帧 Document::UpdateStyleAndLayout()
    → LayoutObject::Layout()（自顶向下递归）
```

### 触发条件

任何影响 **几何属性** 的操作：

| 类别 | 示例 |
|------|------|
| 尺寸变化 | `width`, `height`, `padding`, `margin`, `border-width` |
| 位置变化 | `top`, `left`, `position`, `float` |
| 结构变化 | DOM 增删、`display: none ↔ block`、文本内容变化 |
| 字体变化 | `font-size`, `font-family`（影响文本度量） |
| 读取布局属性 | `offsetWidth`, `getBoundingClientRect()` 等 |

## 三、重绘（Paint / Repaint）

### 底层做了什么

重绘的本质是 **像素填充**——根据已计算好的几何信息，生成绘制指令（Paint Records）。

```
对每个 RenderObject:
  1. 生成绘制指令（背景色、边框、文字、阴影等）
  2. 按照 stacking context 顺序组织图层
  3. 输出 DisplayItemList → 交给合成器光栅化
```

### 触发条件

改变 **视觉属性** 但不影响几何：

| 属性 | 说明 |
|------|------|
| `color`, `background-color` | 颜色变化 |
| `visibility: hidden` | 不改变布局，只是不画 |
| `box-shadow`, `text-shadow` | 视觉效果 |
| `border-style`（不改宽度时） | 边框样式 |
| `outline` | 不占布局空间 |

## 四、为什么有时只触发一次？

### 4.1 浏览器的批处理机制（Batching）

**这是最关键的优化。** 浏览器不会每次 DOM 操作都立即回流/重绘，而是：

```
JS 执行期间:
  div.style.width = '100px'   → 标记 dirty
  div.style.height = '200px'  → 标记 dirty（同一节点，已标记）
  div.style.margin = '10px'   → 标记 dirty（同一节点，已标记）

JS 执行完毕 → 进入渲染帧:
  一次性 Layout → 一次性 Paint → Composite
```

**原理：** 浏览器使用 **dirty bit 标记系统**。多次修改只是反复设置同一个 dirty flag，最终只需要一次完整的布局计算。

### 4.2 强制同步布局（Forced Synchronous Layout）—— 批处理的破坏者

```javascript
// 坏模式：读写交替 → 每次读取都强制回流
for (let i = 0; i < elements.length; i++) {
  elements[i].style.width = box.offsetWidth + 'px'; // 读 → 强制回流！
}
```

**为什么？** 当你在 dirty 状态下读取布局属性（`offsetWidth` 等），浏览器必须 **立即执行布局** 才能返回正确值。这叫 **Forced Layout / Layout Thrashing**。

```
写 → dirty
读 → 必须先 flush，执行 Layout，返回值
写 → dirty
读 → 又要 flush...
```

**修复：先批量读，再批量写**

```javascript
// 好模式：读写分离
const width = box.offsetWidth; // 只读一次
for (let i = 0; i < elements.length; i++) {
  elements[i].style.width = width + 'px'; // 只写，不触发强制回流
}
// 帧结束 → 一次 Layout + 一次 Paint
```

### 4.3 只重绘不回流的场景

```javascript
div.style.color = 'red';
div.style.backgroundColor = 'blue';
// 两个都是纯视觉属性 → 跳过 Layout，直接 Paint
```

管线变为：

```
Style → Paint → Composite     （跳过 Layout）
```

### 4.4 跳过回流和重绘的场景（只合成）

```javascript
div.style.transform = 'translateX(100px)';
div.style.opacity = 0.5;
```

`transform` 和 `opacity` 在合成层（Compositor Layer）处理，**完全跳过主线程的 Layout 和 Paint**：

```
Compositor Thread: 直接变换纹理 → 极快
```

这就是为什么动画推荐用 `transform` 而不是 `left/top`。

## 五、回流和重绘一起触发时的关系

**不存在"优先级"的概念，而是因果关系：**

```
回流（Layout） ──必然触发──→ 重绘（Paint）
```

改了几何属性 → 位置/尺寸变了 → 像素必须重新填充 → 重绘是回流的必然后果。

但反过来不成立：

```
重绘（Paint） ──不一定──→ 回流（Layout）
```

在同一帧内的执行流程：

```
┌─────────────────────────────────────────────────┐
│  requestAnimationFrame callback                  │
│  ↓                                               │
│  Style Recalc（重新计算样式）                      │
│  ↓                                               │
│  Layout（如果有 dirty 几何属性）← 回流             │
│  ↓                                               │
│  Paint（如果有视觉变化）       ← 重绘             │
│  ↓                                               │
│  Composite（合成图层）                             │
└─────────────────────────────────────────────────┘
```

## 六、Chromium 内部的精细化优化

### 增量布局（Incremental Layout）

不是每次都从根节点全量计算：

```
修改了 div.A 的 width
  → 标记 A 为 dirty
  → 向上标记祖先链为 "子树需要布局"
  → Layout 时只递归 dirty 子树，跳过干净子树
```

### 布局边界（Layout Boundary）

某些 CSS 属性会创建 **布局隔离**：

```css
.container {
  contain: layout;  /* 显式隔离 */
  overflow: hidden;  /* 隐式隔离 */
}
```

内部变化不会扩散到外部，回流范围被限制。

### Paint Invalidation 的精细化

Blink 不会重绘整个页面，而是维护 **invalidation rects**：

```
只有几何/视觉变化的区域被标记为 invalidated
→ 只重绘这些矩形区域的 DisplayItems
→ 其余区域使用缓存
```

## 七、实战优化策略

### 7.1 减少回流次数

```javascript
// ❌ 逐条修改样式 → 可能触发多次 style recalc
el.style.width = '100px';
el.style.height = '200px';
el.style.margin = '10px';

// ✅ 使用 cssText 或 class 一次性修改
el.style.cssText = 'width:100px;height:200px;margin:10px';
// 或
el.classList.add('new-style');
```

### 7.2 离线 DOM 操作

```javascript
// ✅ DocumentFragment 批量插入
const fragment = document.createDocumentFragment();
for (let i = 0; i < 1000; i++) {
  const li = document.createElement('li');
  li.textContent = `Item ${i}`;
  fragment.appendChild(li);
}
list.appendChild(fragment); // 只触发一次回流

// ✅ display:none → 修改 → display:block
el.style.display = 'none'; // 一次回流
// ... 多次 DOM 操作（不触发回流，因为不在渲染树中）
el.style.display = 'block'; // 一次回流
```

### 7.3 动画性能

```javascript
// ❌ 用 left/top 做动画 → 每帧回流 + 重绘
element.style.left = x + 'px';

// ✅ 用 transform 做动画 → 只走合成，跳过主线程
element.style.transform = `translateX(${x}px)`;

// ✅ 用 will-change 提示浏览器提升合成层
.animated {
  will-change: transform;
}
```

### 7.4 使用 requestAnimationFrame

```javascript
// ✅ 将 DOM 写操作集中到 rAF 回调中
requestAnimationFrame(() => {
  // 所有写操作在同一帧内执行
  el1.style.width = '100px';
  el2.style.height = '200px';
  el3.style.margin = '10px';
});
```

## 八、总结

| 场景 | Layout | Paint | Composite | 次数优化 |
|------|--------|-------|-----------|---------|
| 修改 `width` | 1 次 | 1 次 | 1 次 | 批处理合并 |
| 修改 `color` | 跳过 | 1 次 | 1 次 | — |
| 修改 `transform` | 跳过 | 跳过 | 1 次 | GPU 直接处理 |
| 循环中读写交替 | N 次 | 1 次 | 1 次 | Layout Thrashing |
| `rAF` 中批量写 | 1 次 | 1 次 | 1 次 | 最佳实践 |

**核心结论：**

1. **回流必然导致重绘**，反之不然——这是管线因果，不是优先级
2. **浏览器默认会批处理**，同一帧内多次修改只触发一次回流 + 重绘
3. **强制同步布局**（读写交替）是批处理的破坏者，导致多次回流
4. 用 `transform` / `opacity` 做动画可以 **完全跳过** 回流和重绘，只走合成
