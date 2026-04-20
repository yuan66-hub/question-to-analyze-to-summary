# 从零搭一个上下文管理系统（实战篇）

## 一句话总结

上下文管理系统不是“把历史消息、RAG 结果、memory、tool output 全部塞进 prompt”这么简单，而是要在每次模型调用前，系统性地回答下面几个问题：

- 这一次调用到底需要看什么
- 哪些信息更重要，哪些应该丢掉
- token 预算应该怎么分配
- 超预算时应该裁剪、摘要，还是延迟加载
- 怎样让 Chat、RAG、Agent 共用一套上下文装配引擎

如果压缩成一句工程表达：

`Context Manager = context selection + context ranking + budget allocation + compression + prompt assembly`

---

## 1. 问题定义

很多团队在做 AI 应用时，一开始都是这样处理上下文的：

1. 把最近几轮聊天历史拼进去
2. 再把检索到的文档拼进去
3. 如果有工具调用结果，也继续拼进去
4. 如果还怕信息不够，再把 memory、profile、policy、few-shot 一起带上

demo 阶段往往还能跑。

但一旦进入真实工程环境，系统很快就会出现几类问题：

- **上下文越来越长，成本越来越高**
- **信息越来越多，但模型反而更容易忽略重点**
- **RAG 命中了文档，但真正相关的片段没有排到前面**
- **工具结果太脏、太长、太结构化，直接污染 prompt**
- **长历史里真正重要的约束被新噪音稀释**
- **不同场景各写一套“拼 prompt”逻辑，最终无法复用**

所以真正要解决的问题并不是：

> “怎么把更多信息传给模型？”

而是：

> **怎么让系统在每一次调用前，给模型准备最少但最有用的上下文。**

这就是上下文管理系统存在的意义。

---

## 2. 为什么不能只靠“历史消息 + 检索结果”硬拼

很多人第一次做 AI 应用时，会直觉把“上下文”理解成：

- 当前用户问题
- 最近几轮对话
- 检索返回的知识片段

这当然是上下文的一部分，但离“可落地的上下文系统”还差很远。因为在真实系统里，模型最终看到的输入往往还包括：

- 系统指令与安全策略
- 用户 profile / tenant 配置
- 当前任务状态
- 长期记忆摘要
- 工具调用结果
- 结构化中间状态
- 工作流阶段信息
- 输出格式约束

也就是说，**上下文不是“聊天记录”，而是模型这一次决策时可见的全部环境。**

如果只靠手写拼接逻辑，通常会遇到 4 个结构性问题。

### 2.1 没有统一选择机制

今天这个接口要带最近 10 轮历史，明天另一个接口只带最近 3 轮，后天 Agent 工具调用又自己拼一段 scratchpad。

最后每个入口都在做自己的“上下文决定”，系统根本没有统一策略。

### 2.2 没有统一预算机制

当输入快超过窗口时，很多系统的处理方式只有两种：

- 最后统一截断
- 粗暴减少历史条数

这会导致真正重要的信息被错误删除。

### 2.3 没有统一优先级机制

不是所有上下文都同等重要：

- system policy 通常比一段旧聊天更重要
- 当前任务状态通常比两天前的聊天更重要
- 高相关文档片段通常比完整工具日志更重要

如果系统不显式表达优先级，最后就会退化成“谁先拼进 prompt，谁就活下来”。

### 2.4 没有统一压缩机制

上下文一长，系统就必须做三选一：

- 裁剪
- 摘要
- 延迟加载

如果没有一层统一的压缩与降级策略，系统只会越来越依赖更大的上下文窗口，而不是更好的上下文设计。

---

## 3. 一个可落地的上下文管理系统，到底要解决什么

一个能在工程里站住的 `Context Manager`，至少要解决 5 件事。

### 3.1 Selection：选什么

系统必须能够从多个来源拉取上下文：

- recent history
- long-term memory
- retrieval results
- tool results
- workflow state
- user profile
- policy / instruction blocks

但不是所有来源每次都要参与。

它必须根据当前场景动态决定：

- 本轮是否需要记忆
- 本轮是否需要检索
- 本轮是否需要带工具状态
- 当前阶段是不是应该减少背景信息、强调行动信息

### 3.2 Ranking：谁更重要

系统不仅要知道“有哪些候选上下文”，还要知道它们的优先级。

常见排序信号包括：

- relevance：和当前问题的相关性
- recency：是否是最近发生的
- authority：是否来自高可信来源
- role importance：system / policy 是否高优先
- task stage：是否符合当前执行阶段
- token efficiency：单位 token 的信息密度

### 3.3 Budgeting：预算怎么分

上下文窗口不是给你“尽量塞满”的，而是给你做资源分配的。

一个成熟系统通常不会等到最后再看总 token，而是提前把预算切成几个槽位，例如：

- system instructions：`15%`
- recent history：`20%`
- retrieved knowledge：`25%`
- tool outputs：`20%`
- memory / profile：`10%`
- reserved output space：`10%`

这类预算分配能避免一个来源把全局挤爆。

### 3.4 Compression：超了怎么办

当某个来源超预算时，系统不能只会“删掉后面的内容”，而应该有层级化处理：

1. 去重
2. 结构化提炼
3. 片段级裁剪
4. 摘要压缩
5. 整体丢弃

这也是上下文系统和“简单拼 prompt”最大的差别之一。

### 3.5 Observability：怎么知道自己做得对

如果系统不能记录下面这些信息，你后面几乎没法优化：

- 本轮用了哪些上下文来源
- 每个来源贡献了多少 token
- 哪些内容被裁掉了
- 哪些内容被摘要了
- 哪些检索结果最终没有进入 prompt
- 最终答案质量和上下文装配策略是否相关

没有这些观测信息，上下文工程很容易停留在拍脑袋阶段。

---

## 4. 总体架构：把“拼 prompt”升级为“上下文装配引擎”

建议把整个系统拆成下面几层：

```text
User Input / Task Trigger
        |
        v
Context Request Builder
        |
        v
Context Sources
  - Recent History Source
  - Memory Source
  - Retrieval Source
  - Tool State Source
  - Profile / Policy Source
        |
        v
Context Ranker
        |
        v
Budget Controller
        |
        v
Context Compressor
        |
        v
Prompt Assembler
        |
        v
LLM Call
        |
        v
Trace / Evaluation / Feedback
```

这套结构的关键思想是：

> **先把“有哪些候选上下文”收集出来，再决定谁留下、谁压缩、谁淘汰，最后才进入 prompt 组装。**

如果你直接让每个模块自己往 prompt 里塞内容，最终一定会失控。

---

## 5. 核心抽象设计

真正把系统做稳，关键不在于用了什么框架，而在于抽象是否干净。

我建议至少定义下面 5 个核心对象。

### 5.1 `ContextRequest`

它描述“这一次调用需要什么上下文”。

```ts
type ContextRequest = {
  requestId: string;
  sessionId: string;
  userId: string;
  taskType: "chat" | "qa" | "agent_plan" | "agent_execute";
  currentQuery: string;
  maxInputTokens: number;
  reservedOutputTokens: number;
  features: {
    enableMemory: boolean;
    enableRetrieval: boolean;
    enableToolContext: boolean;
  };
  metadata: {
    tenantId?: string;
    workflowStage?: string;
    toolName?: string;
  };
};
```

这个对象很重要，因为它把“上下文管理”从一堆隐式 if/else 变成了显式请求。

### 5.2 `ContextItem`

它描述一条候选上下文。

```ts
type ContextItem = {
  id: string;
  source:
    | "system_policy"
    | "recent_history"
    | "memory"
    | "retrieval"
    | "tool_output"
    | "user_profile"
    | "workflow_state";
  content: string;
  rawTokenEstimate: number;
  priority: number;
  relevanceScore?: number;
  recencyScore?: number;
  authorityScore?: number;
  compressible: boolean;
  required: boolean;
  metadata?: Record<string, unknown>;
};
```

它的意义在于：

- 不同来源进入统一表示
- 后续排序、预算、压缩都可以复用同一套流程
- 你可以记录每条内容为什么被选中或被丢弃

### 5.3 `ContextPlan`

它描述最终装配方案，而不是最终 prompt。

```ts
type ContextPlan = {
  requestId: string;
  totalBudget: number;
  reservedOutputTokens: number;
  allocatedBudgets: Record<string, number>;
  selectedItems: ContextItem[];
  droppedItems: Array<{
    itemId: string;
    reason: "low_priority" | "over_budget" | "deduplicated";
  }>;
  compressedItems: Array<{
    itemId: string;
    beforeTokens: number;
    afterTokens: number;
    strategy: "trim" | "summarize" | "extract";
  }>;
};
```

这个对象让你能回答一句非常重要的话：

> “这次上下文为什么长这样？”

### 5.4 `ContextSource`

每一种来源都实现同一接口。

```ts
interface ContextSource {
  name: string;
  collect(request: ContextRequest): Promise<ContextItem[]>;
}
```

比如：

- `RecentHistorySource`
- `MemorySource`
- `RetrievalSource`
- `ToolStateSource`
- `PolicySource`

这能让系统非常容易扩展新来源，而不需要改整条装配链。

### 5.5 `ContextAssembler`

它是总控入口。

```ts
interface ContextAssembler {
  build(request: ContextRequest): Promise<ContextPlan>;
  assemblePrompt(plan: ContextPlan): string;
}
```

它负责把多来源候选内容变成一个最终可执行的 prompt。

---

## 6. 核心模块拆解

从工程角度看，我建议至少拆下面这些模块。

### 6.1 `RecentHistorySource`

职责：

- 从会话存储里取最近 N 轮对话
- 根据角色和轮次筛选
- 去掉无效重复消息

关键点：

- 不能只按“最近 10 条”截取
- 最好保留 turn 级结构，而不是纯字符串拼接
- assistant 的长篇废话有时比 user 的一条需求更不重要

一个更合理的思路是：

- 优先保留最近 user 消息
- 保留最近 1 到 2 条与当前问题强相关的 assistant 回复
- 对更旧历史做摘要

### 6.2 `MemorySource`

职责：

- 提供跨轮次、跨会话可复用的稳定信息

例如：

- 用户偏好
- 长期约束
- 已确认的任务背景
- 过去决策结论

关键点：

- memory 不是“所有旧消息”
- 必须是抽取后的高价值状态
- 最好分成事实型 memory 和偏好型 memory

如果你把所有旧历史都叫 memory，这一层就会失控。

### 6.3 `RetrievalSource`

职责：

- 从知识库、代码库、文档库中检索候选片段

关键点：

- 检索返回的不是“可直接入 prompt 的结果”，只是候选
- 需要后续 rerank
- 需要片段清洗和长度控制

很多 RAG 系统效果不稳，不是 retriever 不行，而是把太多“弱相关长文本”直接喂给模型了。

### 6.4 `ToolStateSource`

职责：

- 提供这次执行链里与当前步骤相关的工具状态和工具结果

例如：

- 上一步工具返回的结构化结果
- 某个外部 API 的摘要响应
- 工作流中间状态

关键点：

- 不要把完整日志原样放进 prompt
- 能结构化就不要大段自然语言化
- 优先传“对当前决策有影响的字段”，不是完整 payload

例如不要直接塞：

```json
{
  "items": [/* 500 行日志 */]
}
```

更好的做法是：

```json
{
  "status": "partial_success",
  "createdCount": 12,
  "failedCount": 2,
  "failedReasons": ["quota_exceeded", "invalid_email"]
}
```

### 6.5 `ContextRanker`

职责：

- 给所有 `ContextItem` 打分并排序

一个常见打分公式可以是：

```text
final_score =
  relevance_weight * relevance +
  recency_weight * recency +
  authority_weight * authority +
  priority_weight * base_priority -
  token_penalty_weight * token_cost
```

这里的重点不在公式多复杂，而在于你终于把“什么更重要”显式化了。

### 6.6 `BudgetController`

职责：

- 为不同来源分配 token 预算
- 控制总输入不超过阈值
- 决定哪些来源先压缩、先牺牲

它的核心价值是把“上下文窗口”从被动限制变成主动资源管理。

### 6.7 `ContextCompressor`

职责：

- 在超预算时做分层压缩

常见策略：

- `trim`: 截掉低优先片段
- `extract`: 提取关键字段
- `summarize`: 生成摘要
- `dedupe`: 去重

不是所有内容都适合摘要：

- policy 通常不应该摘要
- JSON 工具结果更适合提取字段
- 历史聊天更适合生成状态摘要
- 检索片段更适合句段级裁剪

### 6.8 `PromptAssembler`

职责：

- 按稳定顺序把最终内容拼成 prompt

一个常见顺序是：

1. system policy
2. role / task instructions
3. user profile / memory
4. recent history
5. retrieved knowledge
6. tool state
7. current user query
8. output format instructions

顺序本身就是一种隐式优先级表达，不能随便改。

---

## 7. 一次完整请求到底是怎么装配出来的

下面用一个通用场景来走一遍。

假设用户提问：

> “帮我总结一下上周客户投诉的主要原因，并给出处理建议。”

这时系统可能做下面这些事情。

### 7.1 建立 `ContextRequest`

系统先识别任务类型：

- 这是一个分析型请求
- 需要读取历史会话上下文
- 可能需要查知识库
- 可能需要读取最近的数据分析工具结果

于是生成：

```ts
const request: ContextRequest = {
  requestId: "req_123",
  sessionId: "sess_456",
  userId: "user_789",
  taskType: "qa",
  currentQuery: "帮我总结一下上周客户投诉的主要原因，并给出处理建议。",
  maxInputTokens: 16000,
  reservedOutputTokens: 2000,
  features: {
    enableMemory: true,
    enableRetrieval: true,
    enableToolContext: true,
  },
  metadata: {
    workflowStage: "analysis",
  },
};
```

### 7.2 拉取候选上下文

各来源分别产出候选项：

- `PolicySource`：回答必须基于证据，不得编造数据
- `RecentHistorySource`：最近几轮对话提到“要按投诉类型归因”
- `MemorySource`：这个用户偏好“先结论后展开”
- `RetrievalSource`：客户服务 SOP、历史投诉标签定义
- `ToolStateSource`：上一轮分析工具输出了“投诉分类统计结果”

注意，这时还没有开始拼 prompt，只是形成候选池。

### 7.3 打分和排序

系统会发现：

- `PolicySource` 是 required，必须保留
- 最近那一轮关于“按投诉类型归因”的 user 指令相关性很高
- 统计工具输出比完整 SOP 更接近当前问题
- 某些历史闲聊虽然很新，但相关性很低

于是闲聊被降权，结构化统计结果被提升。

### 7.4 预算分配

假设本轮可用输入预算是 `14000 tokens`。

系统可以这样切：

```text
policy + instructions: 2000
recent history: 2500
memory + profile: 1000
retrieval docs: 4000
tool outputs: 2500
buffer: 2000
```

这样即使某个来源特别长，也不会把整个 prompt 挤爆。

### 7.5 压缩与降级

如果工具结果有 4000 tokens，但工具槽位预算只有 2500：

- 先去重
- 再删掉原始日志明细
- 再提取关键字段
- 仍超预算时，才做摘要

如果检索结果有 10 个片段，也不是全塞：

- 只保留前 3 到 5 个高相关片段
- 每个片段再截取最相关的段落

### 7.6 组装最终 prompt

最后才会形成类似这种结构：

```text
[System Policy]
[Task Instructions]
[User Preference / Memory]
[Recent Relevant History]
[Retrieved Knowledge]
[Tool Summary]
[Current User Query]
[Output Constraints]
```

到这里，模型看到的不是“所有可能有用的信息”，而是“系统挑选并治理过的信息”。

---

## 8. Token Budget 设计：不是截断，而是预算分配

很多上下文系统失败，不是因为没有 RAG，没有 memory，而是因为没有预算设计。

一个成熟系统通常会同时管理 3 种预算。

### 8.1 全局预算

即本轮输入最多允许多少 token。

它通常由下面几项共同决定：

- 模型上下文窗口上限
- 期望输出长度
- 安全缓冲区

例如：

```text
model window = 128k
reserved output = 8k
safety buffer = 4k
usable input budget = 116k
```

### 8.2 来源预算

即不同上下文来源拥有自己的上限。

例如：

- history 不能超过 20k
- retrieval 不能超过 40k
- tool outputs 不能超过 15k
- memory 不能超过 8k

这是为了防止单个来源独占上下文窗口。

### 8.3 阶段预算

不同任务阶段应该用不同预算配置。

例如在 Agent 系统里：

- planning 阶段更重背景知识和任务约束
- execution 阶段更重工具状态和最近决策
- reflection 阶段更重错误信息和中间轨迹

如果所有阶段都用同一套上下文模板，系统会越来越臃肿。

---

## 9. 历史消息、Memory、RAG、Tool Result 应该怎么共存

这是实战里最容易混乱的地方。

可以把它们理解成四种完全不同的上下文来源。

### 9.1 History：描述“刚刚发生了什么”

它主要解决连续多轮理解问题。

适合保留：

- 最近用户意图
- 最近 assistant 承诺
- 当前任务上下文

不适合长期累积。

### 9.2 Memory：描述“长期成立的状态”

它主要解决跨轮次稳定信息复用问题。

适合保留：

- 用户长期偏好
- 已确认的背景设定
- 反复出现的约束

它不应该等价于“旧聊天摘要大全”。

### 9.3 Retrieval：描述“外部知识”

它主要解决模型本身不知道，或者当前窗口里没有的信息。

适合装载：

- 文档片段
- 代码片段
- FAQ / SOP
- 结构化知识片段

它的重点是相关性，不是完整性。

### 9.4 Tool Result：描述“系统刚执行了什么”

它主要解决多步流程中的状态连续性问题。

适合装载：

- 上一步工具的关键输出
- 当前工作流状态
- 外部系统返回的必要结果

它最忌讳的是把完整原始日志直接塞给模型。

如果你把这四种东西混为一谈，最后系统几乎一定会出现：

- 历史越来越臃肿
- memory 越写越像垃圾桶
- retrieval 越来越像全文复制
- tool result 越来越像日志转储

---

## 10. 为什么压缩不能只靠摘要

很多人一提上下文压缩，就会想到：

> “把旧历史总结一下不就好了？”

摘要当然重要，但它不是万能解。

不同类型内容的最佳压缩方式并不一样。

### 10.1 历史聊天

更适合：

- 提取任务状态
- 总结已确认结论
- 保留未解决问题

### 10.2 检索文档

更适合：

- 句段级裁剪
- 高亮相关段
- 去重合并

### 10.3 工具结果

更适合：

- 提取关键字段
- 结构化归纳
- 只保留失败原因和关键指标

### 10.4 系统策略

更适合：

- 保持原文
- 使用版本化短指令

因为策略内容一旦摘要错了，系统行为边界就可能变形。

所以更合理的做法是建立一个压缩决策表：

```text
history      -> summarize / state extract
retrieval    -> trim / dedupe / rerank
tool_output  -> field extract / short summary
policy       -> keep original
memory       -> compact factual representation
```

---

## 11. 一个通用 `buildContext()` 骨架

下面给一个足够实用的伪代码骨架。

```ts
class DefaultContextAssembler implements ContextAssembler {
  constructor(
    private readonly sources: ContextSource[],
    private readonly ranker: ContextRanker,
    private readonly budgetController: BudgetController,
    private readonly compressor: ContextCompressor,
    private readonly promptAssembler: PromptAssembler
  ) {}

  async build(request: ContextRequest): Promise<ContextPlan> {
    const candidateGroups = await Promise.all(
      this.sources.map((source) => source.collect(request))
    );

    const candidates = candidateGroups.flat();

    const ranked = this.ranker.rank(candidates, request);

    const budget = this.budgetController.allocate(request, ranked);

    const { selected, dropped } = this.budgetController.selectWithinBudget(
      ranked,
      budget
    );

    const { compressed, compressionTrace } = await this.compressor.compress(
      selected,
      budget
    );

    return {
      requestId: request.requestId,
      totalBudget: budget.totalInputBudget,
      reservedOutputTokens: request.reservedOutputTokens,
      allocatedBudgets: budget.slots,
      selectedItems: compressed,
      droppedItems: dropped,
      compressedItems: compressionTrace,
    };
  }

  assemblePrompt(plan: ContextPlan): string {
    return this.promptAssembler.render(plan);
  }
}
```

这个骨架的价值不在于代码量，而在于职责边界很清楚：

- source 负责收集
- ranker 负责排序
- budget controller 负责配额
- compressor 负责降维
- assembler 负责最终拼装

这样后续你想替换任何一个策略，都不会影响整条链。

---

## 12. 数据存储怎么设计

一个实用的上下文系统，通常需要至少 4 类存储。

### 12.1 Session Store

保存最近会话历史。

适合：

- Redis
- Postgres
- MongoDB

要求：

- 能按 sessionId + 时间顺序读取
- 支持 turn 级查询
- 支持快速取最近 N 条

### 12.2 Memory Store

保存长期记忆。

适合：

- Postgres
- Document DB
- Graph / KV 视场景而定

要求：

- 支持按用户 / 租户 / task scope 检索
- 支持事实、偏好、约束等类型化字段
- 支持记忆版本更新，而不是只追加

### 12.3 Retrieval Index

保存外部知识索引。

适合：

- 向量数据库
- BM25 + 向量混合检索
- 代码场景下可叠加 symbol / path 索引

要求：

- 能返回 chunk 级候选
- 能附带来源信息与 metadata
- 能支持 rerank 前的粗召回

### 12.4 Trace Store

保存上下文构建过程本身。

例如：

- 本轮使用了哪些 source
- 每个 source 最终进入多少 token
- 哪些内容被裁掉
- 哪些内容被摘要

这一层非常关键，因为后续优化上下文系统时，你需要先能看见它做了什么。

---

## 13. Chat 和 Agent 为什么应该共用一套 Context Manager

很多团队一开始会分开做：

- 聊天助手一套上下文拼接逻辑
- Agent 执行器一套上下文拼接逻辑

短期看起来更快，长期几乎一定会重复建设。

因为它们本质上都在做同一件事：

> **在某个任务阶段，为某次模型调用准备最相关、最干净、最受预算约束的上下文。**

真正不同的只是：

- source 类型不同
- budget 分配不同
- 任务阶段不同
- priority 权重不同

也就是说，Chat 和 Agent 通常不该有两套完全不同的上下文系统，而应该：

- 共用同一套 `ContextItem / ContextPlan / Budget / Compression` 抽象
- 根据任务类型切不同策略

例如：

```text
chat mode:
  more history
  light tool state
  optional retrieval

agent planning mode:
  more task constraints
  less raw history
  more knowledge and memory

agent execution mode:
  less background docs
  more current tool state
  tighter budget on irrelevant history
```

这才是更有工程复用价值的做法。

---

## 14. 可观测性怎么做，不然你根本不知道系统是否在变好

建议至少记录下面这些字段。

### 14.1 请求级

- `request_id`
- `session_id`
- `task_type`
- `model`
- `total_input_tokens`
- `reserved_output_tokens`
- `context_build_latency_ms`

### 14.2 来源级

- `source_name`
- `candidate_count`
- `selected_count`
- `raw_tokens`
- `final_tokens`
- `compression_strategy`

### 14.3 项目级

- `item_id`
- `relevance_score`
- `priority`
- `kept_or_dropped`
- `drop_reason`

### 14.4 结果级

- 用户是否继续追问
- 是否触发重试
- 是否出现 hallucination / irrelevant answer
- 某种装配策略的答案满意度如何

这些指标会直接支撑后续优化：

- 是否某个来源总是浪费 token
- 是否某类检索片段总被选中但没帮助
- 是否某种摘要策略导致答案质量下降

---

## 15. MVP 应该先做什么，不要一上来就做全套

如果你从零开始搭，最稳的方式不是一次做完，而是分三版。

### 15.1 第一版：先做最小可用装配链

目标：

- recent history
- retrieval
- 全局 token budget
- 简单裁剪
- prompt assembly trace

这个阶段先解决“别乱拼、别炸 token、别完全不可观测”。

### 15.2 第二版：补上策略和压缩

增加：

- source priority
- per-source budget
- history summary
- tool result extraction
- retrieval rerank

这个阶段开始真正建立“上下文治理能力”。

### 15.3 第三版：做成生产级系统

增加：

- long-term memory
- task-stage-aware budget
- adaptive compression
- answer quality feedback loop
- context strategy evaluation

到这一步，你的系统才算从“会拼 prompt”升级到“会管理上下文”。

---

## 16. 最容易踩的坑

### 16.1 把上下文窗口当成越大越好

窗口更大不等于效果更好，只意味着你有更大的治理空间。  
如果系统不会筛选和分配预算，大窗口只会放大噪音。

### 16.2 把 memory 当历史垃圾桶

memory 应该是稳定状态，而不是旧消息回收站。  
否则它会越来越长、越来越脏、越来越难信任。

### 16.3 把 RAG 返回结果原样塞给模型

检索命中只是召回开始，不是 prompt 就绪。  
没有 rerank、裁剪和清洗，RAG 很容易变成噪音放大器。

### 16.4 把工具日志完整注入 prompt

原始工具输出通常信息密度极低。  
能提字段就别贴原文，能贴摘要就别贴全量 payload。

### 16.5 最后才考虑 token

token 预算不应该在 prompt 拼完以后才检查。  
预算应该参与整个上下文决策链。

### 16.6 让每个业务入口自己拼 prompt

这会导致：

- 策略分裂
- 逻辑重复
- 观测断裂
- 很难统一优化

上下文治理必须收敛到统一入口。

---

## 17. 一个面向工程实现的目录建议

如果你要把它真正落成项目，可以考虑这样的目录：

```text
src/
  context/
    context-request.ts
    context-item.ts
    context-plan.ts
    assembler/
      context-assembler.ts
      prompt-assembler.ts
    sources/
      recent-history-source.ts
      memory-source.ts
      retrieval-source.ts
      tool-state-source.ts
      policy-source.ts
    ranking/
      context-ranker.ts
    budget/
      budget-controller.ts
    compression/
      context-compressor.ts
      summarizer.ts
      extractor.ts
    tracing/
      context-trace-recorder.ts
```

这个拆法的好处是：

- 按职责而不是按技术层分
- 每个模块的边界足够清楚
- 后续加新 source 或新压缩策略都比较容易

---

## 18. 如果让我从零实现，我会怎么做

如果目标是 2 到 4 周内做一个能上线试点的 MVP，我会按下面顺序推进：

1. 先定义 `ContextRequest / ContextItem / ContextPlan`
2. 实现 `RecentHistorySource` 和 `RetrievalSource`
3. 加一个最简单的 `BudgetController`
4. 做统一 `PromptAssembler`
5. 打通 trace，记录每次上下文构建结果
6. 再加 `MemorySource`
7. 再加 `ToolStateSource`
8. 最后再做摘要、提取、rerank 和策略优化

为什么不是先做 memory？

因为很多系统还没把“最近历史 + 检索 + 预算治理”做好，就急着上 memory。  
结果不是系统更聪明，而是系统更混乱。

更合理的顺序是：

> **先解决可用性，再解决稳定性，最后解决长期智能。**

---

## 19. 面试回答版总结

如果面试官问：

> “怎么从零搭一个上下文管理系统？”

可以这样回答：

> 我会先把上下文管理从“手写拼 prompt”升级成一条标准装配链。核心不是把更多信息塞给模型，而是在每次调用前做 context selection、ranking、budgeting、compression 和 assembly。  
>  
> 工程上我会先抽象 `ContextRequest`、`ContextItem` 和 `ContextPlan`，把 recent history、memory、retrieval、tool result 都统一成候选上下文，再通过 `ContextRanker` 做优先级排序，通过 `BudgetController` 给不同来源分配 token 预算，超预算时由 `ContextCompressor` 做裁剪、字段提取或摘要，最后再由 `PromptAssembler` 生成 prompt。  
>  
> 这样 Chat 和 Agent 可以共用一套上下文治理引擎，只是不同任务阶段用不同策略。上线时我还会记录每个来源的 token 占比、压缩策略、丢弃原因和答案质量反馈，形成可观测和可迭代的上下文系统。

如果再压缩成一句话：

> **上下文管理系统的本质，不是“存更多”，而是“在有限窗口里把最有价值的信息以最合适的形式交给模型”。**
