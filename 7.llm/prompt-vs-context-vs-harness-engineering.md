# Prompt Engineering / Context Engineering / Harness Engineering

## 一句话区别

- `Prompt engineering`：优化模型“这一轮怎么说”。
- `Context engineering`：优化模型“这一轮看什么”。
- `Harness engineering`：优化整个 Agent 系统“这一轮以及后续流程怎么跑”。

三者在 AI Agent 工程里并不是并列的同一层概念，而是从调用层、上下文层到系统层逐步外扩：

`prompt` < `context` < `harness`

---

## 面向 AI Agent 的工程实践定义

### 1. Prompt engineering

Prompt engineering 关注单次模型调用时的指令设计。它的核心目标是让模型在当前这一次调用中，更稳定地理解任务、遵守边界，并输出符合预期的结果。

常见工作包括：

- 编写 system prompt、task prompt、tool usage prompt
- 明确角色、目标、约束和禁止事项
- 规定输出格式，如 JSON、Markdown、表格、分点结构
- 增加 few-shot 示例，约束风格和格式
- 增加分步推理、先规划后执行、先检查后回答等流程指令

它主要解决的是“模型会不会按你期望的方式表达和行动”的问题，而不是“模型是否看到了对的信息”。

### 2. Context engineering

Context engineering 关注模型在当前调用时到底能看到哪些信息，以及这些信息如何被组织、筛选、压缩和排序。它的核心目标不是把上下文塞得更多，而是让模型看到最相关、最干净、最有行动价值的信息。

常见工作包括：

- 选择要注入的历史消息
- 检索知识库、代码库或外部文档
- 构建 RAG 管道并筛选检索结果
- 将长历史压缩成摘要
- 管理 agent memory、scratchpad、session state
- 控制 token 预算，减少噪音和重复信息
- 给不同子 Agent 提供隔离后的最小必要上下文

它主要解决的是“模型有没有拿到正确输入”的问题。

### 3. Harness engineering

Harness engineering 关注承载模型运行的外层代理系统，也可以理解为 Agent runtime 或 orchestration layer。它负责把模型、工具、状态、流程控制、错误恢复和观测系统装配成一个真正可运行、可维护、可扩展的 Agent。

常见工作包括：

- 设计 agent loop 和执行状态机
- 注册和封装工具，设计工具 schema
- 控制 tool calling、超时、重试和回退
- 进行任务分解、子 Agent 编排和结果汇总
- 设计日志、trace、评测、指标和报警
- 做模型路由、成本控制和速率限制
- 处理权限、sandbox、隔离和资源管理

它主要解决的是“整个系统能不能稳定完成任务”的问题。

---

## 三者分别在 Agent 中负责什么

| 维度 | Prompt engineering | Context engineering | Harness engineering |
|------|--------------------|--------------------|--------------------|
| 关注对象 | 提示词本身 | 模型可见的完整上下文 | 模型外部的运行系统 |
| 解决问题 | 怎么说 | 看什么 | 怎么跑 |
| 作用范围 | 单次调用 | 单次调用的输入构造 | 整个多轮代理流程 |
| 常见产物 | prompt 模板、few-shot、格式约束 | context builder、RAG、memory、summary | orchestrator、tool registry、agent runner |
| 常见失败表现 | 答非所问、格式错、行为不稳定 | 信息缺失、噪音过多、上下文污染 | 死循环、工具失败、状态错乱、不可观测 |

---

## 一个真实 Agent 流程里的分工

假设要做一个“代码库问答 + 自动修复”的 Agent，完整流程可能是：

1. 用户提出问题
2. Agent 检索相关代码和文档
3. Agent 阅读上下文并定位问题
4. Agent 制定修复方案
5. Agent 修改代码
6. Agent 运行测试
7. Agent 总结结果并回复用户

在这个流程里：

### Prompt engineering 在做什么

- 告诉模型先理解问题，再搜索，再阅读，再修改
- 约束输出格式，例如“问题定位 / 原因分析 / 修复建议”
- 要求在证据不足时先调用工具，不要臆测
- 规定回答口吻、粒度、是否需要自检

### Context engineering 在做什么

- 选择最相关的代码片段给模型
- 将用户问题、历史消息、报错日志一起打包
- 对过长历史进行摘要，避免 token 爆炸
- 对不同阶段提供不同上下文，例如修复阶段只给相关文件
- 给子 Agent 隔离上下文，避免互相污染

### Harness engineering 在做什么

- 提供 `search_code`、`read_file`、`apply_patch`、`run_tests` 等工具
- 实现“检索 -> 阅读 -> 修改 -> 验证”的执行循环
- 在工具失败时重试或中断
- 记录每轮调用、耗时、token、成功率
- 在需要时拆出多个子 Agent 并汇总结果

---

## 三者最容易混淆的地方

### 误区 1：效果不好就继续调 prompt

很多 Agent 问题表面看像提示词问题，实际可能是：

- 没检索到正确资料：`context engineering`
- 资料检索到了但排序不对：`context engineering`
- 工具调用不稳定或流程卡死：`harness engineering`
- 历史太长导致关键信息淹没：`context engineering`

只有在流程和上下文都基本正确时，prompt 优化才往往是主要收益来源。

### 误区 2：做了 RAG 就叫 prompt engineering

RAG、memory、history compression、context packing，本质上都更偏 `context engineering`，因为它们决定的是模型看到了什么，而不是你如何措辞。

### 误区 3：有 tools 就已经是 harness engineering

只有定义工具还不够。真正的 harness engineering 还包括：

- 工具调用策略
- 失败恢复机制
- 多轮状态管理
- 任务编排
- 观测和评测
- 权限与资源控制

---

## 工程上最实用的排障顺序

调 Agent 时，建议优先按下面顺序排查：

### 1. 先查 Harness

先确认系统是不是跑对了：

- 是否进入错误流程
- 是否重复调用工具
- 是否缺少超时和重试机制
- 是否在某一步卡住
- 是否存在状态丢失或多 Agent 协作失败

如果运行框架本身不稳定，继续打磨 prompt 往往收益很低。

### 2. 再查 Context

当系统流程基本对时，再检查模型到底看到了什么：

- 是否拿到了最相关的信息
- 是否注入了太多无关内容
- 是否历史过长导致重点丢失
- 是否摘要质量太差
- 是否给了错误的文件、错误的检索结果、错误的日志片段

### 3. 最后查 Prompt

当流程和上下文都基本健康时，再优化提示词本身：

- 指令是否清晰
- 输出格式是否足够明确
- 示例是否足够
- 行为边界是否定义清楚
- 是否存在模糊、冲突或冗余指令

---

## 一个很实用的判断法

当 Agent 表现不好时，可以先问三个问题：

- 模型“不会说”吗？如果是，先看 `prompt engineering`
- 模型“没看到 / 看错了”吗？如果是，先看 `context engineering`
- 模型“不会做 / 流程跑坏了”吗？如果是，先看 `harness engineering`

这个判断法适合在调试、复盘、评审设计方案时快速定位问题层级。

---

## 在项目结构里通常长什么样

在实际工程中，这三层通常会分别落在不同模块里：

### Prompt engineering 常见落点

- `prompts/`
- `templates/`
- `system_prompt.md`
- `task_prompt.ts`
- structured output schema 定义

### Context engineering 常见落点

- `retriever/`
- `memory/`
- `context-builder/`
- `history-summarizer/`
- `reranker/`
- `session-state/`

### Harness engineering 常见落点

- `agent-runner/`
- `orchestrator/`
- `tool-registry/`
- `workflow/`
- `retry-policy/`
- `telemetry/`
- `evaluation/`

---

## 面试或汇报时可直接复用的总结

在 AI Agent 工程实践里，`prompt engineering` 负责约束单次调用的行为和输出，`context engineering` 负责组织模型可见的有效上下文，`harness engineering` 负责把模型、工具、状态机和观测能力装配成一个稳定可运行的代理系统。三者不是同义词，而是从调用层到系统层逐步外扩的不同工程层次。

如果要进一步压缩成一句话：

“Prompt 决定模型怎么说，Context 决定模型看什么，Harness 决定整个 Agent 怎么跑。”
