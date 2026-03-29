# Multi-Agent 冲突仲裁机制总结

> 本文档总结三大主流 Multi-Agent 框架（LangGraph、AutoGen、CrewAI）在**设计与代码不一致**场景下的冲突仲裁实现机制。

## 概述

多 Agent 系统中的"决策冲突"（设计和代码生成不一致）是核心挑战之一。三个框架采用不同的架构哲学：

| 框架 | 架构模式 | 仲裁机制 |
|------|---------|---------|
| **LangGraph** | 状态图 + 条件边 | Supervisor 节点显式检测 + 条件路由 |
| **AutoGen** | 对话式 / 事件驱动 | GroupChat + 发言者选择 |
| **CrewAI** | 角色型层级流程 | Hierarchical Process + Manager 裁决 |

---

## 一、LangGraph 冲突仲裁

### 核心架构

LangGraph 通过**状态图 (StateGraph)** + **条件边 (Conditional Edges)** 实现 Supervisor 仲裁。

### 1.1 Supervisor Pattern 实现

```python
from typing import TypedDict
from langgraph.graph import StateGraph, END

class AgentState(TypedDict):
    task: str
    current_agent: str
    task_output: dict
    messages: list
    # 关键：存储各 Agent 的输出用于冲突检测
    design_output: str
    code_output: str
    conflicts: list

def supervisor_node(state: AgentState) -> AgentState:
    """
    Supervisor 作为中央仲裁者：
    1. 接收 Designer 和 Coder 的输出
    2. 检测设计-代码不一致
    3. 决定下一步路由
    """
    design = state.get("design_output", "")
    code = state.get("code_output", "")

    # 冲突检测逻辑
    conflicts = detect_mismatches(design, code)

    if conflicts:
        return {
            "current_agent": "conflict_resolver",
            "conflicts": conflicts,
            "messages": state["messages"] + ["Design-code mismatch detected"]
        }
    else:
        return {"current_agent": END}

def conflict_resolver_node(state: AgentState) -> AgentState:
    """
    冲突解决节点：
    - 分析设计意图 vs 代码实现
    - 决定保留哪个版本或合并
    """
    conflicts = state["conflicts"]
    resolution = resolve_conflicts(conflicts, state["task"])

    return {
        "task_output": resolution,
        "messages": state["messages"] + [f"Resolved: {resolution}"]
    }
```

### 1.2 条件边路由（仲裁决策点）

```python
# 定义条件边函数 - 核心仲裁逻辑
def route_after_workers(state: AgentState) -> str:
    """
    根据 Worker 输出决定路由：
    - 有冲突 → conflict_resolver
    - 无冲突 → 结束或下一阶段
    """
    if state.get("conflicts"):
        return "conflict_resolver"
    elif state.get("task_output"):
        return END
    else:
        return "supervisor"

# 构建图
workflow = StateGraph(AgentState)
workflow.add_node("supervisor", supervisor_node)
workflow.add_node("designer", designer_node)
workflow.add_node("coder", coder_node)
workflow.add_node("conflict_resolver", conflict_resolver_node)

workflow.add_edge("supervisor", "designer")
workflow.add_edge("designer", "coder")
workflow.add_edge("coder", "supervisor")

# 条件边 = 仲裁决策点
workflow.add_conditional_edges(
    "supervisor",
    route_after_workers,
    {
        "conflict_resolver": "conflict_resolver",
        END: END
    }
)
```

### 1.3 辩论协议（Debate Protocol）

```python
def debate_protocol(design_output, code_output, max_rounds=3):
    """
    设计 vs 代码 多轮辩论：
    1. Designer 阐述设计意图
    2. Coder 解释实现选择
    3. 仲裁者判断一致性
    """
    for round in range(max_rounds):
        critique = generate_critique(design_output, code_output)

        if is_aligned(design_output, code_output, critique):
            return {"status": "resolved", "winner": "consensus"}

        design_output = revise_design(design_output, critique)
        code_output = revise_code(code_output, critique)

    return {"status": "unresolved", "requires_human": True}
```

### 1.4 电话游戏问题解决

LangGraph 基准发现 Supervisor 会错误转述子 Agent 输出（性能降 50%）。解决方案是**直接转发**：

```python
def forward_message(message: str, to_user: bool = True):
    """
    绕过 Supervisor 合成，子 Agent 直接返回结果。
    避免转述导致的信息损失和冲突产生。
    """
    return {"type": "direct_response", "content": message}
```

配合 `add_conditional_edges` 让特定输出直接流向最终用户。

### 1.5 关键设计原则

1. **状态驱动仲裁**：所有 Agent 输出写入共享 `AgentState`，Supervisor 基于状态做决策
2. **条件边即仲裁逻辑**：路由函数决定冲突时谁来处理
3. **Checkpointing**：冲突解决过程可 checkpoint，防止 Supervisor 上下文溢出
4. **断路器模式**：`AgentCircuitBreaker` 连续失败时自动切换 Agent

---

## 二、AutoGen 冲突仲裁

### 核心架构

AutoGen 通过 **GroupChat** + **GroupChatManager** 实现多 Agent 协作与冲突仲裁，核心在于**发言者选择 (Speaker Selection)**。

### 2.1 GroupChat 仲裁架构

```python
from autogen import AssistantAgent, UserProxyAgent, GroupChat, GroupChatManager

# 定义专家 Agent
designer = AssistantAgent(
    name="designer",
    system_message="""You are a system design specialist.
    Produce architectural designs based on requirements.
    When design output conflicts with code, state your reasoning clearly.""",
    llm_config=llm_config
)

coder = AssistantAgent(
    name="coder",
    system_message="""You are a code implementation specialist.
    Implement code based on designs. Report any design impracticalities.
    When code deviates from design, explain why.""",
    llm_config=llm_config
)

reviewer = AssistantAgent(
    name="reviewer",
    system_message="""You are a code review specialist.
    Identify misalignments between design and code.
    Your role is to flag conflicts and propose resolutions.""",
    llm_config=llm_config
)

supervisor = AssistantAgent(
    name="supervisor",
    system_message="""You are the project supervisor.
    Your job:
    1. Route tasks to designer, coder, reviewer
    2. Detect design-code conflicts
    3. Arbitrate and decide final approach
    4. Ensure consensus before completion""",
    llm_config=llm_config
)

# 关键：allowed_speaker_transitions 限制发言顺序
group_chat = GroupChat(
    agents=[supervisor, designer, coder, reviewer],
    messages=[],
    max_round=30,

    # 仲裁核心：定义允许的发言转换顺序
    allowed_speaker_transitions={
        supervisor: [designer, coder, reviewer],
        designer: [coder, supervisor],
        coder: [reviewer, supervisor],
        reviewer: [designer, coder, supervisor]
    }
)

manager = GroupChatManager(
    groupchat=group_chat,
    llm_config=llm_config,
    speaker_selection_method="auto",
    allow_repeat_speaker=False
)
```

### 2.2 发言者选择仲裁逻辑

```python
class GroupChatManager:
    def _select_next_speaker(self, last_speaker: Agent) -> Agent:
        """
        核心仲裁逻辑：
        1. 收集最后发言者的输出
        2. 检测冲突信号
        3. 选择最合适的下一发言者
        """
        if "conflict" in self.groupchat.messages[-1].content:
            return reviewer

        if "design" in self.groupchat.messages[-1].content:
            return coder

        if "implement" in self.groupchat.messages[-1].content:
            return reviewer

        return supervisor
```

### 2.3 三种仲裁模式

| 模式 | 实现 | 冲突解决方式 |
|------|------|-------------|
| **轮询 (Round Robin)** | 按 `allowed_speaker_transitions` 顺序 | 强制交替发言，避免单一 Agent 主导 |
| **LLM 自动选择** | `speaker_selection_method="auto"` | LLM 判断谁应该发言 |
| **人类仲裁** | `human_input_mode="ALWAYS"` | 冲突时人类介入决定 |

```python
# 人类仲裁模式 - 冲突时暂停等待人类决策
user_proxy = UserProxyAgent(
    name="human",
    human_input_mode="TERMINATE",
    max_consecutive_auto_reply=3
)

if is_unresolvable_conflict(messages):
    user_proxy.human_input()
```

### 2.4 辩论协议实现

```python
def run_design_code_debate(designer_output, coder_output):
    debate_messages = [
        {"speaker": "designer", "content": designer_output},
        {"speaker": "coder", "content": coder_output}
    ]

    for round in range(3):
        designer_critique = designer.generate_reply(
            messages=debate_messages, exclude=["designer"]
        )

        coder_critique = coder.generate_reply(
            messages=debate_messages, exclude=["coder"]
        )

        debate_messages.extend([
            {"speaker": "designer", "content": designer_critique},
            {"speaker": "coder", "content": coder_critique}
        ])

        if has_consensus(debate_messages):
            return {"status": "resolved", "outcome": extract_agreement(debate_messages)}

    return supervisor.final_arbitration(debate_messages)
```

### 2.5 仲裁流程图

```
AutoGen GroupChat 仲裁流程：

┌─────────────────────────────────────────────┐
│  Supervisor 发起任务                         │
└─────────────────┬───────────────────────────┘
                  ▼
┌─────────────────────────────────────────────┐
│  GroupChatManager.select_next_speaker()     │
│  ─ 检测冲突信号                              │
│  ─ 基于 allowed_speaker_transitions 过滤     │
│  ─ LLM 判断最佳下一发言者                     │
└─────────────────┬───────────────────────────┘
                  ▼
    ┌─────────────┼─────────────┐
    ▼             ▼             ▼
 Designer       Coder       Reviewer
    │             │             │
    └─────────────┼─────────────┘
                  ▼
┌─────────────────────────────────────────────┐
│  冲突检测：                                  │
│  - Reviewer 标记 design-code 不一致          │
│  - 或 max_round 达到上限                     │
│  - 或连续相同 Agent 发言                     │
└─────────────────┬───────────────────────────┘
                  ▼
┌─────────────────────────────────────────────┐
│  解决策略：                                  │
│  1. 回到 Supervisor 重新路由                │
│  2. 触发辩论协议多轮讨论                     │
│  3. 人类介入仲裁                             │
│  4. supervisor 最终裁决                      │
└─────────────────────────────────────────────┘
```

---

## 三、CrewAI 冲突仲裁

### 核心架构

CrewAI 的冲突仲裁核心依赖于**层级流程 (Hierarchical Process)** + **任务依赖 (Task Dependencies)** + **输出验证 (Output Validation)**。

### 3.1 Hierarchical Process

```python
from crewai import Agent, Task, Crew, Process

designer = Agent(
    role="System Designer",
    goal="Create consistent, implementable system architectures",
    backstory="Expert at translating requirements into clear designs."
)

coder = Agent(
    role="Software Engineer",
    goal="Implement code that faithfully follows designs",
    backstory="Pragmatic coder who flags design impracticalities."
)

reviewer = Agent(
    role="Code Reviewer",
    goal="Ensure design-code alignment and quality",
    backstory="Detail-oriented reviewer with architecture expertise."
)
```

### 3.2 任务依赖强制顺序（隐式仲裁）

```python
design_task = Task(
    name="architecture_design",
    description="Create system architecture for the feature",
    agent=designer,
    expected_output="Design document with API contracts"
)

code_task = Task(
    name="implementation",
    description="Implement code based on architecture",
    agent=coder,
    dependencies=[design_task],  # 强制等待设计完成后才能开始
    expected_output="Working code implementation"
)

review_task = Task(
    name="alignment_review",
    description="Review code against design for conflicts",
    agent=reviewer,
    dependencies=[design_task, code_task],  # 等待设计和编码都完成
    expected_output="Conflict report with resolution recommendations"
)

crew = Crew(
    agents=[designer, coder, reviewer],
    tasks=[design_task, code_task, review_task],
    process=Process.hierarchical,
    manager_agent=Agent(
        role="Project Manager",
        goal="Coordinate agents and resolve conflicts",
        backstory="Senior PM with technical background"
    )
)
```

### 3.3 冲突检测机制

```python
class ConflictDetection:
    def detect_design_code_conflict(design_output, code_output):
        conflicts = []

        design_apis = extract_api_contracts(design_output)
        code_apis = extract_api_implementations(code_output)

        for api in design_apis:
            if api not in code_apis:
                conflicts.append({
                    "type": "missing_implementation",
                    "design_commitment": api,
                    "severity": "high"
                })

        design_schema = extract_data_schema(design_output)
        code_schema = extract_data_schema(code_output)

        if design_schema != code_schema:
            conflicts.append({
                "type": "schema_mismatch",
                "design": design_schema,
                "code": code_schema,
                "severity": "high"
            })

        return conflicts
```

### 3.4 Task 级别的冲突解决

```python
review_task = Task(
    name="alignment_review",
    description="Review and resolve conflicts",
    agent=reviewer,
    dependencies=[design_task, code_task],

    output_json_schema={
        "type": "object",
        "properties": {
            "conflicts_found": {"type": "boolean"},
            "conflicts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "description": {"type": "string"},
                        "resolution": {"type": "string"},
                        "decided_by": {"type": "string"}
                    }
                }
            },
            "overall_alignment": {"type": "number", "minimum": 0, "maximum": 1}
        },
        "required": ["conflicts_found", "overall_alignment"]
    },

    conditions=[
        "Must identify all design-code misalignments",
        "Must provide specific resolution for each conflict",
        "Must include decision rationale"
    ]
)
```

### 3.5 仲裁流程图

```
CrewAI Hierarchical 仲裁流程：

┌─────────────────────────────────────────────────────┐
│                    Manager Agent                     │
│  (中央仲裁者 - 分解任务、检测冲突、最终决策)           │
└─────────────────┬───────────────────────────────────┘
                  │ 1. 分解任务
                  ▼
        ┌─────────────────┐
        │  Design Task    │◄──── designer agent
        └────────┬────────┘
                 │ 2. 设计输出
                 ▼
        ┌─────────────────┐
        │ Code Task       │◄──── coder agent
        └────────┬────────┘
                 │ 3. 代码输出 + 冲突检测
                 ▼
        ┌─────────────────┐
        │ Review Task    │◄──── reviewer agent
        └────────┬────────┘
                 │ 4. 审查报告
                 ▼
        ┌─────────────────┐
        │ Manager Final  │───► 冲突 → 裁决 (design 还是 code 保留)
        │ Arbitration    │
        └─────────────────┘
```

---

## 四、框架对比总结

| 特性 | LangGraph | AutoGen | CrewAI |
|------|-----------|---------|--------|
| **架构模式** | 状态图 + 条件边 | GroupChat + 发言者选择 | Hierarchical Process + 任务依赖 |
| **仲裁机制** | Supervisor 节点显式检测 + 条件路由 | 发言序列隐式检测 + GroupChatManager | Manager Agent 裁决 + Task 验证 |
| **冲突检测** | Supervisor 基于 `AgentState` 检测 | GroupChat 消息内容分析 | Task 依赖顺序 + `output_json_schema` |
| **解决策略** | 条件路由到 conflict_resolver / 辩论协议 | 辩论协议 / 人类介入 / supervisor 裁决 | Manager 裁决 / Task 重跑 |
| **灵活性** | **高**（图结构完全自定义） | **中**（依赖 GroupChat 框架） | **中**（Process 固定） |
| **人类介入** | 外部钩子 | `human_input_mode` 原生支持 | `human_delegation` |
| **电话游戏问题** | `forward_message` 直接转发 | `allow_repeat_speaker=False` | 依赖 Manager 精简摘要 |

---

## 五、通用冲突仲裁模式

无论哪个框架，冲突仲裁都遵循以下通用模式：

### 5.1 检测阶段

1. **输出对比**：提取设计和代码的关键约定（API、数据结构、功能范围）
2. **差异标记**：识别不一致之处并标记严重程度
3. **信号检测**：检测冲突相关的关键词或行为标记

### 5.2 解决阶段

| 策略 | 适用场景 |
|------|---------|
| **重路由** | 冲突明确，需要特定专家重新处理 |
| **辩论协议** | 边界模糊，需要多轮讨论澄清 |
| **仲裁裁决** | 无法共识，由中央权威（Supervisor/Manager）做决定 |
| **人类介入** | 高风险或无法自动解决的冲突 |

### 5.3 预防机制

1. **任务依赖强制顺序**：CrewAI 的 `dependencies=[task]`
2. **输出 Schema 验证**：AutoGen/CrewAI 的 `output_json_schema`
3. **断路器模式**：连续失败自动切换 Agent
4. **Checkpointing**：防止上下文溢出导致仲裁失效

---

## 六、参考资源

- [LangGraph 文档](https://langchain-ai.github.io/langgraph/) — Multi-agent patterns and state management
- [AutoGen 框架](https://microsoft.github.io/autogen/) — GroupChat and conversational patterns
- [CrewAI 文档](https://docs.crewai.com/) — Hierarchical agent processes
- [Multi-Agent Coordination 代码](./scripts/coordination.py) — 完整仲裁 + 共识 + 失败恢复实现
