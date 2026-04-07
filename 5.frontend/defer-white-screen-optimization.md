# 使用 defer 优化白屏时间

## 一、白屏时间的定义与成因

**白屏时间**（FP / First Paint 之前的空白期）= 从用户输入 URL 到浏览器首次绘制像素的时间。

### 浏览器渲染关键路径

```
HTML 下载 → HTML 解析 → DOM 构建
                ↓
         遇到 <script> → 【暂停解析】→ 下载 JS → 执行 JS → 【恢复解析】
                ↓
         遇到 <link rel="stylesheet"> → 下载 CSS → CSSOM 构建
                ↓
         DOM + CSSOM → Render Tree → Layout → Paint（首次绘制）
```

**白屏的核心原因：普通 `<script>` 标签会阻塞 HTML 解析**。在脚本下载和执行完成之前，DOM 构建暂停，用户看到的是空白页面。

---

## 二、三种脚本加载方式对比

### 普通脚本（无属性）

```html
<script src="app.js"></script>
```

```
HTML 解析 ──▶ 🛑暂停 ──▶ 下载 JS ──▶ 执行 JS ──▶ 继续解析 ──▶ DOMContentLoaded
```

- 阻塞 DOM 解析，直接延长白屏时间
- 如果脚本很大或网络慢，用户可能看到数秒白屏

### async 脚本

```html
<script src="app.js" async></script>
```

```
HTML 解析 ──────────────────────────────▶ DOMContentLoaded
               ↕
         下载 JS ──▶ 🛑暂停解析 ──▶ 执行 JS ──▶ 恢复
```

- 下载阶段不阻塞解析
- **下载完成后立即执行，执行时仍会阻塞解析**
- 多个 async 脚本执行顺序不确定
- 适合独立脚本（如埋点、广告）

### defer 脚本

```html
<script src="app.js" defer></script>
```

```
HTML 解析 ──────────────────────────────▶ 全部完成 ──▶ 执行 defer JS ──▶ DOMContentLoaded
               ↕
         下载 JS（并行，不阻塞）
```

- **下载阶段不阻塞解析**
- **执行推迟到 DOM 解析完成之后、DOMContentLoaded 之前**
- 多个 defer 脚本按文档顺序执行
- **对白屏时间的优化效果最好**

---

## 三、defer 为什么能优化白屏时间

### 核心机制

```
没有 defer 的情况：
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌───────┐
│ 解析 HTML │──▶│ 下载+执行 │──▶│ 继续解析  │──▶│ 首次绘制│
│ （部分）  │   │ app.js   │   │ HTML     │   │       │
└──────────┘   └──────────┘   └──────────┘   └───────┘
                   阻塞 ⏱️

使用 defer 的情况：
┌──────────────────────────────┐   ┌───────┐   ┌──────────┐
│ 解析 HTML（完整，不被打断）      │──▶│ 首次绘制│──▶│ 执行 JS  │
│ ↕ 并行下载 app.js             │   │       │   │          │
└──────────────────────────────┘   └───────┘   └──────────┘
```

1. **HTML 解析不被打断**：DOM 树完整构建，浏览器可以尽早触发首次绘制
2. **JS 下载与解析并行**：利用网络空闲时间，不浪费带宽
3. **JS 执行不阻塞首屏渲染**：执行时机在 DOM 解析完成之后

### 量化影响

假设一个页面有 3 个脚本，每个下载 200ms、执行 100ms：

| 方式 | 白屏时间增加 | 说明 |
|------|------------|------|
| 普通 `<script>` | +900ms | 3×(200+100)，串行阻塞 |
| `async` | +100~300ms | 下载并行，但执行时可能打断解析 |
| `defer` | +0ms | 下载并行且执行不阻塞首屏绘制 |

---

## 四、实战用法

### 基本用法：将 `<head>` 中的脚本改为 defer

```html
<!-- ❌ 阻塞渲染 -->
<head>
  <script src="/js/vendor.js"></script>
  <script src="/js/app.js"></script>
</head>

<!-- ✅ defer 优化 -->
<head>
  <script src="/js/vendor.js" defer></script>
  <script src="/js/app.js" defer></script>
</head>
```

defer 脚本放在 `<head>` 中是最佳实践：
- 浏览器**尽早发现**脚本 URL，立即开始下载
- 同时**不阻塞后续 HTML 解析**
- 比放在 `</body>` 前更优，因为下载启动更早

### 与放在 `</body>` 前的对比

```html
<!-- 方式 A：放在 body 底部 -->
<body>
  <!-- 全部 HTML 内容 -->
  <script src="app.js"></script>
</body>
```

```
方式 A（body 底部）：
解析 HTML ────────────────────▶ 发现脚本 ──▶ 下载 ──▶ 执行

方式 B（head + defer）：
解析 HTML ────────────────────▶ DOM 完成 ──▶ 执行
     ↕ 发现脚本后立即开始下载
```

**`<head>` + `defer` 比 `</body>` 底部更快**，因为脚本下载提前开始，与 HTML 解析完全并行。

### 按职责分配加载策略

```html
<head>
  <!-- 关键 CSS：阻塞渲染但必须 -->
  <link rel="stylesheet" href="/css/critical.css">

  <!-- 核心应用逻辑：defer 保序 -->
  <script src="/js/vendor.js" defer></script>
  <script src="/js/app.js" defer></script>

  <!-- 独立的第三方脚本：async 无需保序 -->
  <script src="/js/analytics.js" async></script>
</head>
```

| 脚本类型 | 推荐策略 | 原因 |
|---------|---------|------|
| 框架 / 应用入口 | `defer` | 需要完整 DOM，需要保序 |
| 独立第三方（埋点、广告） | `async` | 无依赖关系，尽快执行即可 |
| 关键渲染路径上的 polyfill | 内联 `<script>` | 必须在其他脚本前同步可用 |
| 非首屏交互逻辑 | 动态 `import()` | 用户触发时再加载 |

---

## 五、defer 的执行时序细节

### 与 DOMContentLoaded 的关系

```js
// 执行顺序保证：
// 1. HTML 解析完成
// 2. defer 脚本按文档顺序依次执行
// 3. DOMContentLoaded 事件触发

document.addEventListener('DOMContentLoaded', () => {
  // 此时所有 defer 脚本已执行完毕
  // DOM 完全可用
})
```

### 与 CSS 的交互

defer 脚本执行前，浏览器会确保其前面的 CSS 已加载完成（因为 JS 可能查询样式信息）：

```html
<head>
  <link rel="stylesheet" href="styles.css">  <!-- 1. 先加载 CSS -->
  <script src="app.js" defer></script>         <!-- 2. defer 等 CSS 就绪后再执行 -->
</head>
```

**注意**：如果 CSS 加载很慢，defer 脚本的执行也会被延迟。优化 CSS 加载同样重要。

---

## 六、现代框架中的 defer 实践

### 构建工具自动处理

现代打包工具（Vite、webpack）在生成 HTML 时，默认为入口脚本添加合适的加载属性：

```html
<!-- Vite 生成的 HTML -->
<head>
  <link rel="stylesheet" href="/assets/index-BqeN2x.css">
  <script type="module" src="/assets/index-DfJ3k9.js"></script>
</head>
```

**`type="module"` 默认具有 defer 行为**：
- 下载不阻塞 HTML 解析
- 在 DOM 解析完成后执行
- 按依赖图顺序执行
- 无需手动添加 `defer`

### SSR/SSG 场景

```
服务端渲染流程：
1. 服务端生成完整 HTML → 用户立即看到内容（白屏时间极短）
2. <script defer> 加载 JS → hydration 激活交互
```

SSR + defer 是目前最优的白屏时间优化组合：
- HTML 包含完整内容，无需等待 JS 就能绘制
- defer 脚本并行下载，不阻塞首屏
- hydration 在 DOM 就绪后执行，激活交互能力

---

## 七、注意事项与常见陷阱

### 1. defer 仅对外部脚本有效

```html
<!-- ✅ 有效 -->
<script src="app.js" defer></script>

<!-- ❌ 无效：内联脚本忽略 defer -->
<script defer>
  console.log('我仍然会阻塞解析')
</script>
```

### 2. 动态插入的脚本默认 async

```js
const script = document.createElement('script')
script.src = 'app.js'
// 动态脚本默认 async=true，不保证顺序
// 如需 defer 行为，手动设置：
script.async = false
document.head.appendChild(script)
```

### 3. defer 不等于"不执行"

defer 只是推迟执行时机，脚本仍会在 DOMContentLoaded 之前执行。如果 defer 脚本本身很重（执行耗时长），仍会延迟 DOMContentLoaded 和可交互时间（TTI）。

```
大型 defer 脚本的影响：
DOM 解析完成 ──▶ 执行 defer JS（500ms）──▶ DOMContentLoaded ──▶ 用户可交互
                    ↑
              首屏绘制不受影响，但交互被延迟
```

**解决方案**：结合 Code Splitting，减小单个脚本体积。

### 4. 浏览器预加载扫描器（Preload Scanner）

现代浏览器有预加载扫描器，即使遇到阻塞脚本，也会提前扫描后续 HTML 发现资源并预下载。但 defer 仍然更优，因为它避免了**执行阶段**的阻塞。

---

## 八、性能监控

### 验证 defer 效果

```js
// 测量白屏时间
const paintEntries = performance.getEntriesByType('paint')
const fp = paintEntries.find(e => e.name === 'first-paint')
const fcp = paintEntries.find(e => e.name === 'first-contentful-paint')

console.log('白屏时间 (FP):', fp?.startTime, 'ms')
console.log('首次内容绘制 (FCP):', fcp?.startTime, 'ms')

// 测量 DOMContentLoaded 时间（defer 脚本执行完成的时间点）
const nav = performance.getEntriesByType('navigation')[0]
console.log('DOM 解析完成:', nav.domInteractive, 'ms')
console.log('DOMContentLoaded:', nav.domContentLoadedEventEnd, 'ms')
```

### Chrome DevTools 验证

1. **Performance 面板**：录制页面加载，观察 Parse HTML 是否被脚本中断
2. **Network 面板**：检查脚本请求的 Initiator 列，defer 脚本显示为 "Parser"
3. **Coverage 面板**：检查首屏加载的 JS 中有多少代码实际被执行（红色=未使用）

---

## 九、决策总结

```
是否首屏渲染必需？
├── 是 → 内联到 HTML 或 preload + 同步加载
└── 否 → 是否有依赖顺序？
    ├── 是 → defer（保证顺序，不阻塞解析）
    └── 否 → 是否需要尽快执行？
        ├── 是 → async（下载完立即执行）
        └── 否 → 动态 import()（用户触发时加载）
```

> **一句话总结**：把 `<script>` 从 `</body>` 底部移到 `<head>` 并加上 `defer`，是零成本优化白屏时间的最佳实践。`type="module"` 天然具备 defer 语义，现代项目通常已自动应用。
