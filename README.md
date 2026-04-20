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
| [claude-code-source-analysis.md](./1.multi-agent/claude-code-source-analysis.md)           | Claude Code 源码架构深度分析                   |

## 2. 知识检索与 RAG

| 文档                                                                                                 | 说明                                   |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [embedding-retrieval-deep-analysis.md](./2.knowledge-retrieval/embedding-retrieval-deep-analysis.md) | Embedding 检索深度解析，向量数据库原理 |
| [cursor-vs-claude-code-retrieval.md](./2.knowledge-retrieval/cursor-vs-claude-code-retrieval.md)     | Cursor vs Claude Code 检索方案对比     |
| [knowledge-base-retrieval-strategy.md](./2.knowledge-retrieval/knowledge-base-retrieval-strategy.md) | 知识库检索策略                         |
| [knowledge-base-governance.md](./2.knowledge-retrieval/knowledge-base-governance.md)                 | 知识库治理                             |
| [large-project-ai-comprehension.md](./2.knowledge-retrieval/large-project-ai-comprehension.md)       | 大型项目 AI 理解方案                   |
| [rag-and-vector-database-comparison.md](./docs/rag-and-vector-database-comparison.md)               | RAG 架构方案与主流向量数据库能力对比   |

## 3. AI 代码生成与质量

| 文档                                                                                            | 说明                     |
| ----------------------------------------------------------------------------------------------- | ------------------------ |
| [complex-business-ai-codegen-quality.md](./3.ai-codegen/complex-business-ai-codegen-quality.md) | 复杂业务 AI 代码生成质量 |
| [ai-codegen-logic-errors-analysis.md](./3.ai-codegen/ai-codegen-logic-errors-analysis.md)       | AI 代码逻辑错误分析      |
| [ai-code-diff-control.md](./3.ai-codegen/ai-code-diff-control.md)                               | AI 代码差异控制          |
| [ai-code-quality-evaluation.md](./3.ai-codegen/ai-code-quality-evaluation.md)                   | AI 代码质量评估          |
| [ai-content-production-denoising.md](./3.ai-codegen/ai-content-production-denoising.md)         | AI 辅助内容生产去噪规范  |
| [ui-deviation-detection.md](./3.ai-codegen/ui-deviation-detection.md)                           | UI 偏差检测              |
| [claude-code-skills-best-practices.md](./docs/claude-code-skills-best-practices.md)             | Claude Code Skills 设计原则、分类与最佳实践 |

## 4. 需求追踪与任务分解

| 文档                                                                                                      | 说明                 |
| --------------------------------------------------------------------------------------------------------- | -------------------- |
| [prd-to-design-requirements-traceability.md](./4.requirements/prd-to-design-requirements-traceability.md) | PRD 到设计的需求追踪 |
| [requirements-code-mapping.md](./4.requirements/requirements-code-mapping.md)                             | 需求与代码映射       |
| [task-decomposition-granularity.md](./4.requirements/task-decomposition-granularity.md)                   | 任务分解粒度         |

## 5. 前端开发

| 文档                                                                                            | 说明                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| [react-principles.md](./5.frontend/react-principles.md)                                         | React 核心原理：Hooks、Fiber 架构、Scheduler 调度、Diff 算法、React 18 并发特性 |
| [frontend-network-principles.md](./5.frontend/frontend-network-principles.md)                   | 前端网络原理：HTTP 协议、缓存机制、跨域、DNS、性能优化、网络 API |
| [web-security-guide.md](./5.frontend/web-security-guide.md)                                     | Web 安全原理：XSS、CSRF、CSP、HTTPS、Cookie、CORS、JWT、原型链污染、供应链攻击 |
| [frontend-engineering-guide.md](./5.frontend/frontend-engineering-guide.md)                     | 前端工程化原理：构建工具、Monorepo、模块联邦、CI/CD、错误监控、组件库、代码质量 |
| [client-side-ai-webllm-applications.md](./5.frontend/client-side-ai-webllm-applications.md)    | 端侧 AI 模型（WebLLM）前端应用场景    |
| [react-streaming-rendering-optimization.md](./5.frontend/react-streaming-rendering-optimization.md) | React 流式输出渲染优化                |
| [react-context-vs-zustand.md](./5.frontend/react-context-vs-zustand.md)                         | React Context vs Zustand 深度对比     |
| [react-state-update-debugging.md](./5.frontend/react-state-update-debugging.md)                 | React 重渲染定位与优化（Profiler、why-did-you-render、startTransition、Context 拆分） |
| [service-worker-web-worker-iframe.md](./5.frontend/service-worker-web-worker-iframe.md)         | Service Worker、Web Worker 与 iframe 总结 |
| [vue3-reactivity-vs-alien-signals.md](./5.frontend/vue3-reactivity-vs-alien-signals.md)         | Vue 3 响应式系统与 Alien Signals 对比 |
| [frontend-algorithm-scenes.md](./5.frontend/frontend-algorithm-scenes.md)                       | 前端算法应用场景详解                  |
| [react-state-update.md](./5.frontend/react-state-update.md)                                     | React 状态更新后获取最新值的方案      |
| [react-usecallback-usememo.md](./5.frontend/react-usecallback-usememo.md)                       | useCallback 与 useMemo 原理、场景、性能开销与常见错误 |
| [network-performance-optimization.md](./5.frontend/network-performance-optimization.md)         | 前端网络层面性能优化：协议升级、连接优化、缓存策略、资源加载控制 |
| [nextjs-ssr-isr-guide.md](./5.frontend/nextjs-ssr-isr-guide.md)                                 | Next.js SSR 与 ISR 深度指南：渲染策略对比、On-demand ISR、revalidatePath/revalidateTag |
| [hls-low-latency-streaming.md](./5.frontend/hls-low-latency-streaming.md)                       | HLS 与 LL-HLS 低延迟流媒体：分片原理、Partial Segment、Blocking Reload、SRS 配置、延迟优化 |
| [electron-principles.md](./5.frontend/electron-principles.md)                                   | Electron 核心原理：进程架构、IPC 通信、安全模型、性能优化、打包分发、Native 集成、自动更新 |
| [pnpm-monorepo-permission-submodule.md](./5.frontend/pnpm-monorepo-permission-submodule.md)     | pnpm Monorepo 按权限拉取子包完整落地示例 |
| [webassembly-video-editor-sdk.md](./5.frontend/webassembly-video-editor-sdk.md)                 | WebAssembly 视频编辑器 SDK 架构设计 |
| [browser-long-task-optimization.md](./5.frontend/browser-long-task-optimization.md)             | 浏览器主线程长任务优化：调度、中断与 DevTools 调试 |
| [browser-reflow-repaint-mechanism.md](./5.frontend/browser-reflow-repaint-mechanism.md)         | 浏览器回流与重绘底层机制深度分析 |
| [browser-event-loop-microtask.md](./5.frontend/browser-event-loop-microtask.md)                 | 浏览器事件循环：微任务机制与调度 API |
| [react-native-native-modules.md](./5.frontend/react-native-native-modules.md)                   | React Native 原生模块开发：iOS/Android 基础概念与桥接实战 |
| [webassembly-image-processing.md](./5.frontend/webassembly-image-processing.md)                 | WebAssembly 图像处理实战与应用场景 |
| [timer-hijacking-simulation.md](./5.frontend/timer-hijacking-simulation.md)                     | 计时器劫持模拟：Fake Timers 原理与实现 |
| [multi-file-preview-optimization.md](./5.frontend/multi-file-preview-optimization.md)           | 多文件预览性能优化：架构设计与渲染策略 |
| [video-mixing-rules-and-technical-design.md](./docs/video-mixing-rules-and-technical-design.md) | 视频混剪规则、组合算法与 Pipeline 设计 |
| [wasm-multi-video-concat-preview.md](./docs/wasm-multi-video-concat-preview.md)                 | WebAssembly 多视频拼接预览：时间轴映射、按需解码、无缝衔接与导出编码 |
| [wasm-canvas-frame-processing.md](./docs/wasm-canvas-frame-processing.md)                       | WebAssembly SDK 在 Canvas 逐帧图片处理：帧提取、内存交互、SIMD 加速、多轨合成 |
| [long-cache-implementation.md](./docs/long-cache-implementation.md)                             | 长缓存实现方案：HTTP 强缓存、协商缓存与资源指纹策略 |
| [massive-image-loading-optimization.md](./docs/massive-image-loading-optimization.md)           | 大量图片同时加载优化：懒加载、预加载、压缩与渲染策略 |
| [event-delegation-optimization.md](./docs/event-delegation-optimization.md)                     | 多按钮点击事件优化：事件委托原理与实践 |
| [pagination-race-condition.md](./docs/pagination-race-condition.md)                             | 分页竞态问题（Race Condition）：成因分析与解决方案 |
| [virtual-list-optimization.md](./docs/virtual-list-optimization.md)                             | 虚拟列表优化场景全景梳理 |
| [nextjs-opentelemetry-aliyun-ssr-memory-leak-design.md](./docs/nextjs-opentelemetry-aliyun-ssr-memory-leak-design.md) | Next.js SSR 可观测性接入与 Node 内存泄漏治理 |

## 6. Node.js 与后端

| 文档                                                                                    | 说明                                                        |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [nodejs-core-principles.md](./6.nodejs/nodejs-core-principles.md)                       | Node.js 核心原理：事件循环、模块系统、流、进程线程、V8 GC、HTTP、安全、性能监控 |
| [nodejs-memory-leak-debugging.md](./6.nodejs/nodejs-memory-leak-debugging.md)           | Node.js 内存泄漏排查指南                                    |
| [docker-pnpm-cache-optimization.md](./6.nodejs/docker-pnpm-cache-optimization.md)     | Docker 容器构建中 pnpm install 缓存复用指南                 |

## 7. LLM 应用

| 文档                                                                                                 | 说明                                                                          |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [prompt-vs-context-vs-harness-engineering.md](./7.llm/prompt-vs-context-vs-harness-engineering.md)   | Prompt Engineering、Context Engineering 与 Harness Engineering 的工程实践区别 |
| [llm-spelling-correction.md](./7.llm/llm-spelling-correction.md)                                     | LLM 拼写纠正                                                                  |
| [ai-native-applications.md](./7.llm/ai-native-applications.md)                                       | AI 原生应用：定义、判断标准、典型架构与案例拆解                               |
| [ai-observability-agent-gateway-governance.md](./7.llm/ai-observability-agent-gateway-governance.md) | AI 服务网关治理、日志追踪、Agent 状态轨迹与用户行为复现的完整手册             |
| [vertical-llm-training-douyin-agent.md](./7.llm/vertical-llm-training-douyin-agent.md)               | 垂直领域大模型训练：以手机抖音视频发布 Agent 为例                             |
| [harness-prompt-template-management.md](./7.llm/harness-prompt-template-management.md)               | Harness 工程与 Prompt 模板管理的结合                                          |
| [application-layer-token-optimization.md](./7.llm/application-layer-token-optimization.md)           | 应用层大模型 Token 优化策略                                                   |
| [tts-performance-optimization.md](./7.llm/tts-performance-optimization.md)                           | 文本转语音（TTS）性能优化策略                                                 |
| [ai-one-click-video-production.md](./7.llm/ai-one-click-video-production.md)                         | AI 工作流引擎：多模态素材编排与自动化生产管线技术方案                         |
| [ai-capability-overhang.md](./docs/ai-capability-overhang.md)                                       | AI 能力过剩与企业落地瓶颈、Context Gap 分析                                   |
| [ai-production-permission-system-four-layer-defense.md](./docs/ai-production-permission-system-four-layer-defense.md) | AI 生产级权限系统的四层防线设计                                               |
| [context-management-system-practical-guide.md](./docs/context-management-system-practical-guide.md) | 上下文管理系统实战：选择、排序、预算、压缩与装配                              |
| [deferred-loading-and-dynamic-toolset.md](./docs/deferred-loading-and-dynamic-toolset.md)           | Deferred Loading 与动态工具集设计总结                                         |
| [system-prompt-engineering-and-context-rot.md](./docs/system-prompt-engineering-and-context-rot.md) | System Prompt 工程化与 Context Rot 治理                                       |
| [cache-explained-and-cost-control.md](./docs/cache-explained-and-cost-control.md)                   | KV Cache、Prompt Cache、Context Collapse 与成本控制                           |
| [continual-learning-for-ai-agents.md](./docs/continual-learning-for-ai-agents.md)                   | AI Agent 持续学习的三层架构                                                   |
| [agent-loop-three-fuses.md](./docs/agent-loop-three-fuses.md)                                       | Agent Loop 的三道保险丝：终止控制、失败学习与 Token 预算治理                  |
| [harness-design-long-running-apps.md](./docs/harness-design-long-running-apps.md)                   | 长时运行应用开发的 Harness 设计                                               |
| [harness-engineering-summary.md](./docs/harness-engineering-summary.md)                             | Harness Engineering 与工程师角色演变总结                                     |
