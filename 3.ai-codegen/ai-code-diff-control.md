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

## MCP Server 工具白名单配置

### 概念

MCP（Model Context Protocol）允许定义 AI 可以调用的工具集合。通过只暴露特定工具，可以从物理层面限制 AI 的操作范围。

### 白名单配置示例（`.mcp/config.json`）

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/src/auth"],
      "env": {},
      "comment": "只允许访问 src/auth 目录"
    }
  },
  "toolAllowlist": {
    "filesystem": [
      "read_file",
      "write_file",
      "list_directory"
    ],
    "comment": "禁止 delete_file、move_file 等破坏性操作"
  },
  "pathRestrictions": {
    "allowWrite": [
      "src/auth/**",
      "src/utils/token.ts"
    ],
    "denyWrite": [
      "src/config/**",
      "**/*.test.ts",
      "package.json",
      "tsconfig.json"
    ]
  }
}
```

### Claude Code 的 `settings.json` 权限控制

```json
{
  "permissions": {
    "allow": [
      "Edit(src/auth/**)",
      "Edit(src/utils/auth-*.ts)",
      "Read(**)"
    ],
    "deny": [
      "Edit(src/config/**)",
      "Edit(**/*.test.ts)",
      "Bash(rm *)",
      "Bash(git push *)"
    ]
  }
}
```

---

## CLAUDE.md 中的路径限制配置

```markdown
# 项目 AI 协作规范

## 允许修改的范围

AI 可以自主修改以下路径：
- `src/features/` — 业务功能代码
- `src/utils/` — 工具函数（不含 auth 相关）
- `docs/` — 文档

## 禁止修改的范围（DENY_LIST）

以下路径 **禁止 AI 自主修改**，必须人工审查：
- `src/config/` — 配置文件（含密钥、端点等）
- `src/auth/` — 认证授权模块
- `**/*.env` — 环境变量文件
- `database/migrations/` — 数据库迁移（不可逆操作）
- `package.json` / `package-lock.json` — 依赖管理
- `.github/workflows/` — CI/CD 流水线

## 修改约束

1. 每次只修改一个功能模块
2. 不得修改超过 200 行代码，超过时请拆分为多个步骤
3. 涉及数据库操作的代码修改必须附带回滚方案

## 输出格式要求

生成代码时，必须以 JSON Patch 格式输出：
```json
{
  "file": "src/utils/validator.ts",
  "operation": "replace",
  "target": "validateEmail function",
  "patch": "..."
}
```
```

---

## AST 级别的修改控制

### 原理

通过解析代码 AST，精确限制 AI 只能修改特定的语法节点（函数、类方法等），而不是修改整个文件。

### TypeScript AST 解析实现

```typescript
import * as ts from 'typescript';
import * as fs from 'fs';

interface AllowedTarget {
  file: string;
  functionName: string;
}

/**
 * 验证 AI 生成的 diff 是否只修改了允许的函数
 */
function validateAIDiff(
  originalCode: string,
  modifiedCode: string,
  allowedTargets: AllowedTarget[],
  filePath: string
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  // 解析原始和修改后的 AST
  const originalAST = ts.createSourceFile(filePath, originalCode, ts.ScriptTarget.Latest);
  const modifiedAST = ts.createSourceFile(filePath, modifiedCode, ts.ScriptTarget.Latest);

  // 提取所有函数节点及其范围
  function extractFunctions(sourceFile: ts.SourceFile): Map<string, { start: number; end: number; text: string }> {
    const functions = new Map();

    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
        const name = (node as any).name?.text || 'anonymous';
        functions.set(name, {
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          text: node.getText(sourceFile),
        });
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return functions;
  }

  const originalFunctions = extractFunctions(originalAST);
  const modifiedFunctions = extractFunctions(modifiedAST);

  // 找出发生变化的函数
  const changedFunctions: string[] = [];
  for (const [name, info] of modifiedFunctions) {
    const original = originalFunctions.get(name);
    if (!original || original.text !== info.text) {
      changedFunctions.push(name);
    }
  }

  // 检查每个变化是否在允许列表中
  const allowedFunctions = allowedTargets
    .filter(t => t.file === filePath)
    .map(t => t.functionName);

  for (const changed of changedFunctions) {
    if (!allowedFunctions.includes(changed)) {
      violations.push(`函数 '${changed}' 不在允许修改列表中`);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// 使用示例
const result = validateAIDiff(
  fs.readFileSync('src/auth/validator.ts', 'utf-8'),
  aiGeneratedCode,
  [{ file: 'src/auth/validator.ts', functionName: 'validateToken' }],
  'src/auth/validator.ts'
);

if (!result.valid) {
  console.error('AI 修改超出允许范围：', result.violations);
  process.exit(1);
}
```

### Python 版本（使用 `ast` 模块）

```python
import ast
import difflib

def get_function_ranges(source: str) -> dict[str, str]:
    """提取所有函数定义"""
    tree = ast.parse(source)
    functions = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            func_lines = source.split('\n')[node.lineno - 1:node.end_lineno]
            functions[node.name] = '\n'.join(func_lines)
    return functions

def validate_diff(
    original: str,
    modified: str,
    allowed_functions: list[str]
) -> tuple[bool, list[str]]:
    """验证修改只涉及允许的函数"""
    orig_funcs = get_function_ranges(original)
    mod_funcs = get_function_ranges(modified)

    violations = []
    for name, code in mod_funcs.items():
        if name in orig_funcs and orig_funcs[name] != code:
            if name not in allowed_functions:
                violations.append(f"函数 '{name}' 被修改但不在允许列表中")

    # 检查是否有新增的非预期函数
    new_funcs = set(mod_funcs.keys()) - set(orig_funcs.keys())
    for name in new_funcs:
        if name not in allowed_functions:
            violations.append(f"新增了未授权函数 '{name}'")

    return len(violations) == 0, violations
```

---

## GitHub Actions 集成

### 自动验证 AI 生成代码的 Diff 范围

```yaml
# .github/workflows/ai-diff-validation.yml
name: AI Diff 范围验证

on:
  pull_request:
    types: [opened, synchronize]
    # 只对带 AI 标签的 PR 触发
    branches: [main, develop]

jobs:
  validate-ai-diff:
    runs-on: ubuntu-latest
    # 只对 AI 生成的 PR 运行（通过 label 区分）
    if: contains(github.event.pull_request.labels.*.name, 'ai-generated')

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # 获取完整历史，用于 diff

      - name: 获取 PR Diff
        id: get-diff
        run: |
          git diff origin/${{ github.base_ref }}...HEAD --name-only > changed_files.txt
          git diff origin/${{ github.base_ref }}...HEAD --stat > diff_stat.txt
          echo "changed_files=$(cat changed_files.txt | tr '\n' ',')" >> $GITHUB_OUTPUT

      - name: 检查禁止修改的文件
        run: |
          DENY_PATTERNS=(
            "src/config/"
            "src/auth/"
            ".env"
            "database/migrations/"
            "package.json"
            ".github/workflows/"
          )

          VIOLATIONS=""
          while IFS= read -r file; do
            for pattern in "${DENY_PATTERNS[@]}"; do
              if [[ "$file" == *"$pattern"* ]]; then
                VIOLATIONS="$VIOLATIONS\n- $file (匹配禁止模式: $pattern)"
              fi
            done
          done < changed_files.txt

          if [ -n "$VIOLATIONS" ]; then
            echo "::error::AI 修改了禁止区域的文件："
            echo -e "$VIOLATIONS"
            exit 1
          fi

      - name: 检查修改行数限制
        run: |
          TOTAL_CHANGES=$(git diff origin/${{ github.base_ref }}...HEAD --shortstat | grep -oP '\d+ insertion' | grep -oP '\d+' || echo 0)
          MAX_CHANGES=300

          if [ "$TOTAL_CHANGES" -gt "$MAX_CHANGES" ]; then
            echo "::error::AI 单次修改行数 ($TOTAL_CHANGES) 超过限制 ($MAX_CHANGES 行)"
            exit 1
          fi

      - name: AST 验证（TypeScript 文件）
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: |
          npm install typescript @types/node
          npx ts-node scripts/validate-ast-diff.ts \
            --base origin/${{ github.base_ref }} \
            --head HEAD \
            --config .ai-diff-rules.json

      - name: 评论 PR（验证报告）
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const diffStat = fs.readFileSync('diff_stat.txt', 'utf-8');

            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## AI Diff 验证报告\n\n\`\`\`\n${diffStat}\n\`\`\``
            });
```

### AI Diff 规则配置文件

```json
// .ai-diff-rules.json
{
  "version": "1.0",
  "rules": {
    "maxChangedLines": 300,
    "maxChangedFiles": 10,
    "denyPaths": [
      "src/config/**",
      "src/auth/**",
      "**/*.env",
      "database/migrations/**",
      "package.json",
      ".github/workflows/**"
    ],
    "allowPaths": [
      "src/features/**",
      "src/utils/**",
      "docs/**"
    ],
    "requireReview": {
      "paths": ["src/api/**", "src/models/**"],
      "reviewers": ["@team/backend-leads"]
    }
  }
}
```

---

## 只读模式 + Patch 审查工作流

```bash
# 1. AI 生成 patch 文件而非直接修改
# 在提示词中要求 AI 输出 unified diff 格式

# 2. 查看 patch 内容
cat ai-generated.patch

# 3. 人工审查 diff
git apply --check ai-generated.patch  # 检查是否可应用
git diff --stat ai-generated.patch    # 查看影响范围

# 4. 选择性应用
git apply ai-generated.patch          # 应用
# 或
git apply --reject ai-generated.patch  # 跳过冲突部分，生成 .rej 文件
```

---

## 相关文档

- [ai-codegen-logic-errors-analysis.md](./ai-codegen-logic-errors-analysis.md) — AI 代码逻辑错误分析
