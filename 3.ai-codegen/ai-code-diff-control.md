# AI 代码 Diff 级别控制方法

## 问题

AI 生成代码看起来正确，但逻辑实际有误，需要限制其修改范围来实现更精细的控制。

---

## 控制方案

### 1. 提示词层面约束

```markdown
# 正面约束（明确允许）
"仅修改 src/auth/login.ts 中的 validateToken 函数"

# 负面约束（明确禁止）
"不要修改 anyExisting.ts、anyHelper.ts，不要动 test/ 目录"
```

### 2. 工具/框架层面控制

| 方案 | 原理 |
|------|------|
| MCP Server 工具白名单 | 只暴露特定工具，AI 只能调用白名单内的工具 |
| Git Worktree 隔离 | 每个修改范围一个独立 worktree，限制操作域 |
| 只读模式 + 差异补丁 | AI 生成 patch，由人工审查后再应用 |
| AST 级别解析 | 解析代码结构，只允许修改特定节点 |

### 3. 工作流设计

```
User Spec → [AI 生成 diff] → [Human Review] → [Apply/Reject]
```

**实践方式：**
- **边界模式** — 只允许编辑标记的代码段
- **Git diff 过滤** — 用 `git diff --stat` 预览，AI 只能增量修改
- **Schema 约束** — 输出 JSON Patch 格式而非直接改文件

### 4. Claude Code 具体做法

- 用 `--mention` 明确提及文件
- 分步骤任务（一次只做一个小改动）
- 用 `Edit` 工具而非 `Write`，减少误覆盖
- CLAUDE.md 里配置 `DENY_LIST` / `ONLY_ALLOW_PATHS`

---

## 关键原则

> **AI 的修改范围 = 提示词的明确边界 + 工具权限的物理限制**

---

## 相关文档

- [ai-codegen-logic-errors-analysis.md](./ai-codegen-logic-errors-analysis.md) — AI 代码逻辑错误分析
