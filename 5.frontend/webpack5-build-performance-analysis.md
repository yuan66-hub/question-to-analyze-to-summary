# Webpack 5 打包缓慢 / 内存过高的全场景分析与优化

## 一、问题背景

大型代码仓库（几千到上万个模块、大量第三方依赖、TS + 各种 loader）中，Webpack 5 打包慢和内存高通常不是单一原因，而是以下因素叠加的结果：

- **CPU 密集**：转译（babel / ts-loader / terser）、AST 解析、代码压缩是单线程 CPU 瓶颈。
- **内存密集**：模块图（module graph）、AST、source map、缓存对象常驻内存，模块越多堆越大。
- **I/O 密集**：`node_modules` 海量小文件的 stat / read、磁盘缓存读写。
- **构建策略问题**：`resolve` 配置不合理、`source-map` 类型过重、loader 处理范围过宽、重复打包、循环依赖。
- **内存泄漏**：watch / dev server 长时间运行时缓存不释放、插件持有引用、`memory` 缓存无限增长。

工程目标不是“越快越好”这种模糊说法，而是：

1. 能**量化定位**瓶颈在哪个阶段（resolve / build modules / optimize / emit）。
2. 区分是**电脑性能/内存**限制，还是**配置/策略**问题。
3. 分别优化**全量编译（冷启动 / CI）**和**增量编译（本地 watch）**。
4. 建立可持续的构建性能约束（缓存、并行、监控）。

---

## 二、先量化：打包过程的性能分析方法

优化前必须先测量，否则容易“凭感觉”改配置。

### 1. Webpack 内建的阶段耗时

最简单的是打开 `stats`，看各阶段和模块耗时：

```bash
# 生成详细 stats
webpack --profile --json > stats.json
```

将 `stats.json` 上传到 [webpack analyse](https://webpack.github.io/analyse/) 或用 `webpack-bundle-analyzer` 查看模块体积分布。

### 2. speed-measure-webpack-plugin：按 loader / plugin 统计耗时

```js
const SpeedMeasurePlugin = require("speed-measure-webpack-plugin");
const smp = new SpeedMeasurePlugin();

module.exports = smp.wrap({
  // ...原始 webpack 配置
});
```

输出示例（能直接看出哪个 loader / plugin 最耗时）：

```
 SMP  ⏱
General output time took 42.3 secs

 SMP  ⏱  Plugins
TerserPlugin took 18.7 secs

 SMP  ⏱  Loaders
babel-loader took 21.4 secs (module count = 3120)
css-loader took 3.2 secs (module count = 210)
```

> 注意：SMP 与部分新插件（如 mini-css-extract、某些 webpack 5 插件）可能不兼容，仅在“分析阶段”临时启用，分析完就移除。

### 3. Node.js 层面的 CPU / 内存 Profile

Webpack 本质是 Node 进程，可用 Node 自带工具剖析：

```bash
# CPU profile：生成 .cpuprofile，用 Chrome DevTools 的 Performance 或 speedscope 打开
node --cpu-prof --cpu-prof-dir=./profile ./node_modules/webpack/bin/webpack.js

# 内存：打印 GC 和堆信息
node --trace-gc ./node_modules/webpack/bin/webpack.js

# 生成堆快照分析内存占用 / 泄漏
node --heap-prof ./node_modules/webpack/bin/webpack.js
```

用 [speedscope](https://www.speedscope.app/) 打开 `.cpuprofile`，火焰图能直观看到时间花在 `parse`、`transform`、`minify` 还是 `resolve`。

### 4. 观察实时内存

```bash
# 提高 Node 堆上限（大仓库常见，先临时救急，再找根因）
node --max-old-space-size=8192 ./node_modules/webpack/bin/webpack.js
```

Windows PowerShell 观察进程内存：

```powershell
# 实时看 node 进程内存占用
Get-Process node | Select-Object Id, @{N='Mem(MB)';E={[math]::Round($_.WorkingSet64/1MB,1)}}
```

如果内存持续爬升到接近 `--max-old-space-size` 然后崩溃（`JavaScript heap out of memory`），要区分是“单次全量确实需要那么多内存”还是“watch 模式下泄漏”。

---

## 三、如何观察构建会经过哪些流程、哪些 loader / plugin

优化前常需要先“看清”构建到底走了哪些流程、命中了哪些 loader/plugin、有没有缓存与解析等前置处理。方法按粒度从粗到细：

### 1. 看整体流程与阶段耗时（最快上手）

**`--profile --json` 导出完整构建数据**

```bash
webpack --profile --json > stats.json
```

`stats.json` 包含每个模块经过的 loader 链、构建耗时、所属 chunk、依赖关系。上传到 [webpack analyse](https://webpack.github.io/analyse/) 可视化查看模块图和 loader 链。

**内建 ProfilingPlugin —— 生成生命周期时间线火焰图**

```js
const webpack = require('webpack');
plugins: [
  new webpack.debug.ProfilingPlugin({ outputPath: './profile.json' }),
];
```

生成的 `profile.json` 直接拖进 **Chrome DevTools 的 Performance 面板**（或 `chrome://tracing`），能看到每个插件钩子、每个阶段（make / seal / optimize / emit）的时间线。这是观察“完整生命周期流程”最直观的工具。

**speed-measure-webpack-plugin —— 按 loader/plugin 统计耗时**

```js
const SpeedMeasurePlugin = require('speed-measure-webpack-plugin');
module.exports = new SpeedMeasurePlugin().wrap({ /* 配置 */ });
```

直接列出每个 loader（含 module count）和每个 plugin 花了多久，一眼看出谁最重。

### 2. 看内部流程日志（resolve、缓存等前置处理）

Webpack 5 内部很多流程（`resolve` 解析、`cache` 命中/写入、`PackFileCacheStrategy`、各插件日志）默认不显示，通过 logger 打开：

```js
module.exports = {
  stats: {
    logging: 'verbose',        // 显示所有内部日志
    loggingDebug: [/webpack\.cache/, /ResolverCachePlugin/], // 针对特定模块开 debug
  },
  infrastructureLogging: {
    level: 'verbose',
    debug: [/PackFileCache/, /webpack\.cache/],
  },
};
```

这里能看到**缓存是否命中、resolve 走了哪些路径、持久化缓存的读写**，也就是所谓的“预处理/前置”环节。

追踪模块解析也可用 `DEBUG` 环境变量：

```powershell
# Windows PowerShell
$env:DEBUG="webpack*"; webpack
```

### 3. 看生命周期钩子——理解“会经过哪些流程”

Webpack 流程本质是一串 **Tapable hooks**。写个极简插件把钩子按真实执行顺序打印出来：

```js
class TraceHooksPlugin {
  apply(compiler) {
    // compiler 级钩子：贯穿整个构建生命周期
    ['environment', 'beforeRun', 'run', 'beforeCompile', 'compile',
     'thisCompilation', 'compilation', 'make', 'afterCompile',
     'shouldEmit', 'emit', 'afterEmit', 'done'].forEach((name) => {
      const hook = compiler.hooks[name];
      if (hook) hook.tap('TraceHooksPlugin', () => console.log('[compiler]', name));
    });

    compiler.hooks.compilation.tap('TraceHooksPlugin', (compilation) => {
      // compilation 级钩子：单次编译内部的流程
      ['buildModule', 'finishModules', 'seal', 'optimize',
       'optimizeModules', 'optimizeChunks', 'optimizeTree',
       'processAssets'].forEach((name) => {
        const hook = compilation.hooks[name];
        if (hook) hook.tap('TraceHooksPlugin', () => console.log('  [compilation]', name));
      });
    });
  }
}
```

主线流程大致为：

```
run → beforeCompile → compile → make
  └─ buildModule（每个模块跑 loader）→ finishModules
seal → optimize（tree-shaking / splitChunks）
  → processAssets（压缩、生成 source map）
emit（写盘）→ done
```

### 4. 看单个模块命中了哪些 loader

- `stats.json` 里每个 module 的 `identifier` 会显示完整 loader 链，例如：
  `.../babel-loader/lib/index.js!.../ts-loader/index.js!./src/a.ts`
  从右到左就是 loader 执行顺序。
- 或临时给 loader 加 `console.log(this.resourcePath)`，确认哪些文件真的经过了它。

### 5. 关于“预构建流程”的澄清

**Webpack 本身没有 Vite 那种独立的“依赖预构建（pre-bundling）”阶段**。通常所说的“前置处理”在 Webpack 里指：

- **持久化缓存的读取/校验**（`cache: filesystem`）→ 用 `infrastructureLogging.debug: [/PackFileCache/]` 观察。
- **模块解析（resolve）**→ 用 `loggingDebug` / `DEBUG` 追踪。
- **DllPlugin 的预打包**（旧方案）或 **Module Federation 的 remote 加载**→ 看对应插件日志。

若实际使用的是 **Vite / Rspack**，它们的依赖预构建（esbuild pre-bundle）有各自的 `--debug` 日志，需另行分析。

---

## 四、Webpack 构建的四个阶段与各自瓶颈

理解阶段有助于对症下药。一次编译大致分为：

| 阶段 | 做什么 | 典型瓶颈 | 主要消耗 |
|---|---|---|---|
| **Resolve（模块解析）** | 根据 import 找到真实文件路径 | `extensions` 过多、`node_modules` 深层查找、symlink | I/O + CPU |
| **Build Modules（构建模块）** | 用 loader 转译每个模块、解析 AST、收集依赖 | babel/ts-loader 转译慢、loader 范围过宽 | CPU（最大头） |
| **Optimize（优化）** | Tree-shaking、SplitChunks、代码压缩（Terser） | Terser 压缩、chunk 分割计算 | CPU |
| **Emit（产出）** | 生成最终文件、source map、写磁盘 | source map 生成、大量小文件写盘 | 内存 + I/O |

大仓库里通常 **Build Modules（转译）** 和 **Optimize（压缩）** 占绝大部分时间；内存高峰通常在 **同时持有模块 AST + source map + 缓存** 的时候。

---

## 五、从电脑性能与内存角度分析

先排除“机器本身不够”的情况，再谈配置优化。

### 1. CPU

- Webpack **主流程是单线程**（Node 单线程 + V8）。转译和压缩才能通过 worker 并行。
- 因此**单核性能**对 Webpack 影响很大；核数多但没开并行 loader/压缩，等于浪费。
- 判断：CPU profile 里如果一个核长期 100%、其他核空闲 → 说明没并行，应开 `thread-loader` / 多进程压缩。

### 2. 内存

- 模块数量直接决定堆占用。上万模块 + source map + 持久缓存对象，堆很容易到 2–4GB 甚至更多。
- V8 默认老生代上限约 2GB（旧版）/4GB，大仓库需要 `--max-old-space-size` 调高。
- **`cache: { type: 'memory' }`** 在 watch 长时间运行下会持续增长，是 dev 阶段内存爬升的常见原因。
- source map 是内存大户：`devtool: 'source-map'` / `'eval-source-map'` 会为每个模块保留映射数据。

### 3. 磁盘 I/O

- `node_modules` 是海量小文件，`resolve` 阶段的 stat / read 在机械硬盘或网络盘（如公司挂载盘、WSL 跨文件系统）上会非常慢。
- **持久化缓存（filesystem cache）写在慢盘上反而拖慢**，应放在本地 SSD。
- 杀毒软件（尤其 Windows Defender 实时扫描）扫描 `node_modules` 和缓存目录会显著拖慢 I/O。

### 4. 快速判断表

| 现象 | 大概率原因 | 方向 |
|---|---|---|
| 单核 100%、其他核闲 | 无并行转译/压缩 | thread-loader / 并行 Terser |
| 全程 CPU 都很忙 | 转译量大、压缩重 | 缓存 + 减少转译范围 + SWC/esbuild |
| 内存持续爬升到 OOM（watch 下） | memory 缓存 / 泄漏 | filesystem 缓存、排查插件引用 |
| 冷启动慢、二次快 | 无持久缓存或缓存失效 | 开启 filesystem cache |
| 磁盘灯狂闪、CPU 不高 | I/O 瓶颈 | SSD、排除杀毒、缩小 resolve |

---

## 六、优化手段（按收益排序）

### 1. 开启持久化缓存（Webpack 5 最大收益点）

Webpack 5 内建 filesystem 缓存，二次构建可命中缓存，通常能把全量构建时间降低 50%–90%：

```js
module.exports = {
  cache: {
    type: 'filesystem',
    // 缓存放本地 SSD，别放网络盘
    cacheDirectory: path.resolve(__dirname, '.temp_cache'),
    // 配置文件变化时自动失效缓存
    buildDependencies: {
      config: [__filename],
    },
    // 可按需设置版本，强制失效
    version: '1.0',
  },
};
```

配合 loader 级缓存（如 `babel-loader` 的 `cacheDirectory: true`）效果更好。CI 上把缓存目录做成流水线缓存，可显著加速。

### 2. 用更快的转译器替换 babel/ts-loader

转译是最大 CPU 头。用基于 Rust/Go 的工具替换：

- **esbuild-loader**：转译 + 压缩都快数倍。
- **swc-loader**：Rust 实现，兼容 babel 生态较好。

```js
// esbuild-loader 示例
{
  test: /\.[jt]sx?$/,
  loader: 'esbuild-loader',
  options: { target: 'es2018' },
}
```

代价：esbuild/swc **不做类型检查**，TS 类型检查应交给独立进程：

```js
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
// 类型检查放到单独进程，不阻塞打包
plugins: [new ForkTsCheckerWebpackPlugin()];
```

### 3. 多进程并行转译与压缩

```js
// thread-loader：把耗时 loader 放到 worker 池
{
  test: /\.js$/,
  use: [
    { loader: 'thread-loader', options: { workers: os.cpus().length - 1 } },
    'babel-loader',
  ],
}
```

> `thread-loader` 有进程通信开销，只对“重”loader 有收益，轻量 loader 反而变慢。若已用 esbuild/swc，往往不需要它。

压缩并行（Terser 默认已并行，可显式配置，或直接用 esbuild 压缩）：

```js
optimization: {
  minimizer: [
    // 方式一：Terser 并行
    new TerserPlugin({ parallel: true }),
    // 方式二：直接用 esbuild 压缩，更快
    // new ESBuildMinifyPlugin({ target: 'es2018' }),
  ],
}
```

### 4. 缩小 loader / resolve 的工作范围

减少不必要的解析和转译：

```js
module.exports = {
  resolve: {
    // 只保留真正用到的扩展名，减少 resolve 尝试
    extensions: ['.tsx', '.ts', '.js'],
    // 明确 modules 目录，避免逐级向上查找
    modules: [path.resolve(__dirname, 'src'), 'node_modules'],
    // 关闭不需要的字段解析
    mainFields: ['browser', 'module', 'main'],
  },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        // 只转译业务代码，排除 node_modules
        include: path.resolve(__dirname, 'src'),
        exclude: /node_modules/,
        use: 'esbuild-loader',
      },
    ],
    // 已知无依赖的大型库跳过解析
    noParse: /jquery|lodash-es\/lodash/,
  },
};
```

### 5. 合理的 source map 策略

source map 影响速度和内存很大，分环境选：

| 环境 | 推荐 devtool | 说明 |
|---|---|---|
| 开发（重速度） | `eval-cheap-module-source-map` | 增量快，列信息省略 |
| 开发（要精确） | `eval-source-map` | 慢一些但精确 |
| 生产 | `source-map` 或 `hidden-source-map` | 独立文件，不影响运行体积 |
| 追求极限速度 | `false` | 完全不生成 |

### 6. 减少产物计算量：DLL 的替代与 externals

- Webpack 5 有了持久缓存后，**DllPlugin 基本可以淘汰**，不推荐再用。
- 稳定的大型库可用 **externals + CDN**，让它们不进入打包：

```js
externals: {
  react: 'React',
  'react-dom': 'ReactDOM',
}
```

### 7. 精准的 SplitChunks，避免过度分包

分包过细会增加优化阶段计算和 HTTP 请求；过粗会导致缓存命中差。抓大放小：

```js
optimization: {
  splitChunks: {
    chunks: 'all',
    cacheGroups: {
      vendors: {
        test: /[\\/]node_modules[\\/]/,
        name: 'vendors',
        priority: 10,
      },
    },
  },
}
```

### 8. 开发环境专项加速

- 用 `mode: 'development'`，关闭压缩（`optimization.minimize: false`）。
- 只构建当前需要的入口，避免一次性构建全部页面。
- 考虑迁移 dev server 到 **Vite / esbuild** 等基于原生 ESM 的方案（大仓库 dev 冷启动收益巨大）。

---

## 七、内存泄漏 / 内存过高的专项排查

内存问题分两类，处理方式不同。

### 1. 全量构建“正常地”需要很多内存

- 模块多、source map 重，本身就吃内存。
- 处理：调高 `--max-old-space-size`、减小 source map、拆分构建（多入口分开跑）、用 filesystem 缓存降低单次内存峰值。

### 2. watch / dev server 下内存持续爬升（疑似泄漏）

排查思路：

1. **切换缓存类型**：把 `cache.type` 从 `'memory'` 改成 `'filesystem'`，观察是否仍爬升。memory 缓存在长时间 watch 下会累积。
2. **隔离插件/loader**：逐个禁用自定义插件，看哪个导致内存不回收。常见泄漏是插件在 `compilation` 钩子里把对象存进模块级数组/Map 却从不清理。
3. **抓堆快照对比**：在 watch 稳定后和多次改动后各抓一次 heap snapshot（`node --heap-prof` 或 Chrome DevTools 连接），对比哪种对象数量单调增长（常见是 Module、Source、NormalModule、闭包）。
4. **检查 source map + eval**：`eval-source-map` 在频繁 rebuild 时内存占用高，dev 可换更轻的。
5. **升级依赖**：老版本 loader/plugin（尤其自研或年久失修的）是泄漏高发区，升级 Webpack 与生态到较新版本。

### 3. 自定义插件避免泄漏的写法

```js
class MyPlugin {
  apply(compiler) {
    compiler.hooks.compilation.tap('MyPlugin', (compilation) => {
      // ❌ 不要用插件实例上的长生命周期容器累积每次编译的数据
      // this.cache.push(compilation.modules)  // 会随 rebuild 无限增长

      // ✅ 数据作用域限定在单次 compilation 内，编译结束即可回收
      const localData = new Map();
      compilation.hooks.finishModules.tap('MyPlugin', (modules) => {
        // 用完不要挂到外层引用
      });
    });
  }
}
```

---

## 八、大仓库（Monorepo / 超大代码量）的额外策略

代码量特别大时，光调 Webpack 配置边际收益有限，要从**构建架构**入手：

1. **按需构建 / 分包构建**：把巨型应用拆成多个可独立构建的包（monorepo + Turborepo/Nx），利用任务级缓存和增量构建，只构建改动影响到的包。
2. **Module Federation（模块联邦）**：Webpack 5 原生支持，把大应用拆成多个可独立部署/构建的远程模块，主应用不必全量打包所有代码。
3. **远程/分布式缓存**：Nx / Turborepo 的远程缓存让团队和 CI 共享构建产物，别人构建过的直接复用。
4. **CI 层面**：缓存 `node_modules`、Webpack `filesystem cache`；用高单核性能 + 大内存的机器；避免网络盘。
5. **评估换构建工具**：超大仓库可评估 **Rspack**（Rust 实现、兼容 Webpack 生态）或 **Vite（生产用 Rollup/Rolldown）**，通常有数量级的速度提升，迁移成本低于想象。

---

## 九、优化 checklist（速查）

**先测量**
- [ ] `--profile` + `speed-measure-webpack-plugin` 找出最耗时 loader/plugin
- [ ] `--cpu-prof` 火焰图确认 CPU 花在 transform 还是 minify
- [ ] `--trace-gc` / heap snapshot 确认是否内存泄漏

**降 CPU / 提速**
- [ ] 开启 `cache: { type: 'filesystem' }`（收益最大）
- [ ] babel/ts-loader → esbuild-loader / swc-loader，类型检查独立进程
- [ ] 重 loader 用 thread-loader，压缩并行 / 用 esbuild 压缩
- [ ] loader `include: src` / `exclude: node_modules`，精简 `resolve.extensions`

**降内存 / 防泄漏**
- [ ] source map 分环境选择，dev 用轻量、生产用独立文件
- [ ] watch 下用 filesystem 缓存而非 memory
- [ ] 自定义插件不在实例上累积数据
- [ ] 大仓库调高 `--max-old-space-size`，缓存放本地 SSD，排除杀毒扫描

**架构层**
- [ ] Monorepo 增量构建 + 远程缓存（Nx / Turborepo）
- [ ] Module Federation 拆分超大应用
- [ ] 评估迁移 Rspack / Vite

---

## 十、一句话总结

先用 profile 把瓶颈量化到具体阶段和具体 loader/plugin，再区分是“机器（单核/内存/磁盘）不够”还是“配置/策略”问题：**转译慢就换 esbuild/swc + 缓存 + 并行，压缩慢就并行/换 esbuild，内存高就分环境控制 source map、用 filesystem 缓存、排查插件泄漏，代码量特别大就从 monorepo 增量构建、Module Federation、乃至换 Rspack 等构建架构层面解决。**
