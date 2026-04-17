# AI Agent 持续学习的三层架构

> 来源：[Continual learning for AI agents](https://blog.langchain.com/continual-learning-for-ai-agents/) — Harrison Chase, 2026-04-05

## 核心观点

AI Agent 的持续学习不仅仅是更新模型权重，而是可以在**三个不同层次**发生：模型层、驱动层、上下文层。三者都以**执行轨迹（Traces）**为数据基础。

## Agent 系统的三层架构

| 层次 | 含义 | Claude Code 示例 | OpenClaw 示例 |
|------|------|-----------------|--------------|
| Model（模型层） | 模型权重本身 | claude-sonnet 等 | 多种模型 |
| Harness（驱动层） | 驱动 agent 运行的代码、指令和工具 | Claude Code | Pi + 其他脚手架 |
| Context（上下文层） | 驱动层之外的可配置信息 | CLAUDE.md, /skills, mcp.json | SOUL.md, clawhub skills |

## 三个层次的持续学习

### 1. 模型层 — 更新权重

- 技术手段：SFT、RL（如 GRPO）等
- 核心挑战：**灾难性遗忘（Catastrophic Forgetting）** — 学习新任务会导致旧能力退化，仍是开放研究问题
- 粒度：通常在 agent 整体层面做训练（如 OpenAI 为 Codex agent 训练专用模型），理论上可以更细粒度（每用户一个 LoRA），但实践中很少这样做

### 2. 驱动层（Harness） — 优化运行代码

- 代表工作：论文 **Meta-Harness: End-to-End Optimization of Model Harnesses**
- 流程：agent 跑一批任务 → 评估结果 → 存储日志到文件系统 → 编码 agent 分析 traces 并建议 harness 代码改进
- 粒度：通常在 agent 级别做，理论上可以按用户定制不同 harness

### 3. 上下文层（Context） — 记忆与配置

上下文层的学习也常被称为 **memory（记忆）**，是目前最灵活、应用最广泛的一层。

**学习粒度：**

| 粒度 | 说明 | 示例 |
|------|------|------|
| Agent 级别 | agent 持久化记忆，自动更新自身配置 | OpenClaw 的 SOUL.md |
| 租户级别（用户/团队/组织） | 每个租户有独立的上下文 | Hex Context Studio、Decagon Duet、Sierra Explorer |
| 混合模式 | agent 级别 + 用户级别 + 组织级别同时生效 | — |

**更新时机：**

- **离线批处理（Offline）**：事后分析历史 traces 提取洞察并更新上下文。OpenClaw 称之为 **"dreaming"**
- **实时热路径（Hot Path）**：agent 运行过程中即时决定更新记忆

**更新触发方式：**

- 用户主动提示 agent 记住某些信息
- agent 基于 harness 内置指令自主决定记忆

## Traces 是一切持续学习的核心

三种学习方式都依赖 traces — agent 完整的执行路径记录：

| 学习目标 | 如何使用 Traces |
|---------|----------------|
| 更新模型 | 收集 traces 作为训练数据（如与 Prime Intellect 合作微调） |
| 改进 Harness | 用编码 agent 分析 traces，建议 harness 代码优化（如 LangSmith CLI/Skills） |
| 学习 Context | agent harness 原生支持记忆功能，从 traces 中提取洞察更新上下文 |

## 总结

Agent 的持续学习 = **模型微调 + 驱动代码优化 + 上下文/记忆管理**。这篇文章提出了一个清晰的分层框架来思考 agent 如何"越用越好"，其中上下文层的学习是当前最实用、粒度最灵活的方向，而 traces 是驱动所有层次学习的共同数据基础。
