# Multi-Agent DAG 编排平台：拓扑调度架构设计

## 目录

- [背景与问题定义](#背景与问题定义)
- [目标、边界与原则](#目标边界与原则)
- [总体架构](#总体架构)
- [领域模型与状态机](#领域模型与状态机)
- [DAG 调度设计](#dag-调度设计)
- [关键执行链路](#关键执行链路)
- [可靠性、治理与可观测性](#可靠性治理与可观测性)
- [部署与实施路线](#部署与实施路线)

---

## 背景与问题定义

研究报告、软件研发、数据分析和企业审批等复杂任务，通常需要检索、推理、编码、核查和执行等多个专业 Agent 协同完成。简单串行调用会造成等待；无约束并发则会带来输入不完整、重复执行、状态冲突和成本失控。

本方案将一个用户目标建模为**有向无环图**（Directed Acyclic Graph，DAG）：节点代表可独立执行的任务，边代表数据或控制依赖。只有所有前置条件都满足的节点才能运行；不存在依赖关系的节点可以并行运行。

拓扑排序不是产出一次性的任务顺序，而是持续发现当前可执行的节点集合。它提供依赖正确性和并行机会；状态机、工件管理、质量校验和权限治理使其成为可在生产环境运行的系统。

| 场景 | DAG 示例 | 平台价值 |
|---|---|---|
| 研究报告 | 问题拆解 → 多路检索/分析 → 核查 → 汇总 | 缩短交付周期，保证证据可追溯 |
| 软件研发 | 需求 → 设计 → 前后端并行 → 测试 → 发布 | 用工件完成交接，隔离失败影响 |
| 数据与 ML | 采集 → 清洗 → 特征 → 并行训练 → 评估 | 复用流程并提高资源利用率 |
| 企业流程 | 材料 → 风险/合规 → 审批 → 执行 | 强制顺序，保留完整审计链路 |

## 目标、边界与原则

### 目标

- **正确调度**：不允许未满足前置依赖的任务提前执行。
- **高吞吐**：在预算、优先级和资源配额内最大化并行度。
- **可恢复**：调度器或 Worker 重启后可从持久化状态恢复。
- **可审计**：任务输入、输出、决策、工具调用和人工介入均可追溯。
- **可治理**：统一管理模型选择、Token、工具权限、限流与敏感数据。

### 系统边界

平台负责任务图的创建、运行、恢复和治理；专业 Agent 内部的推理策略由 Agent Profile 定义。代码仓库、数据仓库、工单、部署平台等外部系统通过工具网关接入。所有有外部副作用的动作均须使用幂等键，并可配置审批门。

### 设计原则

| 原则 | 说明 |
|---|---|
| 工件优先 | 下游读取持久化、版本化的 Artifact，而非上游对话内容。 |
| 状态外置 | Worker 无状态运行，状态由统一状态库维护。 |
| 显式契约 | 输入、输出、依赖、超时、验收条件均结构化定义。 |
| 至少一次投递，幂等执行 | 队列可重复投递；租约与幂等键避免重复副作用。 |
| 先校验后放行 | Agent 返回结果后须通过 schema、质量和策略校验。 |
| 最小权限 | Agent 只获得当前节点需要的工具和数据。 |

## 总体架构

平台采用“中心化 DAG 编排 + 分布式 Worker 执行”模式。控制面创建和推进状态；数据面执行 Agent、保存工件并调用工具。

```text
┌───────────────────────────────────────────────────────────────┐
│ 接入层：API Gateway / Web UI / SDK / Webhook                  │
│ 鉴权、租户隔离、限流、任务提交、状态查询、事件订阅              │
└────────────────────────────┬──────────────────────────────────┘
                             ▼
┌───────────────────────────────────────────────────────────────┐
│ 编排控制面                                                      │
│ Planner → DAG Validator → Workflow Store → Scheduler          │
│ 拆解任务    环/配额校验      状态与版本         拓扑推进        │
└──────────────┬────────────────────────────┬───────────────────┘
               ▼                            ▼
┌────────────────────────┐       ┌─────────────────────────────┐
│ Message Queue           │       │ Artifact / Context Store    │
│ ready、retry、dead-letter│       │ 结构化输出、引用、检查点    │
└──────────────┬─────────┘       └─────────────────────────────┘
               ▼
┌───────────────────────────────────────────────────────────────┐
│ Agent Worker：Research / Code / Analysis / Review / Action    │
│ 模型路由、沙箱、工具调用、结果提交、心跳与执行租约              │
└────────────────────────────┬──────────────────────────────────┘
                             ▼
┌───────────────────────────────────────────────────────────────┐
│ 治理支撑层：Tool Gateway / Policy / Secrets / Trace / Metrics │
└───────────────────────────────────────────────────────────────┘
```

| 组件 | 职责 |
|---|---|
| Planner | 将用户目标拆为任务与依赖，生成候选 DAG。 |
| DAG Validator | 校验 schema、环、预算、权限、任务数和引用完整性。 |
| Workflow Store | 保存工作流版本、状态转换、租约与审计事件。 |
| Scheduler | 找到 ready 节点，排序、投递并推进下游任务。 |
| Agent Worker | 领取任务、调用模型与工具、生成 Artifact。 |
| Artifact Store | 保存结构化输出、文件、引用和版本元数据。 |
| Tool Gateway | 对外部工具实施鉴权、参数审计、限流及副作用控制。 |
| Validator / Reviewer | 进行格式、质量、事实、安全及策略校验。 |

## 领域模型与状态机

### 核心实体

- **Workflow**：一次端到端目标的执行实例，包含 DAG、预算、租户和运行策略。
- **Task**：可独立调度的原子工作单元，绑定 Agent Profile 与任务契约。
- **Artifact**：任务的持久化输出，可被引用、校验、版本化和审计。
- **Execution Attempt**：Task 的一次尝试，记录 Worker、租约、成本和调用轨迹。

```json
{
  "taskId": "verify_sources",
  "agentProfile": "fact-checker",
  "dependsOn": ["official_research", "industry_research"],
  "inputArtifacts": ["artifact://official_research/v1", "artifact://industry_research/v2"],
  "outputSchema": "FactCheckReport/v1",
  "acceptancePolicy": "source-verification-v2",
  "timeoutSeconds": 600,
  "retryPolicy": { "maxAttempts": 2, "backoff": "exponential" }
}
```

### 任务状态机

```text
pending → ready → leased → running → validating → succeeded
   │        │        │          │          └──► retrying → ready
   │        │        │          └────────────► failed
   │        │        └───────────────────────► timed_out
   │        └────────────────────────────────► cancelled
   └─────────────────────────────────────────► blocked
```

- `pending`：仍存在未满足依赖；`ready`：可以投递。
- `leased`：Worker 已取得有限期租约；`running`：正在执行并发送心跳。
- `validating`：结果已生成，等待质量门放行；`blocked`：等待审批或外部输入。

状态变更由 Workflow Store 通过条件更新完成。只有持有未过期租约的 Worker 才能提交结果；Worker 无权直接推进下游节点。

## DAG 调度设计

### 增量拓扑排序

Scheduler 使用 Kahn 算法的增量实现。每个节点维护“未满足依赖计数”与依赖策略。初始化时，计数为零的根节点进入 `ready`；一个任务成功后，系统只更新其直接后继节点，无须扫描整张图。

```text
1. 创建 DAG 并计算每个节点的未满足依赖数。
2. 将满足条件的节点原子标记为 ready，投递任务队列。
3. Worker 执行任务并提交经校验的 Artifact。
4. Scheduler 在同一事务中标记成功、更新后继依赖数。
5. 满足依赖策略的后继节点进入 ready，进入下一轮调度。
6. 若存在非终态节点却无 ready/running 节点，触发阻塞或环诊断。
```

```python
def on_task_succeeded(task_id: str):
    transaction.begin()
    mark_succeeded(task_id)
    for child in downstream_tasks(task_id):
        decrease_unsatisfied_dependencies(child)
        if dependency_policy_satisfied(child):
            compare_and_set_status(child, expected="pending", target="ready")
            enqueue(child)
    transaction.commit()
```

### 依赖策略、优先级与动态扩图

默认策略为 `all_success`，同时支持 `any_success`、`all_terminal`、`quorum_success` 和等待审批的 `manual_gate`。策略必须在建图时显式声明。

建议依据租户权重、业务 SLA、关键路径、预估成本和重试惩罚形成优先级：

```text
Priority = TenantWeight + BusinessSLA + CriticalPathWeight
           - EstimatedCost - RetryPenalty
```

执行中允许新增子任务，但新边不得指向已成功的历史节点，增量图必须重新通过环检测、预算校验与审计。迭代型任务应使用有最大次数的子工作流，不能直接在主 DAG 中建立环。

## 关键执行链路

```text
用户提交目标
  → Planner 生成 DAG 草案
  → Validator 校验依赖、预算和权限
  → Workflow Store 持久化版本
  → Scheduler 投递根节点
  → Worker 执行并写入 Artifact
  → Validator 校验结果
  → Scheduler 推进下游节点
  → Aggregator 汇总最终 Artifact
  → API 返回结果及可追溯执行链接
```

Worker 必须遵循统一契约：申请租约，读取并校验输入 Artifact，根据 Agent Profile 获得模型和工具权限，执行时上报心跳及成本，将结构化输出写入 Artifact Store，最后提交结果引用、证据和摘要。平台仅在校验通过后将任务置为 `succeeded`。

当任务触发高风险工具、预算超限、证据不足或策略冲突时，转入 `blocked` 并创建审批项。批准后恢复 `ready`；驳回后取消任务并按依赖策略阻塞或降级下游；修改输入则创建新 Artifact 版本重新运行。

## 可靠性、治理与可观测性

### 故障处理与幂等

| 故障类型 | 示例 | 处理策略 |
|---|---|---|
| 瞬态故障 | 网络超时、限流、工具暂不可用 | 指数退避重试，限制最大次数 |
| 输入故障 | Artifact 缺失、schema 不匹配 | 阻塞并追溯上游，不盲目重试 |
| 质量故障 | 测试失败、证据不足、不合规输出 | 进入修复或审查子工作流 |
| 平台故障 | Worker 宕机、Scheduler 重启 | 租约到期后回收，依据状态库恢复 |

队列采用“至少一次”投递。每次执行使用 `workflowId + taskId + attempt` 标识；状态更新依靠乐观锁或条件更新；外部写操作携带稳定幂等键。取消是可传播的控制信号：未开始节点直接取消，运行中节点接收协作式取消，完成工件保留审计但不再默认供下游消费。

### 安全、成本与可观测性

- 按租户和工作流隔离 Artifact、日志与凭据；Worker 使用短期令牌。
- Tool Gateway 实施 allowlist、参数校验、限流和全量审计。
- 将不可信检索内容标记来源与信任等级，防御提示注入。
- 对写操作、高成本操作、敏感数据外发实行策略检查或人工审批。
- 在运行前预估预算，运行中按 Token、工具时间和外部 API 费用扣减预算；阈值触发模型降级、停止非关键分支或转人工。

每个 Workflow 使用统一 Trace 串联 Planner、Scheduler、Worker、模型和工具。需要持续观测成功率、端到端与关键路径耗时、队列深度、领取延迟、重试率、Token/费用，以及 Artifact 版本链和审批记录。运行界面应提供 DAG 视图，支持从任意节点追溯其输入、输出和完整调用轨迹。

## 部署与实施路线

### 部署拓扑

```text
Load Balancer
  └─ API / Orchestrator × N
       ├─ SQL State Store + Replica
       ├─ Message Queue
       ├─ Artifact Object Store
       └─ Specialized Agent Worker Pools × N
          Research / Code / Review / Action
```

API、Orchestrator 和 Scheduler 无状态部署，通过状态库和队列实现高可用。Worker 按 Agent Profile、模型能力、GPU 或沙箱需求划分资源池。关系数据库保存状态机与元数据；对象存储保存大体积工件。

容量规划应评估 DAG 节点数、单节点执行时长、扇出扇入比例、Token 与 Artifact 大小、重试率和长尾延迟。自动扩缩容须综合队列积压、等待时长、资源类型与预算余额，而非只看 CPU 使用率。

### 分阶段实施

| 阶段 | 交付能力 | 验证重点 |
|---|---|---|
| Phase 1 | 静态 DAG、基础 Worker、状态查询 | 依赖正确性、任务可恢复 |
| Phase 2 | 租约、重试、死信、Artifact 版本、Trace | 重复执行率、故障可诊断性 |
| Phase 3 | 多租户、预算、权限网关、审批、动态扩图 | 成本可控、权限可审计 |
| Phase 4 | 关键路径优化、缓存、预测调度、弹性伸缩 | 时延、吞吐、单位任务成本 |

## 结论

多 Agent 的重点不在于“更多 Agent 同时工作”，而在于将协作关系转化为可验证的 DAG，并由可恢复的状态机持续推进。拓扑排序保证依赖正确性并释放并行能力；Artifact 契约、租约、质量门、权限治理和可观测性，决定系统能否在生产环境稳定运行。

建议从“静态 DAG + 明确任务契约 + 外置状态 + 统一可观测性”建立最小闭环，待运行数据成熟后再逐步引入动态扩图、预测调度和更高自治程度的协作模式。
