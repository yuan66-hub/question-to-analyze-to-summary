# Lessons from Building Claude Code: How We Use Skills

> 来源：Anthropic 工程师 Thariq (@trq212) — 2025.03.18
> 原文：https://x.com/trq212/article/2033949937936085378

## 核心认知

- Skill 不只是 markdown 文件，而是**文件夹**，可包含脚本、资源、数据等
- Skill 有丰富的配置选项，包括注册动态 hooks
- 好的 skill 应清晰归属于某一类别，跨类别的 skill 往往令人困惑

---

## 9 类 Skill 分类

### 1. Library & API Reference（库与 API 参考）

解释如何正确使用库/CLI/SDK，包含代码片段和常见陷阱。

- billing-lib — 内部计费库：边界情况、踩坑点等
- internal-platform-cli — 内部 CLI 封装的每个子命令及使用示例
- frontend-design — 让 Claude 更好地适配你的设计系统

### 2. Product Verification（产品验证）

描述如何测试/验证代码正确性，常搭配 Playwright、tmux 等外部工具。

验证类 skill 对确保 Claude 输出正确性极为重要，值得工程师花一周时间打磨。可以：
- 让 Claude 录制输出视频以查看测试过程
- 对每一步做程序化状态断言
- 在 skill 中包含多种脚本

示例：
- signup-flow-driver — 在无头浏览器中跑注册→邮箱验证→引导流程，每步断言状态
- checkout-verifier — 用 Stripe 测试卡驱动结账 UI，验证发票落到正确状态
- tmux-cli-driver — 用于需要 TTY 的交互式 CLI 测试

### 3. Data Fetching & Analysis（数据获取与分析）

连接数据和监控系统，可包含凭证库、特定 dashboard ID、常见工作流说明。

- funnel-query — "join 哪些事件来看注册→激活→付费"及 canonical user_id 所在表
- cohort-compare — 对比两个 cohort 的留存或转化，标记统计显著差异，链接到 segment 定义
- grafana — datasource UID、集群名、问题→dashboard 查找表

### 4. Business Process Automation（业务流程自动化）

将重复工作流自动化为单一命令。通常是简单指令但可能依赖其他 skill 或 MCP。将历次结果保存到日志文件可帮助模型保持一致性。

- standup-post — 聚合 ticket tracker、GitHub 活动、Slack 历史 → 格式化 standup，仅差异部分
- create-ticket — 强制 schema（有效枚举值、必填字段）+ 创建后工作流（ping reviewer、Slack 链接）
- weekly-recap — 合并的 PR + 关闭的 ticket + 部署 → 格式化周报

### 5. Code Scaffolding & Templates（代码脚手架与模板）

为代码库中特定功能生成框架模板。可与脚本组合使用，特别适合有自然语言需求且纯代码无法覆盖的场景。

- new-framework-workflow — 脚手架新的 service/workflow/handler 并带上你的注解
- new-migration — migration 文件模板加常见踩坑点
- create-app — 预装 auth、logging、deploy 配置的新内部应用

### 6. Code Quality & Review（代码质量与审查）

强制执行组织内的代码质量标准。可包含确定性脚本或工具以获得最大稳健性。可作为 hooks 或 GitHub Action 自动运行。

- adversarial-review — 启动一个全新视角的 subagent 做批评，实施修复，迭代直到发现退化为吹毛求疵
- code-style — 强制代码风格，特别是 Claude 默认做不好的风格
- testing-practices — 如何写测试、测什么

### 7. CI/CD & Deployment（CI/CD 与部署）

帮助获取、推送和部署代码，可能引用其他 skill 来收集数据。

- babysit-pr — 监控 PR → 重试 flaky CI → 解决合并冲突 → 启用 auto-merge
- deploy-service — build → smoke test → 渐进流量切换并对比错误率 → 回归时自动回滚
- cherry-pick-prod — 隔离 worktree → cherry-pick → 冲突解决 → 用模板创建 PR

### 8. Runbooks（运行手册）

接收症状（Slack 线程、告警、错误签名）→ 多工具调查 → 生成结构化报告。

- service-debugging — 将症状映射到工具和查询模式，用于高流量服务
- oncall-runner — 获取告警 → 检查常见原因 → 格式化发现
- log-correlator — 给定 request ID，从所有可能触及的系统拉取匹配日志

### 9. Infrastructure Operations（基础设施运维）

执行常规维护和运维操作，涉及破坏性操作时提供护栏，帮助工程师在关键操作中遵循最佳实践。

- resource-orphans — 发现孤儿 pod/volume → 发 Slack → 等待期 → 用户确认 → 级联清理
- dependency-management — 组织的依赖审批工作流
- cost-investigation — "为什么存储/出口带宽账单暴涨"及对应的 bucket 和查询模式

---

## 编写技巧

### 不要说废话（Don't State the Obvious）

Claude Code 对代码库了解很多，Claude 本身也有很多编码知识和默认观点。如果你的 skill 主要关于知识传递，聚焦于**让 Claude 偏离默认思维方式**的信息。

frontend-design skill 就是一个好例子——由 Anthropic 工程师通过与客户迭代构建，避免了 Inter 字体和紫色渐变等经典模式。

### 建立 Gotchas 节（Build a Gotchas Section）

任何 skill 中信号密度最高的内容。应从 Claude 使用 skill 时的**常见失败点**中积累。理想情况下，应持续更新 skill 来捕获这些 gotchas。

### 利用文件系统做渐进式披露（Use the File System & Progressive Disclosure）

Skill 是文件夹，不只是 markdown 文件。应将整个文件系统视为上下文工程和渐进式披露的形式。告诉 Claude skill 中有哪些文件，它会在合适时机读取。

- 最简单形式：指向其他 markdown 文件，如将详细函数签名和用法拆分到 `references/api.md`
- 输出模板放在 `assets/` 目录供复制使用
- 可用 `references/`、`scripts/`、`examples/` 等文件夹组织内容

### 避免过度限制（Avoid Railroading Claude）

Claude 通常会严格遵守你的指令。因为 Skill 高度可复用，指令过于具体会适得其反。给 Claude 需要的信息，但保留灵活性让它适应不同场景。

### 设计 Setup 流程（Think through the Setup）

某些 skill 需要用户上下文来初始化。好的模式是将设置信息存储在 skill 目录的 `config.json` 中。如果配置未设置，agent 引导用户填写。可用 `AskUserQuestion` 工具提供结构化多选问题。

### description 字段是给模型看的（The Description Field Is For the Model）

Claude Code 启动会话时，会构建所有可用 skill 及其 description 的列表。Claude 扫描这个列表来决定"这个请求有没有对应的 skill？"所以 description 不是摘要——而是**触发条件的描述**。

### 数据持久化（Memory & Storing Data）

某些 skill 可以通过存储数据实现记忆：
- 简单到追加文本日志或 JSON 文件
- 复杂到 SQLite 数据库
- 例如 standup-post skill 保留 `standups.log` 记录每次发布内容

Skill 目录中的数据在升级时可能被删除，应使用 `${CLAUDE_PLUGIN_DATA}` 作为稳定存储路径。

### 存储脚本和生成代码（Store Scripts & Generate Code）

给 Claude 最强大的工具之一是代码。提供脚本和函数库让 Claude 专注于**组合逻辑**，决定下一步做什么，而非重建模板。

例如数据科学 skill 可包含从事件源获取数据的函数库，Claude 可即时生成脚本组合这些功能来做复杂分析。

### On-Demand Hooks

Skill 可包含仅在被调用时激活的 hooks，持续整个会话。适合不想全局开启但有时极有用的场景。

- `/careful` — 通过 PreToolUse matcher 阻止 `rm -rf`、`DROP TABLE`、force-push、`kubectl delete` 等。只在碰生产环境时开启
- `/freeze` — 阻止对特定目录以外的任何 Edit/Write。调试时有用

---

## 分发策略

### 两种共享方式

| 场景 | 方式 |
|------|------|
| 小团队、少数 repo | 提交到 `.claude/skills/` 目录 |
| 大团队、需要规模化 | 内部 plugin marketplace |

提交到 repo 的每个 skill 都会增加模型上下文。规模扩大后，内部 marketplace 让团队自行决定安装哪些。

### Marketplace 管理

- 无集中团队决策，靠有机发现热门 skill
- 新 skill 先上传到 GitHub sandbox 目录供试用，在 Slack 等渠道推广
- 获得足够使用后再 PR 进入 marketplace
- 需要策展机制防止低质量/冗余 skill 泛滥

### Skill 组合（Composing Skills）

依赖管理尚未内置到 marketplace 或 skill 系统中。可在 skill 中按名称引用其他 skill，模型会在已安装的情况下自动调用。

### 衡量 Skill 效果（Measuring Skills）

使用 `PreToolUse` hook 记录公司内 skill 使用日志，可发现热门 skill 和触发率低于预期的 skill。
