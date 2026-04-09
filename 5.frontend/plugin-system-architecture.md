# 插件系统架构设计

> 从图形编辑器、视频编辑器、IDE 等可扩展应用出发，系统梳理插件系统的设计原则、核心模式与工程实践。

---

## 目录

1. [插件系统适用场景](#1-插件系统适用场景)
2. [应用层架构适配分析](#2-应用层架构适配分析)
   - 2.1 [六种架构模式与插件系统的适配度](#21-六种架构模式与插件系统的适配度)
   - 2.2 [管道-过滤器架构（Pipeline-Filter）](#22-管道-过滤器架构pipeline-filter)
   - 2.3 [事件驱动架构（Event-Driven）](#23-事件驱动架构event-driven)
   - 2.4 [微内核架构（Microkernel）](#24-微内核架构microkernel)
   - 2.5 [分层架构 + 扩展层（Layered + Extension）](#25-分层架构--扩展层layered--extension)
   - 2.6 [组件化架构（Component-Based）](#26-组件化架构component-based)
   - 2.7 [中间件链架构（Middleware Chain）](#27-中间件链架构middleware-chain)
   - 2.8 [应用场景选型决策](#28-应用场景选型决策)
3. [核心架构模式](#3-核心架构模式)
   - 3.1 [微内核架构详解](#31-微内核架构详解)
   - 3.2 [生命周期模型](#32-生命周期模型)
   - 3.3 [依赖注入与服务定位](#33-依赖注入与服务定位)
4. [扩展点设计](#4-扩展点设计)
   - 4.1 [Hook / 拦截器模式](#41-hook--拦截器模式)
   - 4.2 [Contribution Point 声明式扩展](#42-contribution-point-声明式扩展)
   - 4.3 [Slot / 插槽机制](#43-slot--插槽机制)
5. [通信与隔离](#5-通信与隔离)
   - 5.1 [进程隔离（VS Code 模型）](#51-进程隔离vs-code-模型)
   - 5.2 [沙箱隔离（iframe / Worker / Wasm）](#52-沙箱隔离iframe--worker--wasm)
   - 5.3 [事件总线与消息协议](#53-事件总线与消息协议)
6. [典型应用实例](#6-典型应用实例)
   - 6.1 [图形编辑器插件系统（Figma 模型）](#61-图形编辑器插件系统figma-模型)
   - 6.2 [视频编辑器特效扩展](#62-视频编辑器特效扩展)
   - 6.3 [IDE 扩展系统（VS Code 模型）](#63-ide-扩展系统vs-code-模型)
   - 6.4 [构建工具插件（Webpack / Vite）](#64-构建工具插件webpack--vite)
7. [安全与性能](#7-安全与性能)
8. [面试高频问题](#8-面试高频问题)

---

## 1. 插件系统适用场景

### 什么时候需要插件系统

```
判断维度                        需要插件系统              不需要
───────────────────────────────────────────────────────────────
核心功能是否稳定？                核心稳定 + 外围多变        全部易变
扩展需求来自谁？                  第三方/用户/生态           仅内部团队
功能组合是否不可预见？             是                       可枚举
是否需要运行时动态加卸载？         是                       编译期确定
```

### 典型应用领域

| 领域 | 代表产品 | 插件解决什么 |
|------|----------|-------------|
| **图形编辑器** | Figma、Photoshop、Sketch | 自定义滤镜、批量操作、设计规范检查、资源导入导出 |
| **视频编辑器** | DaVinci Resolve、剪映、Adobe Premiere | 特效/转场/调色/字幕生成、编解码格式扩展 |
| **IDE** | VS Code、JetBrains | 语言支持、调试器、主题、代码片段、Git 集成 |
| **构建工具** | Webpack、Vite、Rollup | Loader/Transform/Optimize 各阶段扩展 |
| **低代码平台** | Retool、飞书多维表格 | 自定义组件、数据源连接器、工作流节点 |
| **CMS** | WordPress、Strapi | 内容类型、路由、权限、支付网关 |
| **浏览器** | Chrome、Firefox | 页面修改、网络拦截、开发者工具面板 |

---

## 2. 应用层架构适配分析

> 核心问题：不是所有应用都需要插件系统，也不是所有架构都适合做插件。从应用层出发，先判断**你的应用属于哪种架构形态**，再决定如何引入插件机制。

### 2.1 六种架构模式与插件系统的适配度

```
架构模式               插件适配度    典型产品              为什么适合/不适合
──────────────────────────────────────────────────────────────────────────
管道-过滤器 (Pipeline)   ★★★★★     视频编辑器/构建工具     数据流过管道，每个环节天然可替换
事件驱动 (Event-Driven)  ★★★★★     图形编辑器/协作工具     事件是天然扩展点，订阅即插入
微内核 (Microkernel)     ★★★★★     IDE/浏览器/操作系统     为插件而生的架构
分层+扩展层 (Layered)    ★★★★☆     CMS/低代码平台         固定层间插入扩展层
组件化 (Component)       ★★★☆☆     UI 框架/设计系统       组件粒度适合 UI 插件，不适合深层逻辑
中间件链 (Middleware)    ★★★★☆     Web 框架/API 网关      请求链天然可插拔
MVC/MVVM                ★★☆☆☆     普通 Web 应用          关注点分离好，但缺少明确扩展点
单体架构                 ★☆☆☆☆     小型工具               高耦合，难以定义稳定接口
```

**核心判断标准：一个架构是否适合插件系统，取决于它有没有「稳定的缝隙」—— 即数据流经的节点、事件触发的时刻、层与层之间的边界。这些缝隙就是插件的插入点。**

### 2.2 管道-过滤器架构（Pipeline-Filter）

**最适合插件系统的架构** —— 数据像水流经管道，每个过滤器是一个可插拔的处理环节。

```
输入 ──▶ [Filter A] ──▶ [Filter B] ──▶ [Filter C] ──▶ 输出
           解码           色彩校正        编码
           (内置)        (★ 可替换)      (内置)

                    ┌──────────────┐
                    │ 插入自定义    │
                    │ Filter       │
                    └──────┬───────┘
                           ▼
输入 ──▶ [Filter A] ──▶ [★ 降噪] ──▶ [Filter B] ──▶ [Filter C] ──▶ 输出
```

**视频编辑器 —— 渲染管道即插件链：**

```typescript
// 管道定义：每个 stage 都是可替换/可扩展的 Filter
class RenderPipeline {
  private filters: PipelineFilter[] = [];

  // 插件注册 Filter 到管道的指定位置
  insertFilter(filter: PipelineFilter, position: 'before' | 'after', anchor: string) {
    const idx = this.filters.findIndex(f => f.id === anchor);
    this.filters.splice(position === 'before' ? idx : idx + 1, 0, filter);
  }

  // 数据流经每个 Filter
  async process(frame: VideoFrame): Promise<VideoFrame> {
    let current = frame;
    for (const filter of this.filters) {
      current = await filter.process(current);  // 每个 filter 只关心输入→输出
    }
    return current;
  }
}

// 插件只需实现一个 Filter
const denoisePlugin: PipelineFilter = {
  id: 'plugin:denoise',
  type: 'wasm-module',
  process(frame: VideoFrame): VideoFrame {
    // 降噪处理，输入一帧，输出一帧
    return denoise(frame, { strength: 0.7 });
  }
};

pipeline.insertFilter(denoisePlugin, 'after', 'decode');
```

**构建工具 —— 编译管道即插件链：**

```typescript
// Vite/Rollup 的插件本质就是管道过滤器
// 源码 ──▶ [resolve] ──▶ [load] ──▶ [transform] ──▶ [generate]
//           ↑               ↑           ↑               ↑
//         插件可以在每个阶段插入自己的处理逻辑

function imageOptimizerPlugin(): Plugin {
  return {
    name: 'image-optimizer',
    // 在 load 阶段：拦截图片文件
    load(id) {
      if (id.endsWith('.png')) return optimizePNG(id);
    },
    // 在 transform 阶段：转换引用
    transform(code, id) {
      if (id.endsWith('.css')) return rewriteImageUrls(code);
    }
  };
}
```

**为什么管道-过滤器最适合插件：**

| 特性 | 为什么重要 |
|------|-----------|
| 每个 Filter 有统一的输入/输出接口 | 插件只需实现 `process(input) → output`，门槛极低 |
| Filter 之间无直接依赖 | 随意增删不影响其他环节 |
| 数据流方向明确 | 调试简单 —— 断点打在任意 Filter 前后即可 |
| 天然支持排序和优先级 | `insertBefore / insertAfter` 控制执行顺序 |

### 2.3 事件驱动架构（Event-Driven）

**图形编辑器的最佳选择** —— 用户操作产生事件，插件监听事件并响应。

```
┌──────────────────────────────────────────────────────────────┐
│                    Event-Driven Plugin System                  │
│                                                               │
│  用户操作                                                      │
│   ├─ click ──┐                                                │
│   ├─ drag  ──┤                                                │
│   ├─ key   ──┤     ┌──────────────┐     ┌────────────────┐   │
│   └─ paste ──┴────▶│  Event Bus   │────▶│ Plugin Manager │   │
│                     │              │     │                │   │
│  核心变更            │  分发给所有   │     │  路由到匹配的  │   │
│   ├─ node:added ──┐│  订阅者       │     │  插件          │   │
│   ├─ node:moved ──┤│              │     │                │   │
│   ├─ style:changed┤│              │     │  ┌───────────┐ │   │
│   └─ history:push ┘│              │     │  │ Plugin A  │ │   │
│                     │              │     │  │ Plugin B  │ │   │
│                     └──────────────┘     │  │ Plugin C  │ │   │
│                                          │  └───────────┘ │   │
│                                          └────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**图形编辑器中的事件驱动插件：**

```typescript
// 核心只管发事件，不管谁在听
class GraphicEditor {
  private eventBus = new EventBus();
  private sceneGraph = new SceneGraph();

  // 用户拖动节点
  onNodeDrag(nodeId: string, delta: Vector2) {
    this.sceneGraph.moveNode(nodeId, delta);
    // 发出事件 —— 后续逻辑完全由插件处理
    this.eventBus.emit('node:moved', { nodeId, delta, node: this.sceneGraph.get(nodeId) });
  }

  // 用户修改属性
  onPropertyChange(nodeId: string, prop: string, value: any) {
    this.sceneGraph.setProperty(nodeId, prop, value);
    this.eventBus.emit('property:changed', { nodeId, prop, value });
  }
}

// 插件 A：对齐辅助线（监听 node:moved）
class AlignGuidePlugin {
  activate(ctx: PluginContext) {
    ctx.onEvent('node:moved', ({ nodeId, node }) => {
      const guides = this.calculateSnapGuides(node, ctx.getService(ISceneGraph));
      if (guides.length) {
        ctx.getService(IOverlayRenderer).drawGuides(guides);
        ctx.getService(ISceneGraph).snapNode(nodeId, guides[0].snapPosition);
      }
    });
  }
}

// 插件 B：设计规范检查（监听 property:changed）
class DesignLintPlugin {
  activate(ctx: PluginContext) {
    ctx.onEvent('property:changed', ({ nodeId, prop, value }) => {
      const violations = this.checkDesignTokens(prop, value);
      if (violations.length) {
        ctx.getService(INotification).warn(`节点 ${nodeId} 不符合设计规范`, violations);
      }
    });
  }
}

// 插件 C：自动保存（监听所有变更类事件）
class AutoSavePlugin {
  activate(ctx: PluginContext) {
    const debounced = debounce(() => this.save(ctx), 2000);
    ctx.onEvent('node:*', debounced);       // 通配符监听所有 node 事件
    ctx.onEvent('property:*', debounced);
  }
}
```

**事件驱动的插件分层模型：**

```
事件层级             谁产生                   谁消费（插件）
─────────────────────────────────────────────────────────────
L0: 原始输入事件      浏览器/OS                 快捷键插件、手势插件
    mouse, keyboard, touch

L1: 语义化交互事件    核心交互层                工具插件、选择插件
    select, drag, resize, rotate

L2: 模型变更事件      Scene Graph / 状态管理     对齐插件、规范检查
    node:added, style:changed

L3: 生命周期事件      应用 Shell                自动保存、分析统计
    document:opened, export:completed

关键设计：插件应该监听 L1-L3 级事件，不要直接处理 L0 原始事件
```

### 2.4 微内核架构（Microkernel）

详见 [3.1 微内核架构详解](#31-微内核架构详解)。这里强调应用层视角。

**微内核的应用层判断标准：**

```
你的应用适合微内核吗？

✅ 核心功能可以精简到 5 个以内的模块
   → IDE: 文本缓冲区 + 渲染 + 文件系统 + 进程管理 + 扩展点调度
   → 浏览器: 渲染引擎 + JS 引擎 + 网络 + 存储 + 扩展点调度

✅ 90% 的用户只用 20% 的功能
   → 不同用户的功能组合完全不同，不可能预装所有功能

✅ 存在第三方生态诉求
   → 你希望社区贡献功能，而不是全部自己写

❌ 功能之间深度耦合，无法拆分
❌ 性能要求极高，不能有间接调用开销
❌ 用户量小，不值得投入插件基础设施
```

### 2.5 分层架构 + 扩展层（Layered + Extension）

传统分层架构本身不适合插件，但**在层与层之间插入扩展层**就变成了强大的插件载体。

```
传统分层（不适合插件）              加入扩展层（适合插件）
┌──────────────┐                  ┌──────────────────────────┐
│ Presentation │                  │ Presentation              │
├──────────────┤                  ├────────┬─────────────────┤
│ Business     │       ──▶       │ Core   │ ★ Extension     │
│ Logic        │                  │ Logic  │   Layer          │
├──────────────┤                  │        │  ┌────────────┐ │
│ Data Access  │                  │        │  │ Plugin API │ │
├──────────────┤                  │        │  │ Registry   │ │
│ Database     │                  │        │  │ Lifecycle  │ │
└──────────────┘                  │        │  └────────────┘ │
                                  ├────────┴─────────────────┤
                                  │ Data Access               │
                                  ├──────────────────────────┤
                                  │ Database                  │
                                  └──────────────────────────┘
```

**CMS/低代码平台 —— 典型的分层 + 扩展层：**

```typescript
// WordPress 的 Hook 系统就是在分层架构中插入的扩展层
// 核心请求处理流程
class RequestPipeline {
  async handle(request: Request): Promise<Response> {
    // L1: 路由层 —— 扩展点：自定义路由
    const route = await applyFilters('route:resolve', defaultResolver(request));

    // L2: 权限层 —— 扩展点：自定义权限检查
    const allowed = await applyFilters('auth:check', defaultAuth(request));
    if (!allowed) return new Response(403);

    // L3: 业务层 —— 扩展点：自定义数据处理
    const data = await applyFilters('content:prepare', loadContent(route));

    // L4: 渲染层 —— 扩展点：自定义渲染
    const html = await applyFilters('render:output', defaultRender(data));

    return new Response(html);
  }
}

// 插件在任意层间注入逻辑
// SEO 插件 —— 在渲染层注入 meta 标签
addFilter('render:output', (html) => injectMetaTags(html, seoConfig));

// 缓存插件 —— 在路由层短路请求
addFilter('route:resolve', (route) => {
  const cached = cache.get(route.path);
  if (cached) return { ...route, cached: true, content: cached };
  return route;
});

// 会员插件 —— 在权限层增加付费检查
addFilter('auth:check', (result, request) => {
  if (isPremiumContent(request.path) && !isSubscriber(request.user)) return false;
  return result;
});
```

### 2.6 组件化架构（Component-Based）

**UI 密集型应用的插件方案** —— 组件即插件。

```
┌───────────────────────────────────────────────────────────┐
│                    Component-Based Plugin                   │
│                                                            │
│  核心 Shell 定义布局骨架                                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  <AppShell>                                         │   │
│  │    <Slot name="header">                             │   │
│  │      ← 核心组件 + 插件组件混合渲染                    │   │
│  │    </Slot>                                          │   │
│  │    <Slot name="sidebar">                            │   │
│  │      ← 每个插件贡献一个面板组件                       │   │
│  │    </Slot>                                          │   │
│  │    <Slot name="main">                               │   │
│  │      <Canvas />      ← 核心组件                      │   │
│  │      <PluginOverlay>  ← 插件覆盖层                   │   │
│  │        ← 插件可以渲染任意 UI 覆盖在画布上              │   │
│  │      </PluginOverlay>                                │   │
│  │    </Slot>                                          │   │
│  │    <Slot name="panel">                              │   │
│  │      ← 属性面板，核心 + 插件贡献的属性 section         │   │
│  │    </Slot>                                          │   │
│  │  </AppShell>                                        │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
│  插件注册自己的组件到对应 Slot                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ registry.registerComponent('sidebar', {             │   │
│  │   id: 'plugin:layer-manager',                       │   │
│  │   component: LayerManagerPanel,  // React/Vue 组件   │   │
│  │   icon: 'layers',                                   │   │
│  │   order: 10,                                        │   │
│  │ });                                                 │   │
│  └─────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────┘
```

**低代码平台的组件化插件：**

```typescript
// 低代码平台 —— 每个组件类型就是一个"插件"
interface ComponentPlugin {
  // 元信息
  type: string;           // 'custom:chart-advanced'
  category: string;       // '图表'
  icon: string;
  label: string;

  // 渲染器 —— 运行时渲染组件
  render: ComponentType<{ props: Record<string, any>; data: any }>;

  // 属性面板 —— 配置组件的 UI
  propertyPanel: ComponentType<{ value: Record<string, any>; onChange: Function }>;

  // Schema —— 组件接受的属性定义
  propsSchema: JSONSchema;

  // 数据绑定 —— 组件如何消费数据源
  dataBinding?: {
    accepts: ('rest-api' | 'graphql' | 'static')[];
    transform?: (raw: any) => any;
  };
}

// 注册自定义图表组件插件
registry.registerComponent({
  type: 'custom:funnel-chart',
  category: '图表',
  icon: 'funnel',
  label: '漏斗图',
  render: FunnelChartComponent,
  propertyPanel: FunnelChartConfig,
  propsSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', default: '转化漏斗' },
      colors: { type: 'array', items: { type: 'string' } },
      showPercentage: { type: 'boolean', default: true },
    }
  },
  dataBinding: { accepts: ['rest-api', 'static'] }
});
```

### 2.7 中间件链架构（Middleware Chain）

**Web 框架 / API 网关的插件本质就是中间件。**

```
请求 ──▶ [Auth MW] ──▶ [Logger MW] ──▶ [RateLimit MW] ──▶ [Handler] ──▶ 响应
           ↑               ↑               ↑
         内置中间件      ★ 插件中间件      ★ 插件中间件

洋葱模型：
               ┌─── Auth ───────────────────────────┐
               │ ┌─── Logger ─────────────────────┐ │
               │ │ ┌─── RateLimit ──────────────┐ │ │
               │ │ │ ┌─── ★ Plugin MW ────────┐ │ │ │
     request ──┼─┼─┼─┼──▶  Handler  ──▶ resp ─┼─┼─┼─┼──▶ response
               │ │ │ └─────────────────────────┘ │ │ │
               │ │ └─────────────────────────────┘ │ │
               │ └─────────────────────────────────┘ │
               └─────────────────────────────────────┘
```

```typescript
// Express/Koa 风格 —— 中间件即插件
type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void>;

// 插件注册中间件
class APIGateway {
  private middlewares: Middleware[] = [];

  // 插件通过 use 注入自己的处理逻辑
  use(middleware: Middleware, options?: { before?: string; after?: string }) {
    if (options?.before) {
      const idx = this.middlewares.findIndex(m => m.name === options.before);
      this.middlewares.splice(idx, 0, middleware);
    } else {
      this.middlewares.push(middleware);
    }
  }

  async handle(ctx: Context) {
    const chain = this.compose(this.middlewares);
    await chain(ctx);
  }
}

// 认证插件
const authPlugin: Middleware = async (ctx, next) => {
  const token = ctx.headers.authorization;
  if (!token) { ctx.status = 401; return; }
  ctx.user = await verify(token);
  await next();  // 传递给下游
  // next() 返回后，可以修改响应（洋葱模型）
  ctx.set('X-Auth-User', ctx.user.id);
};

// 缓存插件 —— 可以短路后续中间件
const cachePlugin: Middleware = async (ctx, next) => {
  const cached = await redis.get(ctx.url);
  if (cached) { ctx.body = cached; return; }  // 短路！不调用 next()
  await next();
  await redis.set(ctx.url, ctx.body, 'EX', 300);
};
```

### 2.8 应用场景选型决策

**从你要做的应用出发，选择架构：**

```
你在做什么应用？
│
├─ 数据处理型（视频/音频/图像/文档转换）
│  └─▶ 管道-过滤器
│      特点：数据流经 N 个处理环节，每个环节可替换
│      插件形态：Filter（输入→处理→输出）
│      例：视频编辑器特效链、Webpack loader 链、图像处理 pipeline
│
├─ 交互密集型（编辑器/画板/协作工具）
│  └─▶ 事件驱动 + 组件化
│      特点：用户操作→事件→响应，UI 高度可定制
│      插件形态：事件监听器 + UI 组件
│      例：Figma 插件、Notion 块类型、飞书多维表格
│
├─ 工具平台型（IDE/浏览器/操作系统）
│  └─▶ 微内核
│      特点：核心极小，功能完全由插件提供
│      插件形态：完整的功能模块
│      例：VS Code 扩展、Chrome 扩展、Eclipse 插件
│
├─ 内容管理型（CMS/博客/电商后台）
│  └─▶ 分层 + 扩展层
│      特点：业务流程固定，需要在各层注入自定义逻辑
│      插件形态：Hook/Filter（在固定流程中插入逻辑）
│      例：WordPress Hook、Strapi 插件、Shopify App
│
├─ 请求处理型（API 网关/Web 框架/代理）
│  └─▶ 中间件链
│      特点：请求→处理→响应的线性流程
│      插件形态：中间件函数
│      例：Express/Koa 中间件、Nginx 模块、API Gateway
│
└─ 混合型（大型应用）
   └─▶ 微内核 + 事件驱动 + 管道（多模式混合）
       例：VS Code = 微内核(总体) + 事件驱动(编辑器) + 管道(语言处理 LSP)
       例：视频编辑器 = 事件驱动(UI 交互) + 管道(渲染链) + 组件化(属性面板)
```

**实际项目中的混合运用：**

```
┌─────────────────────────────────────────────────────────────────┐
│              图形编辑器 —— 三种模式混合                            │
│                                                                  │
│  ┌──────────────────────────────────┐                           │
│  │ 微内核层                          │  总体架构                  │
│  │ - Plugin Registry                │  管理插件的注册/发现/生命周期│
│  │ - Lifecycle Manager              │                           │
│  │ - Service Locator                │                           │
│  └────────────────┬─────────────────┘                           │
│                   │                                              │
│  ┌────────────────┼─────────────────┐                           │
│  │                ▼                  │                           │
│  │  事件驱动层     ┌──────────────┐  │  用户交互                  │
│  │  - EventBus    │  Canvas 事件  │  │  鼠标/键盘→语义事件→插件响应│
│  │  - Command     │  Model 事件   │  │                           │
│  │    System      │  Selection 事件│  │                           │
│  │                └──────────────┘  │                           │
│  └────────────────┬─────────────────┘                           │
│                   │                                              │
│  ┌────────────────┼─────────────────┐                           │
│  │                ▼                  │                           │
│  │  管道层         渲染管道           │  数据处理                  │
│  │  Scene Graph ──▶ Layout ──▶      │  节点树→布局→渲染→输出      │
│  │  ──▶ [★Plugin Filter] ──▶       │  插件在管道中插入 Filter    │
│  │  ──▶ Composite ──▶ Output        │                           │
│  └────────────────┬─────────────────┘                           │
│                   │                                              │
│  ┌────────────────┼─────────────────┐                           │
│  │                ▼                  │                           │
│  │  组件化层       UI 插槽            │  界面扩展                  │
│  │  - Toolbar Slots                 │  插件注册 UI 组件到插槽     │
│  │  - Sidebar Slots                 │                           │
│  │  - Property Panel Slots          │                           │
│  └──────────────────────────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心架构模式

### 3.1 微内核架构详解

插件系统的本质是**微内核架构**：最小化核心 + 一切皆插件。

```
┌─────────────────────────────────────────────────────────────┐
│                       Application Shell                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    Plugin Host                       │    │
│  │  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │    │
│  │  │Plugin A  │ │Plugin B  │ │Plugin C  │ │Plugin D│  │    │
│  │  │(滤镜)   │ │(导出)    │ │(AI 抠图) │ │(模板)  │  │    │
│  │  └────┬────┘ └────┬─────┘ └────┬─────┘ └───┬────┘  │    │
│  │       │           │            │            │        │    │
│  │  ═════╧═══════════╧════════════╧════════════╧═══     │    │
│  │                    Plugin API Layer                   │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         │                                    │
│  ┌──────────────────────┴──────────────────────────────┐    │
│  │                  Core Kernel                          │    │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐  │    │
│  │  │Registry│ │Lifecycle│ │Event   │ │Extension     │  │    │
│  │  │(注册表)│ │(生命周期)│ │Bus     │ │Point Manager│  │    │
│  │  └────────┘ └────────┘ └────────┘ └──────────────┘  │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**核心原则：**

- **Core Kernel** 只负责：插件注册/发现、生命周期管理、扩展点调度、沙箱隔离
- **一切功能皆插件**：甚至内置功能也以插件形式实现（如 VS Code 的 Git 支持就是内置插件）
- **Plugin API** 是稳定契约：核心与插件之间通过版本化 API 通信

```typescript
// 最小内核接口
interface PluginKernel {
  // 注册
  registry: PluginRegistry;
  // 生命周期
  activate(pluginId: string): Promise<void>;
  deactivate(pluginId: string): Promise<void>;
  // 扩展点
  getExtensionPoint<T>(id: string): ExtensionPoint<T>;
  // 服务
  getService<T>(id: ServiceIdentifier<T>): T;
  // 事件
  eventBus: EventBus;
}
```

### 3.2 生命周期模型

```
          install            resolve          activate
  ┌───┐  ────────▶  ┌───────┐ ──────▶ ┌────────┐ ──────▶ ┌────────┐
  │New│             │Installed│        │Resolved│         │Active  │
  └───┘             └───────┘         └────────┘         └────────┘
                                                             │
                        uninstall          deactivate        │
  ┌──────────┐  ◀────────────  ┌────────┐ ◀──────────────────┘
  │Uninstalled│               │Inactive │
  └──────────┘               └────────┘
```

```typescript
interface Plugin {
  id: string;
  version: string;
  dependencies?: Record<string, string>;  // 依赖其他插件

  // 生命周期钩子
  install?(context: PluginContext): Promise<void>;     // 首次安装
  activate(context: PluginContext): Promise<Disposable>;  // 激活（返回清理器）
  deactivate?(): Promise<void>;                         // 停用
}

// 插件上下文 —— 插件能做什么，全由此约束
interface PluginContext {
  // 注册扩展
  registerCommand(id: string, handler: CommandHandler): Disposable;
  registerMenuItem(location: MenuLocation, item: MenuItem): Disposable;
  registerPanel(descriptor: PanelDescriptor): Disposable;

  // 消费服务
  getService<T>(id: ServiceIdentifier<T>): T;

  // 存储
  storage: PluginStorage;  // 插件私有存储空间

  // 日志
  logger: Logger;

  // 订阅事件
  onEvent<T>(event: string, handler: (data: T) => void): Disposable;
}
```

### 3.3 依赖注入与服务定位

插件间不直接引用，通过**服务定位器**解耦：

```typescript
// 服务标识符（类型安全的 token）
const ICanvasService = createServiceIdentifier<ICanvasService>('ICanvasService');
const IHistoryService = createServiceIdentifier<IHistoryService>('IHistoryService');

// 核心注册默认实现
kernel.registerService(ICanvasService, CanvasServiceImpl);

// 插件可以替换实现（装饰器模式）
class MyPlugin implements Plugin {
  activate(ctx: PluginContext) {
    const original = ctx.getService(ICanvasService);
    ctx.replaceService(ICanvasService, new EnhancedCanvasService(original));
  }
}

// 另一个插件消费服务（不关心谁提供的）
class ExportPlugin implements Plugin {
  activate(ctx: PluginContext) {
    const canvas = ctx.getService(ICanvasService);
    canvas.exportAsPNG();  // 用的可能是增强版
  }
}
```

---

## 4. 扩展点设计

### 4.1 Hook / 拦截器模式

类似 Webpack 的 Tapable —— 在核心流程的关键节点暴露 Hook，插件可以挂载逻辑。

```typescript
// 核心定义 Hook 点
class RenderPipeline {
  hooks = {
    beforeRender:  new AsyncSeriesHook<[RenderContext]>(),
    afterComposite: new AsyncSeriesWaterfallHook<[FrameBuffer]>(),
    beforeExport:  new AsyncSeriesBailHook<[ExportConfig]>(),
  };

  async render(ctx: RenderContext) {
    await this.hooks.beforeRender.call(ctx);         // 插件可修改上下文
    const frame = this.composite(ctx);
    const result = await this.hooks.afterComposite.call(frame); // 插件可变换帧
    return result;
  }
}

// 插件挂载 Hook
class WatermarkPlugin implements Plugin {
  activate(ctx: PluginContext) {
    const pipeline = ctx.getService(IRenderPipeline);
    pipeline.hooks.afterComposite.tap('watermark', (frame) => {
      return this.overlayWatermark(frame);  // 在合成后叠加水印
    });
  }
}
```

**Hook 类型对照：**

| Hook 类型 | 语义 | 类比 |
|-----------|------|------|
| `SyncHook` | 顺序执行，不关心返回值 | Express `app.use()` |
| `SyncWaterfallHook` | 每个插件的返回值传给下一个 | Redux middleware |
| `SyncBailHook` | 任一插件返回非 undefined 则中断 | 事件的 `preventDefault` |
| `AsyncParallelHook` | 并行执行所有插件 | `Promise.all` |
| `AsyncSeriesHook` | 串行异步执行 | Koa middleware |

### 4.2 Contribution Point 声明式扩展

VS Code 发明的模式 —— 插件通过 JSON 声明自己要在哪里贡献内容，而非命令式注册。

```jsonc
// package.json (plugin manifest)
{
  "contributes": {
    // 声明菜单项
    "menus": {
      "editor/context": [
        { "command": "myPlugin.formatSelection", "when": "editorHasSelection" }
      ]
    },
    // 声明配置项
    "configuration": {
      "title": "My Plugin",
      "properties": {
        "myPlugin.autoFormat": { "type": "boolean", "default": true }
      }
    },
    // 声明面板
    "views": {
      "sidebar": [
        { "id": "myPlugin.explorer", "name": "Resource Explorer" }
      ]
    },
    // 声明快捷键
    "keybindings": [
      { "command": "myPlugin.formatSelection", "key": "ctrl+shift+f" }
    ]
  }
}
```

**优势：**

- **懒加载**：声明可以在不激活插件的情况下解析，减少启动开销
- **可静态分析**：IDE 可以检查冲突、补全、验证
- **跨语言**：JSON 声明不依赖运行时语言

### 4.3 Slot / 插槽机制

面向 UI 的扩展模式 —— 核心 UI 预留插槽位置，插件填充内容。

```typescript
// 核心定义插槽
const TOOLBAR_LEFT = createSlot<ToolbarItem>('toolbar.left');
const PROPERTY_PANEL = createSlot<PropertySection>('property.panel');
const CANVAS_OVERLAY = createSlot<CanvasLayer>('canvas.overlay');

// 插件注册到插槽
class RulerPlugin implements Plugin {
  activate(ctx: PluginContext) {
    ctx.contributeToSlot(TOOLBAR_LEFT, {
      id: 'ruler-toggle',
      icon: 'ruler',
      tooltip: '标尺',
      onClick: () => this.toggleRuler(),
      order: 100,  // 排序权重
    });

    ctx.contributeToSlot(CANVAS_OVERLAY, {
      id: 'ruler-overlay',
      render: (canvasCtx) => this.drawRuler(canvasCtx),
      zIndex: 1000,
    });
  }
}
```

```
┌──────────────────────────────────────────────────────┐
│ Toolbar: [Slot:toolbar.left] [Core Tools] [Slot:toolbar.right] │
├──────────┬───────────────────────────────────────────┤
│          │                                           │
│ [Slot:   │            Canvas                         │
│  sidebar]│     ┌───────────────────┐                │
│          │     │ [Slot:canvas.overlay]               │
│  ▪ Layers│     │  - ruler-overlay   │                │
│  ▪ Assets│     │  - grid-overlay    │                │
│  ▪ ★ My  │     └───────────────────┘                │
│   Plugin │                                           │
│          ├───────────────────────────────────────────┤
│          │ [Slot:property.panel]                     │
│          │  ▪ Transform  ▪ Fill  ▪ ★ Plugin Section  │
└──────────┴───────────────────────────────────────────┘
```

---

## 5. 通信与隔离

### 5.1 进程隔离（VS Code 模型）

VS Code 将所有第三方插件运行在独立的 **Extension Host** 进程中：

```
┌──────────────┐         IPC          ┌──────────────────────┐
│  Main Process│ ◀══════════════════▶ │  Extension Host      │
│  (Electron)  │   JSON-RPC over     │  (Node.js Process)   │
│              │   stdin/stdout       │                      │
│  - UI 渲染   │                     │  - Plugin A          │
│  - 文件系统  │                     │  - Plugin B          │
│  - 窗口管理  │                     │  - Plugin C          │
└──────────────┘                     └──────────────────────┘
                                              │
                                     ┌────────┴────────┐
                                     │  Web Worker      │
                                     │  (CPU 密集插件)  │
                                     └─────────────────┘
```

**关键设计：**

- 插件崩溃不影响主进程（UI 不卡死）
- 所有 API 调用通过 IPC 代理，核心可以限流/拦截
- 文件系统、网络等敏感操作由主进程代理执行

### 5.2 沙箱隔离（iframe / Worker / Wasm）

浏览器端插件系统的三种隔离策略：

```
┌─────────────────────────────────────────────────────────┐
│                     隔离策略对比                          │
├─────────────┬──────────────┬─────────────┬──────────────┤
│             │  iframe      │  Worker     │  Wasm        │
├─────────────┼──────────────┼─────────────┼──────────────┤
│ DOM 访问    │ 自己的 DOM   │ 无 DOM      │ 无 DOM       │
│ 主线程阻塞  │ 否(跨源时)   │ 否          │ 是(除非Worker)│
│ 内存隔离    │ 完全隔离     │ 独立堆      │ 线性内存隔离  │
│ 通信方式    │ postMessage  │ postMessage │ 函数调用/共享 │
│ 性能开销    │ 高(独立渲染) │ 中          │ 低(近原生)    │
│ 安全等级    │ 最高         │ 高          │ 中           │
│ 代表产品    │ Figma 插件   │ Shopify     │ 视频特效引擎  │
└─────────────┴──────────────┴─────────────┴──────────────┘
```

**Figma 的 iframe 沙箱方案：**

```typescript
// 主线程侧 —— Plugin Host
class FigmaPluginHost {
  private iframe: HTMLIFrameElement;
  private api: ProxyAPI;

  loadPlugin(code: string) {
    // 创建跨源 iframe（null origin，完全隔离）
    this.iframe = document.createElement('iframe');
    this.iframe.sandbox.add('allow-scripts');  // 仅允许脚本，禁止其他
    this.iframe.srcdoc = `
      <script>
        // 注入受限 API
        const figma = new Proxy({}, {
          get(_, prop) {
            return (...args) => {
              parent.postMessage({ type: 'api-call', method: prop, args }, '*');
              // 等待响应...
            };
          }
        });
        ${code}
      </script>
    `;
    document.body.appendChild(this.iframe);
  }

  // 处理插件的 API 调用请求
  handleMessage(event: MessageEvent) {
    if (event.data.type === 'api-call') {
      const { method, args } = event.data;
      // 权限检查 + 执行 + 返回结果
      const result = this.api[method](...args);
      this.iframe.contentWindow.postMessage({ type: 'api-response', result }, '*');
    }
  }
}
```

### 5.3 事件总线与消息协议

插件间通信的标准化协议：

```typescript
// 类型安全的事件定义
interface EventMap {
  'document:changed':   { nodeId: string; changes: Change[] };
  'selection:changed':  { selectedIds: string[] };
  'export:started':     { format: string; quality: number };
  'export:progress':    { percent: number };
  'export:completed':   { blob: Blob };
}

// 事件总线实现
class TypedEventBus {
  private listeners = new Map<string, Set<Function>>();

  on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): Disposable {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return { dispose: () => this.listeners.get(event)?.delete(handler) };
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.listeners.get(event)?.forEach(handler => {
      try { handler(data); }
      catch (e) { console.error(`Plugin event handler error:`, e); }
    });
  }
}
```

**跨进程消息协议（JSON-RPC 风格）：**

```typescript
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "canvas.addNode", "params": { "type": "rect", "x": 100, "y": 200 } }

// Response
{ "jsonrpc": "2.0", "id": 1, "result": { "nodeId": "node-42" } }

// Notification (单向，无 id)
{ "jsonrpc": "2.0", "method": "selection.changed", "params": { "selectedIds": ["node-42"] } }
```

---

## 6. 典型应用实例

### 6.1 图形编辑器插件系统（Figma 模型）

```
┌────────────────────────────────────────────────────────────┐
│                    Figma Plugin Architecture                │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                    Plugin (iframe sandbox)            │  │
│  │                                                      │  │
│  │  ┌──────────┐        ┌──────────────┐               │  │
│  │  │ UI Layer │        │ Logic Layer  │               │  │
│  │  │ (HTML/CSS)│        │ (figma API)  │               │  │
│  │  └──────────┘        └──────┬───────┘               │  │
│  └─────────────────────────────┼────────────────────────┘  │
│                                │ postMessage                │
│  ┌─────────────────────────────┼────────────────────────┐  │
│  │                    Plugin API Proxy                   │  │
│  │  ┌──────────────────┐ ┌──────────────────────────┐   │  │
│  │  │ Scene Graph API  │ │ Constraint Checker       │   │  │
│  │  │ - createNode()   │ │ - 权限白名单             │   │  │
│  │  │ - findAll()      │ │ - 速率限制               │   │  │
│  │  │ - exportAsync()  │ │ - 操作审计               │   │  │
│  │  └──────────────────┘ └──────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                 Core Engine (C++/Wasm)                │  │
│  │  Scene Graph │ Renderer │ Constraint Solver │ History │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

**插件 Manifest：**

```jsonc
{
  "name": "Design Lint",
  "id": "com.example.design-lint",
  "api": "1.0.0",
  "main": "code.js",        // 逻辑入口（在 sandbox 中运行）
  "ui": "ui.html",          // 可选 UI
  "permissions": [
    "currentPage",          // 访问当前页面节点
    "activeDocument",       // 访问文档
    "createShapes"          // 创建图形
  ],
  "menu": [
    { "name": "Run Lint Check", "command": "lint-check" },
    { "name": "Fix All Issues", "command": "lint-fix" }
  ]
}
```

**典型插件能力矩阵：**

| 插件类型 | 输入 | 处理 | 输出 |
|---------|------|------|------|
| 设计检查 | 遍历节点树 | 规则匹配 | 标注问题 + 自动修复 |
| 批量替换 | 选中节点 | 文本/颜色替换 | 修改节点属性 |
| 资源导入 | 外部文件/API | 解析转换 | 创建节点 |
| 代码生成 | 遍历节点树 | AST 转换 | 输出代码文件 |
| AI 生成 | 用户描述 | 调用 AI API | 创建矢量图形 |

### 6.2 视频编辑器特效扩展

视频编辑器的插件系统面临**实时性约束** —— 16ms 内必须完成一帧处理。

```
┌──────────────────────────────────────────────────────────┐
│                Video Editor Plugin System                  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                 Effect Plugin Types                  │  │
│  │                                                     │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌──────────────┐  │  │
│  │  │ WebGL Shader│ │ Wasm Module │ │ JS Function  │  │  │
│  │  │             │ │             │ │              │  │  │
│  │  │ GPU 特效    │ │ CPU 密集    │ │ 轻量处理     │  │  │
│  │  │ - 色彩校正  │ │ - 视频稳定  │ │ - 元数据处理 │  │  │
│  │  │ - 模糊/锐化 │ │ - 人脸检测  │ │ - 字幕解析   │  │  │
│  │  │ - 转场混合  │ │ - 音频分析  │ │ - 配置变换   │  │  │
│  │  │ - 色键抠像  │ │ - AI 超分   │ │ - 项目迁移   │  │  │
│  │  └──────┬──────┘ └──────┬──────┘ └──────┬───────┘  │  │
│  │         │               │               │           │  │
│  │  ═══════╧═══════════════╧═══════════════╧════════   │  │
│  │              Standard Effect Interface               │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────┴──────────────────────────────┐  │
│  │              Render Pipeline Integration             │  │
│  │  decode → [pre-process] → composite → [post] → encode│  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

**统一特效接口：**

```typescript
// 所有特效类型都遵循此接口
interface EffectPlugin {
  // 描述
  manifest: EffectManifest;

  // 初始化（加载 shader / wasm module）
  init(gl?: WebGL2RenderingContext): Promise<void>;

  // 核心处理方法 —— 必须在 16ms 内返回
  process(input: EffectInput): EffectOutput;

  // 释放资源
  dispose(): void;
}

interface EffectManifest {
  id: string;
  name: string;
  type: 'webgl-shader' | 'wasm-module' | 'js-function';
  supports: ('video' | 'image' | 'audio')[];
  keyframeable: boolean;
  params: ParamDescriptor[];
}

interface ParamDescriptor {
  key: string;
  type: 'float' | 'int' | 'color' | 'enum' | 'boolean';
  default: any;
  min?: number;
  max?: number;
  options?: string[];  // for enum
  label: string;
}
```

**WebGL Shader 特效标准化：**

```glsl
// 引擎注入的 uniform（插件不需要声明）
uniform sampler2D u_inputTexture;   // 输入帧
uniform vec2      u_resolution;     // 画布尺寸
uniform float     u_time;           // 当前时间
uniform float     u_progress;       // 特效进度 [0,1]

// 插件自定义参数（来自 manifest.params）
uniform float u_intensity;
uniform int   u_blockSize;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec4 color = texture2D(u_inputTexture, uv);

  // 插件的特效逻辑
  // ...

  gl_FragColor = color;
}
```

### 6.3 IDE 扩展系统（VS Code 模型）

VS Code 的扩展系统是业界最成功的插件架构之一。

**核心设计决策：**

```
1. 声明式 Contribution Points + 命令式 API 混合
2. Extension Host 进程隔离
3. 按需激活（Activation Events）
4. 语言无关的 LSP/DAP 协议
```

**按需激活机制：**

```jsonc
{
  "activationEvents": [
    "onLanguage:python",              // 打开 Python 文件时激活
    "onCommand:myExt.doSomething",    // 执行命令时激活
    "onView:myExt.sidebar",           // 打开视图时激活
    "onFileSystem:sftp",              // 访问特定文件系统时
    "onStartupFinished"               // 启动完成后（兜底）
  ]
}
```

- 未触发激活事件前，只解析 `package.json` 的声明部分，**不执行任何 JS**
- 1000+ 个扩展装机量，启动时只激活 10-20 个

**Language Server Protocol 的插件解耦：**

```
┌────────────┐  LSP (JSON-RPC)  ┌──────────────────────┐
│ VS Code    │ ◀═══════════════▶│ Python Language      │
│ (Editor)   │                  │ Server (Pylance)     │
│            │  标准化接口：     │                      │
│            │  - completion    │ 可以是任意语言实现    │
│            │  - hover         │ 可以服务任意编辑器    │
│            │  - definition    │                      │
│            │  - diagnostics   │                      │
└────────────┘                  └──────────────────────┘
         ▲                              ▲
         │ 同一个 Language Server        │
         ▼ 也可以服务于                  │
┌────────────┐  LSP              │
│ Neovim     │ ◀═════════════════╝
└────────────┘
```

### 6.4 构建工具插件（Webpack / Vite）

构建工具的插件系统是 **Hook 模式** 的典范。

**Webpack 的 Tapable Hook 体系：**

```typescript
// Compiler 暴露 ~30 个 Hook 点
class Compiler {
  hooks = {
    // 编译生命周期
    beforeRun:    new AsyncSeriesHook(['compiler']),
    run:          new AsyncSeriesHook(['compiler']),
    compile:      new SyncHook(['params']),
    compilation:  new SyncHook(['compilation', 'params']),
    emit:         new AsyncSeriesHook(['compilation']),
    afterEmit:    new AsyncSeriesHook(['compilation']),
    done:         new AsyncSeriesHook(['stats']),
  };
}

// 插件只需实现 apply 方法
class MyPlugin {
  apply(compiler: Compiler) {
    compiler.hooks.emit.tapAsync('MyPlugin', (compilation, callback) => {
      // 在输出文件前做处理
      const assets = compilation.assets;
      // ... 修改/添加/删除资产
      callback();
    });
  }
}
```

**Vite 的 Rollup 兼容插件接口（更简洁）：**

```typescript
function myVitePlugin(): Plugin {
  return {
    name: 'my-plugin',

    // Rollup 标准 Hook（构建阶段）
    resolveId(source) { /* 自定义模块解析 */ },
    load(id) { /* 自定义模块加载 */ },
    transform(code, id) { /* 代码转换 */ },

    // Vite 专属 Hook（开发服务器阶段）
    configureServer(server) { /* 自定义 dev server */ },
    transformIndexHtml(html) { /* 修改 HTML */ },
    handleHotUpdate(ctx) { /* 自定义 HMR */ },
  };
}
```

---

## 7. 安全与性能

### 安全模型

```
┌───────────────────────────────────────────────────────────────┐
│                     安全防护分层                               │
│                                                               │
│  Layer 1: 权限声明                                            │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Manifest 声明所需权限 → 用户审批 → 运行时检查            │  │
│  │ - 文件系统访问范围                                       │  │
│  │ - 网络请求白名单                                        │  │
│  │ - API 调用范围                                          │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  Layer 2: 运行时沙箱                                          │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ iframe(null origin) / Worker / 独立进程                  │  │
│  │ - 无法访问宿主 DOM                                       │  │
│  │ - 无法读取 Cookie / localStorage                         │  │
│  │ - 受限的全局对象（移除 eval、fetch 等）                   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  Layer 3: API 代理层                                          │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 所有 API 调用经过代理 → 权限检查 + 速率限制 + 审计日志   │  │
│  │ - 单次操作节点数上限                                     │  │
│  │ - 每秒 API 调用频率限制                                  │  │
│  │ - 内存/CPU 使用上限                                     │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  Layer 4: 分发审核                                            │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 插件市场审核 → 静态分析 → 运行时监控 → 用户举报          │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

### 性能策略

```typescript
// 1. 懒加载 —— 只在需要时加载插件代码
class LazyPluginLoader {
  private loaded = new Map<string, Plugin>();

  async getPlugin(id: string): Promise<Plugin> {
    if (!this.loaded.has(id)) {
      const module = await import(/* webpackChunkName: "[request]" */ `./plugins/${id}`);
      this.loaded.set(id, module.default);
    }
    return this.loaded.get(id)!;
  }
}

// 2. 超时熔断 —— 插件执行超时则跳过
async function safePluginCall<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fn();
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn('Plugin timed out, skipping');
      return null;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 3. 资源配额 —— 限制插件的内存和 CPU
interface ResourceQuota {
  maxMemoryMB: number;       // 最大内存
  maxCPUTimeMs: number;      // 单次调用最大 CPU 时间
  maxAPICallsPerSec: number; // API 调用频率
  maxNodeOperations: number; // 单次操作最大节点数
}
```

---

## 8. 面试高频问题

### Q1: 如何设计一个图形编辑器的插件系统？

**回答框架：**

1. **微内核架构**：核心只包含画布渲染、节点模型、历史记录；其余功能均通过插件实现
2. **三层扩展点**：
   - Hook 层 —— 渲染管线、节点操作前后的拦截点
   - Contribution 层 —— 菜单、面板、工具栏的声明式扩展
   - Slot 层 —— UI 插槽（侧边栏、属性面板、Canvas 覆盖层）
3. **沙箱隔离**：iframe sandbox（Figma 方案）或 Worker 隔离
4. **通信**：postMessage + JSON-RPC 协议，类型安全的事件总线
5. **生命周期**：声明式激活条件，按需加载，超时熔断

### Q2: 插件间如何通信又不产生耦合？

```
三种模式递进：

1. 事件总线（最松耦合）
   Plugin A --emit('data:ready')--> EventBus --notify--> Plugin B
   适用：广播通知，不关心谁在监听

2. 服务定位器（中等耦合）
   Plugin A --registerService(IDataProvider)--> Kernel
   Plugin B --getService(IDataProvider)--> 获取 A 提供的实现
   适用：明确的服务提供/消费关系

3. 扩展点贡献（最结构化）
   Plugin A --contributes: { "dataProviders": [...] }--> Kernel
   Plugin B --reads extension point 'dataProviders'--> 获取所有贡献者
   适用：多对一聚合（如 N 个语言插件都贡献语法高亮规则）
```

### Q3: 如何保证插件不拖慢主应用？

| 策略 | 机制 | 实例 |
|------|------|------|
| **懒激活** | 声明 activationEvents，用到时才加载 | VS Code 1000 扩展秒启动 |
| **进程隔离** | 独立进程/Worker 运行插件代码 | VS Code Extension Host |
| **超时熔断** | 插件调用超过阈值自动中断 | `Promise.race([fn(), timeout])` |
| **资源配额** | 限制内存/CPU/API 调用频率 | Chrome 扩展内存上限 |
| **批量合并** | 高频事件节流/去抖 | 文档变更事件 100ms 合并 |
| **预算调度** | 每帧分配固定时间给插件 | 视频编辑器 16ms 帧预算内分配 2ms 给特效链 |

### Q4: Webpack Plugin 和 Vite Plugin 设计理念有何不同？

```
Webpack: "万物皆 Hook"
├── Tapable 系统暴露 ~200 个 Hook 点
├── 极度灵活，但学习曲线陡峭
├── 插件可以深入编译器内部
└── 适合：需要深度定制编译行为

Vite: "约定优于配置"
├── 基于 Rollup 插件接口（~20 个 Hook）
├── 简洁直观，多数需求用 transform 即可
├── 额外提供少量 Vite 专属 Hook（dev server、HMR）
└── 适合：90% 的常见场景，极致的开发体验
```

### Q5: 从应用层出发，什么架构适合插件系统？

**核心观点：架构中是否存在「稳定的缝隙」决定了能否支持插件。**

```
一句话回答每种架构：

管道-过滤器 → 数据流经 N 个环节，每个环节可替换      → 视频编辑器、构建工具
事件驱动    → 事件是天然扩展点，订阅即插入            → 图形编辑器、协作工具
微内核      → 为插件而生，核心只做调度                → IDE、浏览器
分层+扩展层 → 在固定层间插入 Hook                    → CMS、低代码平台
组件化      → 组件即插件，Slot 即扩展点              → UI 框架、设计系统
中间件链    → 请求链天然可插拔                       → Web 框架、API 网关

实际大型应用 = 多模式混合
  VS Code = 微内核 + 事件驱动 + 管道(LSP)
  图形编辑器 = 事件驱动(交互) + 管道(渲染) + 组件化(UI)
```

### Q6: 设计插件系统时最容易踩的坑？

1. **API 版本兼容** —— 核心升级后旧插件崩溃
   - 解决：语义化版本 + 适配层 + 废弃警告周期

2. **插件间冲突** —— 两个插件修改同一节点
   - 解决：操作排序（priority / order）+ 冲突检测 + 最后写入者胜出策略

3. **内存泄漏** —— 插件注册了事件但没清理
   - 解决：强制 `Disposable` 模式，deactivate 时自动清理所有注册

4. **性能退化** —— 插件数量增长后整体变慢
   - 解决：懒加载 + 配额 + 性能监控面板

5. **安全漏洞** —— 恶意插件窃取数据
   - 解决：沙箱隔离 + 最小权限原则 + 分发审核
