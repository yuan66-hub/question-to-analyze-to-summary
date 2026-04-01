# 前端工程化原理指南

> 涵盖构建工具原理、Monorepo 依赖管理、模块联邦与微前端、CI/CD 自动化、错误监控与可观测性、构建优化

---

## 目录

1. [构建工具深度](#一构建工具深度)
2. [Monorepo & 依赖管理](#二monorepo--依赖管理)
3. [模块联邦 & 微前端](#三模块联邦--微前端)
4. [CI/CD & 自动化](#四cicd--自动化)
5. [错误监控 & 可观测性](#五错误监控--可观测性)
6. [构建优化实战](#六构建优化实战)
7. [组件库工程化建设](#七组件库工程化建设)
8. [代码质量全链路保障](#八代码质量全链路保障)

---

## 一、构建工具深度

### Webpack Tree Shaking 原理

**为什么只对 ES Modules 有效？**

Tree Shaking 依赖**静态分析**——在构建时确定哪些导出被使用：

```js
// ✅ ES Modules：静态导入，构建时可分析
import { add } from './math'  // 只用了 add，subtract 可被摇掉

// ❌ CommonJS：动态导入，运行时才确定
const { add } = require('./math')  // Webpack 无法静态分析，整个 math.js 被打包
const method = getMethodName()
const fn = require('./math')[method]  // 完全无法分析
```

**排查摇树失效的方法**：

```bash
# 1. 检查 package.json 的 sideEffects
{
  "sideEffects": false,          // 所有文件无副作用，可摇树
  "sideEffects": ["*.css", "./polyfills.js"]  // 指定有副作用的文件
}

# 2. 检查 Babel 配置是否把 ESM 转成 CommonJS
{
  "presets": [
    ["@babel/preset-env", { "modules": false }]  // 保留 ESM！
  ]
}

# 3. 用 webpack-bundle-analyzer 可视化分析
npx webpack-bundle-analyzer dist/stats.json
```

---

### Webpack Module Federation 核心原理

```js
// 子应用 webpack.config.js
new ModuleFederationPlugin({
  name: 'trainApp',
  filename: 'remoteEntry.js',  // 暴露入口
  exposes: {
    './SearchComponent': './src/components/SearchComponent',
  },
  shared: { react: { singleton: true }, 'react-dom': { singleton: true } },
})

// 宿主应用
new ModuleFederationPlugin({
  name: 'shell',
  remotes: {
    trainApp: 'trainApp@https://train.example.com/remoteEntry.js',
  },
})

// 消费远程组件（运行时动态加载）
const SearchComponent = React.lazy(() => import('trainApp/SearchComponent'))
```

**对比 iframe 微前端**：

| 维度 | Module Federation | iframe |
|------|-------------------|--------|
| JS 隔离 | 弱（同 JS 上下文） | 强（天然沙箱） |
| 样式隔离 | 需手动（CSS Modules/Shadow DOM） | 强 |
| 通信 | 直接调用，简单 | postMessage，繁琐 |
| 性能 | 好（共享 React 单例） | 差（每个 iframe 独立渲染） |
| SEO | 友好 | 不友好 |
| 适用场景 | 同技术栈，需共享状态 | 强隔离需求，跨团队/跨技术栈 |

---

### Vite HMR 原理

**Vite HMR 工作流程**：
1. 文件变化 → Vite Dev Server 通过 WebSocket 推送更新通知
2. 浏览器收到通知 → 重新请求变化的模块（带时间戳 bust cache）
3. HMR Runtime 接管：调用模块的 `import.meta.hot.accept` 回调，局部更新

```js
// Vite HMR API（框架无关层）
if (import.meta.hot) {
  import.meta.hot.accept('./module.js', (newModule) => {
    // 收到新模块，手动处理更新逻辑
  })
}
```

**React 需要 `@vitejs/plugin-react` 的原因**：

React 组件的 HMR 面临两个挑战：
1. **状态保留**：纯替换模块会重置组件 state
2. **Hooks 顺序**：函数签名改变时需要完整重载而不是热更新

`@vitejs/plugin-react` 使用 React Fast Refresh：
- 注入 `__signature__` 跟踪 Hooks 变化
- 状态无变化时仅替换渲染函数，保留 state
- Hooks 发生变化时自动全量重载该组件树

---

## 二、Monorepo & 依赖管理

### pnpm 如何解决"幽灵依赖"问题

**幽灵依赖（Phantom Dependency）**：
```
npm/yarn 的扁平化 node_modules：
node_modules/
  react/
  lodash/          ← 被 react 依赖，但你的代码也能直接 import lodash
  your-package/

问题：你没有在 package.json 声明 lodash，但代码能用
→ 某天 react 不再依赖 lodash，你的代码就报错了
```

**pnpm 的解法（符号链接 + 内容寻址存储）**：
```
node_modules/
  .pnpm/                        ← 真实文件在这里（硬链接到全局 store）
    react@18.2.0/
      node_modules/
        react/                  ← react 的真实文件
        lodash/                 ← react 的依赖，只在 react 的子目录
  react -> .pnpm/react@18.2.0/node_modules/react  ← 软链接

// 你的代码：
import lodash from 'lodash'  // ❌ node_modules/lodash 不存在，报错！
// 强制你显式声明依赖，消除幽灵依赖
```

**全局 Content-Addressable Store**：
- 同一版本的包在磁盘只存一份（硬链接）
- 1000 个项目用同一版本 React，磁盘只有一份文件

---

### Turborepo 增量构建原理

**核心思想**：相同的输入 → 相同的输出 → 直接复用缓存

```js
// turbo.json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],      // 先构建依赖包
      "inputs": ["src/**", "package.json"],  // 缓存 key 的输入
      "outputs": ["dist/**"]        // 缓存的内容
    },
    "test": {
      "dependsOn": ["build"],
      "inputs": ["src/**", "tests/**"]
    }
  }
}
```

**缓存 Key 计算**：
```
Hash(
  任务名 + 包名,
  inputs 文件内容哈希,
  依赖包的输出哈希,
  环境变量（.env 声明的）
) → 缓存 Key
```

**Remote Cache（团队共享）**：
- 本地缓存 hit → 直接复用（~0ms）
- 本地 miss，Remote Cache hit → 下载缓存文件（比重新构建快）
- Remote miss → 构建，结果上传 Remote Cache

---

## 三、模块联邦 & 微前端

### 多端微前端架构设计

**架构选型建议**：
```
主壳 (Shell)
├── 全局状态（登录态、用户信息、通用总线）
├── 路由系统（统一 URL 规范）
└── 子应用注册表

子应用：
├── 业务模块 A → Module Federation（同技术栈，共享状态）
├── 业务模块 B → Module Federation
└── 第三方服务 → iframe（强隔离需求，跨技术栈）
```

**子应用通信方案**：
```js
// 方案1：EventBus（同框架，简单）
window.__APP_BUS__ = new EventEmitter()

// 子应用发布
window.__APP_BUS__.emit('order:created', { orderId: '123' })

// 另一子应用订阅
window.__APP_BUS__.on('order:created', handleOrder)

// 方案2：共享 Store（Module Federation shared）
// 所有子应用共享同一个 Zustand/Jotai store 实例
shared: {
  '@app/global-store': { singleton: true }
}
```

**路由设计**：
```
主路由（Shell）：/module-a/* → 激活子应用 A
子应用内部：自己处理 /module-a/search、/module-a/detail 等路由
→ 约定：子应用路由必须带业务前缀，避免冲突
```

---

## 四、CI/CD & 自动化

### 前端 CI/CD 流水线设计

**CI 流水线（每次 PR）**：
```yaml
# .github/workflows/ci.yml
jobs:
  quality-check:
    steps:
      - run: pnpm lint           # ESLint + TypeScript 检查
      - run: pnpm test:unit      # 单元测试 + 覆盖率检测
      - run: pnpm test:e2e       # 关键路径 E2E（登录/核心流程）
      - run: pnpm audit --audit-level=high  # 安全漏洞检测
      - run: pnpm build:analyze  # Bundle Size 检查（防止包体积膨胀）
```

**CD 流水线（合并到 main）**：
```
1. 构建产物上传 CDN（带 hash 的静态资源，永久缓存）
2. 更新 HTML 文件（不缓存）
3. 灰度发布：
   - 5% 流量 → 新版本（观察错误率）
   - 20% → 50% → 100%（每轮等待 30 分钟）
4. 监控告警：
   - JS 错误率上升 > 0.1% → 自动回滚
   - 核心接口成功率下降 > 1% → 人工介入
```

**灰度策略（基于用户 ID 哈希）**：
```js
// 确保同一用户体验一致
const bucket = crc32(userId) % 100
if (bucket < GRAY_PERCENT) {
  loadNewVersion()
} else {
  loadStableVersion()
}
```

---

### Feature Flag 动态功能开关

**Feature Flag 的价值**：
- 代码先上线，功能后开启（与发布解耦）
- 精准灰度：按用户/地区/设备开放
- A/B 测试：不同用户看不同版本
- 紧急关闭：出问题立即关闭，不用回滚代码

**实现方案**：

```js
// 服务端下发 flags（推荐）
const flags = await flagsmith.getFlags({ user: { id: userId } })

// React 封装
function Feature({ name, children, fallback = null }) {
  const enabled = useFeatureFlag(name)
  return enabled ? children : fallback
}

<Feature name="new_feature" fallback={<OldComponent />}>
  <NewComponent />
</Feature>
```

**常用服务**：LaunchDarkly、GrowthBook（开源）。

---

## 五、错误监控 & 可观测性

### 错误分类采集

```js
class ErrorMonitor {
  init() {
    // 1. JS 运行时错误
    window.addEventListener('error', (e) => {
      if (e.target !== window) return  // 区分资源错误
      this.report('js_error', {
        message: e.message,
        filename: e.filename,
        lineno: e.lineno,
        stack: e.error?.stack,
      })
    })

    // 2. 资源加载失败（img/script/link）
    window.addEventListener('error', (e) => {
      if (e.target === window) return
      this.report('resource_error', {
        tagName: e.target.tagName,
        src: e.target.src || e.target.href,
      })
    }, true)  // 捕获阶段

    // 3. Promise 未捕获异常
    window.addEventListener('unhandledrejection', (e) => {
      this.report('promise_error', {
        reason: e.reason?.message || String(e.reason),
        stack: e.reason?.stack,
      })
    })

    // 4. 接口错误（封装 fetch）
    const originalFetch = window.fetch
    window.fetch = async (...args) => {
      const start = Date.now()
      try {
        const res = await originalFetch(...args)
        if (!res.ok) {
          this.report('api_error', { url: args[0], status: res.status, duration: Date.now() - start })
        }
        return res
      } catch (e) {
        this.report('network_error', { url: args[0], error: e.message })
        throw e
      }
    }
  }
}
```

**错误率计算**：错误率 = 某时间窗口内有错误的 PV / 总 PV，用 Redis 滑动窗口统计，告警阈值 0.1%。

---

### TraceId 串联性能与错误数据

```js
// 1. 页面加载时生成 TraceId
const traceId = generateTraceId()  // 格式：{timestamp}-{userId}-{random}
window.__TRACE_ID__ = traceId

// 2. 所有请求携带 TraceId
fetch(url, {
  headers: { 'X-Trace-Id': traceId }
})

// 3. 所有错误上报携带 TraceId
this.report('js_error', {
  traceId,
  // ... 其他字段
})

// 4. 性能数据上报也带 TraceId
this.report('perf', {
  traceId,
  fcp: getFCP(),
  lcp: getLCP(),
})
```

通过 traceId 关联同一个用户会话的性能、错误、接口日志，发现 FCP > 3s 的页面错误率异常等规律。

---

## 六、构建优化实战

### Webpack 构建速度与体积优化

**构建速度优化**：

```js
// webpack.config.js
module.exports = {
  // 1. 缓存（最有效）
  cache: { type: 'filesystem' },

  // 2. 多线程编译（CPU 密集型）
  module: {
    rules: [{
      test: /\.[jt]sx?$/,
      use: [{
        loader: 'thread-loader',
        options: { workers: 4 }
      }, 'babel-loader']
    }]
  },

  // 3. 缩小解析范围
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: { '@': path.resolve(__dirname, 'src') }
  },
}
```

**产物体积优化**：
```bash
# 常见问题
1. moment.js → 替换为 dayjs（减少 200KB）
2. lodash 全量引入 → import { debounce } from 'lodash-es'（Tree Shaking）
3. antd 全量引入 → babel-plugin-import 按需加载
4. 图片未压缩 → image-webpack-loader
5. 代码分割不合理 → React.lazy + Suspense 拆分路由
```

---

### Long-Term Caching 构建产物 Hash 策略

**Hash 类型选择**：

| hash 类型 | 粒度 | 适用场景 |
|-----------|------|---------|
| `[hash]` | 整个构建 | 任何文件变更，所有 hash 变 → 不推荐 |
| `[chunkhash]` | chunk 粒度 | 同一 chunk 内容不变则 hash 不变 |
| `[contenthash]` | 文件内容 | **最细粒度，推荐** |

**推荐配置**：
```js
output: {
  filename: 'js/[name].[contenthash:8].js',
  chunkFilename: 'js/[name].[contenthash:8].chunk.js',
  assetModuleFilename: 'assets/[name].[contenthash:8][ext]',
}

optimization: {
  splitChunks: {
    cacheGroups: {
      vendors: {
        test: /[\\/]node_modules[\\/]/,
        name: 'vendors',
        chunks: 'all',
        // react/react-dom 不常变 → vendors hash 稳定
        // 业务代码变 → 只有业务 chunk 的 hash 变
      }
    }
  },
  runtimeChunk: 'single',  // 将 runtime 单独提取
}
```

---

## 七、组件库工程化建设

### 组件库从 0 到 1 的核心问题

**1. 构建产物格式**
```
ESM → Tree Shaking（按需打包）→ 给业务应用消费
CJS → SSR / 老 Node.js 环境
UMD → CDN 直接引用
类型声明 → .d.ts 文件
```

**2. 样式方案**
```
CSS Variables → 主题定制（品牌色切换）
CSS Modules → 样式隔离，避免类名冲突
PostCSS → autoprefixer 兼容性
```

**3. 按需加载**
```js
// 方案1：ES Modules 天然支持（推荐）
import { Button } from '@company/ui'  // Bundler 自动 Tree Shaking

// 方案2：babel-plugin-import（兼容旧 CJS）
// import Button from '@company/ui/Button'
```

**4. 文档与 Playground**
```
Storybook：组件文档 + 交互 Demo
Chromatic：视觉回归测试（防止样式无意修改）
```

**5. 版本发布**
```
changesets：版本号管理 + CHANGELOG 生成
```

**6. 测试**
```
Vitest：单元测试
@testing-library/react：组件交互测试
```

---

## 八、代码质量全链路保障

### 提交到上线的质量门禁

```
本地开发：
├── Husky pre-commit  → lint-staged（只检查变更文件，快）
├── commitlint        → 规范 commit message
└── TypeScript strict → 编译时类型检查

PR 阶段（CI）：
├── ESLint            → 代码规范
├── Prettier          → 格式统一
├── TypeScript        → 类型检查（tsc --noEmit）
├── 单元测试          → 覆盖率 ≥ 80%（核心模块 100%）
├── E2E 测试          → 关键用户路径
├── Bundle Size Check → 防止 PR 引入过大依赖
│   (size-limit：超出阈值 CI 失败)
├── 安全扫描          → npm audit --audit-level=high
└── Code Review       → 至少 1 位 Approver

发布阶段：
├── 灰度发布          → 5% → 20% → 100%
├── 监控大屏          → 错误率 / FCP / 接口成功率
└── 自动回滚          → 错误率上升超阈值
```

---

## 速查表

| 主题 | 核心考点 |
|------|---------|
| Vite | ESM 不打包 / esbuild 预构建 / Rollup 生产构建 |
| Webpack | Tree Shaking / sideEffects / contenthash / Module Federation |
| Monorepo | pnpm 幽灵依赖 / Turborepo 增量缓存 |
| 微前端 | Module Federation 原理 / iframe 对比 / 子应用通信 |
| CI/CD | 灰度发布 / Feature Flag / 自动回滚 |
| 监控 | 错误分类 / TraceId 串联 / 错误率计算 |
| 组件库 | ESM/CJS 双格式 / changesets / Storybook |
| 质量保障 | lint-staged / commitlint / size-limit / 覆盖率 |
