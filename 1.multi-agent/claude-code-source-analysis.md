# Claude Code 源码架构深度分析

> 基于 [claude-code-best/claude-code](https://github.com/claude-code-best/claude-code) 反编译还原项目分析
> 分析日期：2026-04-03

## 一、项目概览

| 项目 | 说明 |
|------|------|
| 仓库 | `claude-code-best/claude-code` |
| 性质 | Anthropic 官方 Claude Code CLI 的反编译/逆向还原版 |
| 运行时 | Bun >= 1.2.0（主要）+ Node.js（兼容） |
| 语言 | TypeScript（严格类型修复） |
| UI 框架 | React + Ink（终端 TUI） |
| 构建 | 自定义 `build.ts`（Bun.build + code splitting，约 450 chunk） |
| 代码质量 | Biome（lint/format）+ knip（死代码检测） |

---

## 二、核心目录结构

```
src/
├── main.tsx                # 主程序入口
├── QueryEngine.ts          # 核心查询引擎（会话管理）
├── query.ts                # 查询主循环（与 LLM API 交互）
├── Tool.ts                 # 工具接口定义（所有工具的基础类型）
├── tools.ts                # 工具注册表（assembleToolPool）
├── context.ts              # 系统/用户上下文获取（Git 状态、CLAUDE.md）
├── commands.ts             # 斜杠命令注册
│
├── entrypoints/            # 多入口
│   ├── cli.tsx             # CLI 主入口（Bootstrap 分发器）
│   ├── init.ts             # 初始化逻辑（配置、遥测、认证）
│   ├── mcp.ts              # MCP 服务入口
│   └── sdk/                # SDK 集成入口
│
├── tools/                  # 50+ 工具实现
│   ├── AgentTool/          # 子 Agent 编排工具（核心）
│   ├── BashTool/           # Bash 命令执行
│   ├── FileReadTool/       # 文件读取
│   ├── FileEditTool/       # 文件编辑
│   ├── FileWriteTool/      # 文件写入
│   ├── GrepTool/           # 文本搜索
│   ├── GlobTool/           # 文件匹配
│   ├── WebFetchTool/       # 网页获取
│   ├── WebSearchTool/      # 网页搜索（Bing）
│   ├── TaskCreateTool/     # 任务创建
│   └── ...                 # 其余 40+ 工具
│
├── tasks/                  # 异步任务系统
│   ├── LocalAgentTask/     # 本地 Agent 任务
│   ├── LocalShellTask/     # 本地 Shell 任务
│   ├── RemoteAgentTask/    # 远程 Agent 任务
│   └── LocalWorkflowTask/ # 工作流任务
│
├── services/               # 服务层
│   ├── api/                # Anthropic API 调用封装
│   ├── mcp/                # MCP 协议客户端
│   ├── analytics/          # 分析/遥测（GrowthBook, Sentry）
│   ├── compact/            # 上下文压缩（Auto Compact）
│   ├── lsp/                # LSP 集成
│   ├── tools/              # 工具执行编排
│   └── oauth/              # OAuth 认证
│
├── screens/                # UI 屏幕
│   ├── REPL.tsx            # 主 REPL 界面
│   └── Doctor.tsx          # 诊断界面
│
├── coordinator/            # 多 Agent 协调器模式
├── bridge/                 # 远程控制桥接
├── daemon/                 # 守护进程管理
└── utils/                  # 工具函数库
```

---

## 三、整体执行流程

```
CLI 入口 (cli.tsx)
    │
    ├─ 快速路径 (--version, daemon, bridge 等)
    │
    └─ 正常路径
         │
    init.ts (配置/认证/遥测初始化)
         │
    main.tsx (CLI 解析 + AppState 构建)
         │
    launchRepl → REPL.tsx (React + Ink 终端 UI)
         │
    用户输入 → QueryEngine.submitMessage()
                    │
               query() 主循环
               ┌─────────────────────┐
               │ LLM API 流式调用      │
               │ tool_use → runTools   │
               │   ├ 并发只读工具       │
               │   └ 串行写入工具       │
               │ 工具结果 → 继续循环    │
               └─────────────────────┘
                    │
              AgentTool → runAgent (子 Agent 递归)
                    │
              MCPTool → MCP 协议服务器
```

---

## 四、Harness 机制详解

### 4.1 消融实验 Harness (Ablation Baseline)

位于 `cli.tsx` 入口，通过 `feature('ABLATION_BASELINE')` 环境变量批量禁用所有高级特性：

```typescript
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of [
    'CLAUDE_CODE_SIMPLE',
    'CLAUDE_CODE_DISABLE_THINKING',
    'DISABLE_INTERLEAVED_THINKING',
    'DISABLE_COMPACT',
    'DISABLE_AUTO_COMPACT',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  ]) {
    process.env[k] ??= '1';
  }
}
```

**用途**：产生"最简基线版本"，用于 A/B 消融实验，科学化评估每个高级特性对 Agent 能力的贡献。

### 4.2 Agent 执行 Harness (`runAgent.ts`)

`src/tools/AgentTool/runAgent.ts`（~973 行）管理子 Agent 完整生命周期：

```typescript
export async function* runAgent({
  agentDefinition,      // Agent 定义（prompt、tools、model 等）
  promptMessages,       // 初始提示消息
  toolUseContext,       // 工具使用上下文
  canUseTool,           // 权限检查函数
  isAsync,              // 是否异步运行
  availableTools,       // 可用工具池
}): AsyncGenerator<Message, void>
```

执行步骤：
1. 克隆文件状态缓存、注册 Perfetto Tracing
2. `initializeAgentMcpServers()` 启动 Agent 专属 MCP 服务器
3. 构建消息上下文，过滤不完整工具调用
4. 调用 `query()` 运行 LLM 推理循环
5. 记录 Transcript 到 `subagents/` 子目录
6. 清理资源（MCP 连接、Shell 任务、Perfetto 追踪）

### 4.3 会话 Harness (`QueryEngine`)

SDK/Headless 模式的会话级封装：

```typescript
export class QueryEngine {
  private mutableMessages: Message[]       // 会话消息历史
  private abortController: AbortController
  private totalUsage: NonNullableUsage     // 累积 Token 使用量

  async *submitMessage(prompt, options): AsyncGenerator<SDKMessage, void> {
    // 权限包装 → 系统提示获取 → query() 调用 → 状态更新
  }
}
```

---

## 五、核心工程模式

### 5.1 AsyncGenerator 全链路流式架构

从 API 到 UI 全部使用 `AsyncGenerator`，实现端到端流式处理：

```typescript
// query.ts - 主循环
export async function* query(params): AsyncGenerator<Message, void> {
  // API 流式响应 → yield 每个消息块
  // 工具调用 → yield* runTools()   (也是 generator)
  // 子 Agent → yield* runAgent()  (递归 generator)
}
```

**优势**：
- Generator 链式组合，避免回调地狱
- 天然支持背压（backpressure）
- 支持提前终止（AbortController）

### 5.2 工具编排的并发/串行分区

`toolOrchestration.ts` 中的 `partitionToolCalls()` 自动将工具调用分批：

```typescript
export async function* runTools(toolUseMessages, ...): AsyncGenerator<MessageUpdate, void> {
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(...)) {
    if (isConcurrencySafe) {
      // 并发执行只读工具（最多 10 个）
    } else {
      // 串行执行写入/破坏性工具
    }
  }
}
```

每个工具通过声明式方法标记自身属性：

| 方法 | 作用 | 示例 |
|------|------|------|
| `isConcurrencySafe()` | 是否可并发执行 | Grep → true, Edit → false |
| `isReadOnly()` | 是否只读 | Read → true, Write → false |
| `isDestructive()` | 是否破坏性操作 | Bash `rm` → true |

### 5.3 Feature Flag + DCE (Dead Code Elimination)

利用 Bun 的 `feature()` API 实现**编译期特性开关**：

```typescript
import { feature } from 'bun:bundle'

// 构建时 FEATURE_REACTIVE_COMPACT=0 → 整个代码块被删除
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? require('./services/compact/reactiveCompact.js')
  : null
```

构建脚本自动收集环境变量：

```typescript
// build.ts
const features = Object.keys(process.env)
    .filter(k => k.startsWith("FEATURE_"))
    .map(k => k.replace("FEATURE_", ""))

const result = await Bun.build({
    entrypoints: ["src/entrypoints/cli.tsx"],
    features,
    splitting: true,  // Code splitting
})
```

**优势**：Feature Flag 零运行时开销，未启用的功能代码完全不会出现在产物中。

### 5.4 完备的 Tool 类型系统

`Tool<Input, Output, Progress>` 泛型接口：

```typescript
type Tool = {
  name: string
  inputSchema: z.ZodType              // Zod 校验输入
  outputSchema?: z.ZodType            // 可选输出校验
  call(args, context, ...): Promise<ToolResult<Output>>
  description(input, options): Promise<string>
  checkPermissions(input, context): Promise<PermissionResult>
  isConcurrencySafe(input): boolean   // 并发安全标记
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  validateInput?(input, context): Promise<ValidationResult>
  renderToolResultMessage?(...): React.ReactNode  // 终端 UI 渲染
  mapToolResultToToolResultBlockParam(...): ToolResultBlockParam
  userFacingName(input): string
}
```

**设计理念**：通过接口约束，强制每个工具声明自身安全属性，让编排层自动做出正确的并发/串行决策。

### 5.5 三层权限模型

```
┌─────────────────────────────────────────┐
│ Layer 1: PermissionMode                  │
│   default / plan / bypass                │
│   Plan Mode 自动降权（禁止写入工具）       │
├─────────────────────────────────────────┤
│ Layer 2: canUseTool                      │
│   每次工具调用前的动态权限检查函数          │
├─────────────────────────────────────────┤
│ Layer 3: 规则集                          │
│   alwaysAllowRules                       │
│   alwaysDenyRules                        │
│   alwaysAskRules                         │
└─────────────────────────────────────────┘
```

### 5.6 上下文压缩 (Auto Compact)

`src/services/compact/` 在接近 context window 限制时自动触发：
- 用 LLM 总结历史消息
- 保留关键上下文信息
- 使对话可以无限延续
- 通过 `DISABLE_AUTO_COMPACT` 环境变量可禁用

### 5.7 MCP 协议深度集成

- Agent 可以在 frontmatter 中声明专属 MCP 服务器
- 子 Agent 启动时动态连接，结束时自动清理
- 支持引用已有服务器或内联定义新服务器
- `initializeAgentMcpServers()` 管理完整生命周期

---

## 六、关键技术栈

| 技术 | 选择理由 |
|------|----------|
| **Bun** | 极快启动 + 原生 TS + Bun.build code splitting |
| **React + Ink** | 声明式终端 UI，组件化复用 |
| **Zod** | 运行时 schema 校验，与 LLM tool_use 天然契合 |
| **AsyncGenerator** | 流式管道，替代 EventEmitter |
| **GrowthBook** | 开源 A/B 测试，可自建 Feature Gate 平台 |
| **Perfetto Tracing** | Chrome 级性能追踪，可视化 Agent 执行链 |
| **Commander.js** | CLI 参数解析 |
| **@anthropic-ai/sdk** | Anthropic API 通信 |
| **@modelcontextprotocol/sdk** | MCP 协议客户端 |
| **Sentry** | 错误监控 |
| **OpenTelemetry** | 分布式遥测 |

---

## 七、核心学习要点总结

### 1. 声明式工具元数据驱动编排

工具不关心自己何时、如何被调度，只需通过接口声明自身属性（并发安全、只读、破坏性），编排层据此自动做出正确决策。

> **启发**：设计 Agent 工具系统时，让工具"自描述"比让编排层"硬编码策略"更可维护、更安全。

### 2. AsyncGenerator 流式管道

整条链路 `API → query() → runTools() → runAgent()` 全部是 Generator，数据逐块流动，无需缓冲完整响应。

> **启发**：构建 LLM 应用时，Generator/Iterator 模式比 Callback/EventEmitter 更适合流式处理。

### 3. 编译期 Feature Flag

`feature()` + DCE 实现零运行时开销的特性管理，同时支持消融实验。

> **启发**：Feature Flag 不只是运行时 `if/else`，结合构建工具可以做到完全无开销。

### 4. 分层权限设计

全局模式 → 动态检查 → 规则集，三层叠加既灵活又安全。

> **启发**：Agent 权限不能只有"允许/拒绝"二元选项，需要多层次、多粒度的控制。

### 5. Agent 递归架构

子 Agent 复用整套 `query()` 循环，可无限嵌套。每个子 Agent 有独立的工具池、MCP 服务器、权限范围。

> **启发**：Agent 的组合能力来自递归复用而非特殊处理，保持架构一致性。

### 6. 科学化评估方法

消融实验 Harness 可以精确衡量每个特性（Thinking、Compact、Memory 等）对 Agent 能力的贡献。

> **启发**：构建 AI 产品时，要设计可量化的评估框架，而非仅靠直觉调优。

---

## 八、CCB 对原版的扩展

| 扩展 | 说明 |
|------|------|
| 移除反蒸馏代码 | 清除原版阻止分析的混淆代码 |
| 新增 Web Search | 基于 Bing 搜索 API |
| 自定义 Sentry | 可配置私有错误上报端点 |
| 自定义 GrowthBook | 可自建 Feature Gate 平台 |
| Debug 模式 | 原版未开放 |
| 关闭自动更新 | 适用企业部署场景 |
