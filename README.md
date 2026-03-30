# Interview 文档索引

## 目录

- [1. Multi-Agent 系统](#1-multi-agent-系统)
- [2. 知识检索与 RAG](#2-知识检索与-rag)
- [3. AI 代码生成与质量](#3-ai-代码生成与质量)
- [4. 需求追踪与任务分解](#4-需求追踪与任务分解)
- [5. 前端开发](#5-前端开发)
- [6. Node.js 与后端](#6-nodejs-与后端)
- [7. LLM 应用](#7-llm-应用)

---

## 1. Multi-Agent 系统

| 文档                                                                                       | 说明                                           |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| [multi-agent-task-orchestration.md](./1.multi-agent/multi-agent-task-orchestration.md)     | Multi-Agent 任务编排指南，分解复杂问题并行分发 |
| [multi-agent-state-passing.md](./1.multi-agent/multi-agent-state-passing.md)               | Agent 间状态传递机制                           |
| [multi-agent-conflict-arbitration.md](./1.multi-agent/multi-agent-conflict-arbitration.md) | Agent 冲突仲裁与解决                           |
| [openclaw-memory-implementation.md](./1.multi-agent/openclaw-memory-implementation.md)     | OpenClaw Memory 实现方案                       |

## 2. 知识检索与 RAG

| 文档                                                                                                 | 说明                                   |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [embedding-retrieval-deep-analysis.md](./2.knowledge-retrieval/embedding-retrieval-deep-analysis.md) | Embedding 检索深度解析，向量数据库原理 |
| [cursor-vs-claude-code-retrieval.md](./2.knowledge-retrieval/cursor-vs-claude-code-retrieval.md)     | Cursor vs Claude Code 检索方案对比     |
| [knowledge-base-retrieval-strategy.md](./2.knowledge-retrieval/knowledge-base-retrieval-strategy.md) | 知识库检索策略                         |
| [knowledge-base-governance.md](./2.knowledge-retrieval/knowledge-base-governance.md)                 | 知识库治理                             |
| [large-project-ai-comprehension.md](./2.knowledge-retrieval/large-project-ai-comprehension.md)       | 大型项目 AI 理解方案                   |

## 3. AI 代码生成与质量

| 文档                                                                                            | 说明                     |
| ----------------------------------------------------------------------------------------------- | ------------------------ |
| [complex-business-ai-codegen-quality.md](./3.ai-codegen/complex-business-ai-codegen-quality.md) | 复杂业务 AI 代码生成质量 |
| [ai-codegen-logic-errors-analysis.md](./3.ai-codegen/ai-codegen-logic-errors-analysis.md)       | AI 代码逻辑错误分析      |
| [ai-code-diff-control.md](./3.ai-codegen/ai-code-diff-control.md)                               | AI 代码差异控制          |
| [ai-code-quality-evaluation.md](./3.ai-codegen/ai-code-quality-evaluation.md)                   | AI 代码质量评估          |
| [ai-content-production-denoising.md](./3.ai-codegen/ai-content-production-denoising.md)         | AI 辅助内容生产去噪规范  |
| [ui-deviation-detection.md](./3.ai-codegen/ui-deviation-detection.md)                           | UI 偏差检测              |

## 4. 需求追踪与任务分解

| 文档                                                                                                      | 说明                 |
| --------------------------------------------------------------------------------------------------------- | -------------------- |
| [prd-to-design-requirements-traceability.md](./4.requirements/prd-to-design-requirements-traceability.md) | PRD 到设计的需求追踪 |
| [requirements-code-mapping.md](./4.requirements/requirements-code-mapping.md)                             | 需求与代码映射       |
| [task-decomposition-granularity.md](./4.requirements/task-decomposition-granularity.md)                   | 任务分解粒度         |

## 5. 前端开发

| 文档                                                                                            | 说明                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| [client-side-ai-webllm-applications.md](./5.frontend/client-side-ai-webllm-applications.md) | 端侧 AI 模型（WebLLM）前端应用场景    |
| [react-streaming-rendering-optimization.md](./5.frontend/react-streaming-rendering-optimization.md) | React 流式输出渲染优化                |
| [react-context-vs-zustand.md](./5.frontend/react-context-vs-zustand.md)                         | React Context vs Zustand 深度对比     |
| [react-state-update-debugging.md](./5.frontend/react-state-update-debugging.md)                 | React 状态更新调试                    |
| [service-worker-web-worker-iframe.md](./5.frontend/service-worker-web-worker-iframe.md)         | Service Worker、Web Worker 与 iframe 总结 |
| [vue3-reactivity-vs-alien-signals.md](/5.frontend/vue3-reactivity-vs-alien-signals.md)          | Vue 3 响应式系统与 Alien Signals 对比 |
| [frontend-algorithm-scenes.md](./5.frontend/frontend-algorithm-scenes.md)                       | 前端算法应用场景详解                  |

## 6. Node.js 与后端

| 文档                                                                          | 说明                     |
| ----------------------------------------------------------------------------- | ------------------------ |
| [nodejs-memory-leak-debugging.md](./6.nodejs/nodejs-memory-leak-debugging.md) | Node.js 内存泄漏排查指南 |

## 7. LLM 应用

| 文档                                                                                                 | 说明                                                                          |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [prompt-vs-context-vs-harness-engineering.md](./7.llm/prompt-vs-context-vs-harness-engineering.md)   | Prompt Engineering、Context Engineering 与 Harness Engineering 的工程实践区别 |
| [llm-spelling-correction.md](./7.llm/llm-spelling-correction.md)                                     | LLM 拼写纠正                                                                  |
| [ai-native-applications.md](./7.llm/ai-native-applications.md)                                       | AI 原生应用：定义、判断标准、典型架构与案例拆解                               |
| [ai-observability-agent-gateway-governance.md](./7.llm/ai-observability-agent-gateway-governance.md) | AI 服务网关治理、日志追踪、Agent 状态轨迹与用户行为复现的完整手册             |
