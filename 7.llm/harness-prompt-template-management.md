# Harness 工程与 Prompt 模板管理的结合

## 核心分工

Prompt 模板是静态资产，harness 是它的运行时管理者，负责选取、渲染、版本化和可观测。

| 职责 | 归属 |
|------|------|
| 写模板内容、few-shot、格式约束 | Prompt engineering |
| 选模板、渲染参数、注入时机 | Harness |
| 记录模板版本、hash | Harness（可观测层） |
| A/B 路由到不同模板 | Harness（网关/路由层） |
| 存快照保证可复现 | Harness（execution snapshot）|

---

## 1. Harness 决定"选哪套模板"

Prompt 模板本身是静态资产，但**选哪套模板是 harness 的责任**。Agent 在不同阶段需要不同模板：

```
检索阶段  → retrieval_prompt_v2
分析阶段  → analysis_prompt_v1
修复阶段  → patch_prompt_v3
验证阶段  → verify_prompt_v1
```

Harness 根据当前状态机节点，从模板注册表里取出对应模板，传给 context builder 渲染后再送入模型。

---

## 2. Harness 负责模板的版本追踪

每次 `llm.call` 都要在 trace 属性里记录：

```
ai.prompt_template_id       # 模板名，如 "assistant-v3"
ai.prompt_template_version  # 版本号
ai.prompt_hash              # 渲染后 prompt 的 hash
ai.system_prompt_hash       # system prompt 的 hash
```

这些字段以**结构化字段**存入网关请求日志表 `gateway_requests`，而非文本。作用：

- 同一问题在不同模板版本下输出不一样，能用版本号解释差异
- 回归分析时能按 `prompt_template_version` 分组对比效果
- 出问题时能在 execution snapshot 里还原当时用的是哪套模板

---

## 3. Harness 负责模板渲染的参数注入

模板里通常有占位符，由 harness 在运行时填入：

```
system_prompt.md:
  你是一个代码助手，当前任务是 {{task_type}}，
  代码库语言是 {{lang}}，用户角色是 {{user_role}}。
```

Harness 的 context builder 负责：

1. 从 session state 取出运行时参数
2. 渲染模板变量
3. 把渲染结果打包进最终 context

这一步对 prompt engineering 透明，prompt 作者只管写模板，不管参数从哪来。

---

## 4. Harness 支撑 A/B 和灰度

模板升级不能直接全量替换，harness 通过**模板路由策略**做灰度：

```
tenant_A → assistant-v3
tenant_B → assistant-v4（灰度 10%）
```

这和模型路由是同一套机制，都挂在 AI 网关 / harness 编排层上，prompt 模板本身不感知路由逻辑。

---

## 5. Harness 保证模板可复现

execution snapshot 的核心字段：

```
prompt 版本 + context 版本 + retrieval 结果 + tool schema + runtime config
```

Harness 在每次执行时须将"当前用的是哪版模板、渲染参数是什么"一起持久化。不记录这个，线上复现就会失败，因为模板可能已悄悄升过版本。

---

## 常见误区

| 误区 | 正确理解 |
|------|----------|
| 调模板就等于调 prompt | 选模板、版本管理、渲染是 harness 的事 |
| 有模板就有版本管理 | 版本追踪需要 harness 主动记录 hash 和 version |
| 效果差就改模板内容 | 先排查 harness 有没有选错模板或注入错参数 |

---

## 参考

- [Prompt / Context / Harness Engineering 三层区别](./prompt-vs-context-vs-harness-engineering.md)
- [AI 可观测性与网关治理](./ai-observability-agent-gateway-governance.md)
