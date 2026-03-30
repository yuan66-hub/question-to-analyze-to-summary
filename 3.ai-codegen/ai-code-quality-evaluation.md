# AI 代码质量评估：有效代码与冗余代码比例

## 概述

在使用 AI 生成代码时，如何科学评估代码质量、识别冗余代码，是提升工程交付质量的关键问题。本文档提供一套可操作的评估框架。

---

## 一、代码分类定义

### 1.1 有效代码

有效代码指直接承载业务价值、不可缺失的代码，具有以下特征：

| 特征 | 说明 |
|------|------|
| 业务逻辑承载 | 直接实现功能需求 |
| 不可删除性 | 删除会导致功能缺失 |
| 可测试性 | 有明确输入输出可验证 |
| 意图清晰 | 无需额外注释解释"做什么" |

### 1.2 冗余代码

冗余代码指不直接承载当前业务价值、可安全删除的代码，分为以下类型：

| 类型 | 描述 | 影响 |
|------|------|------|
| 死代码 (Dead Code) | 永远不会被调用的函数/变量 | 维护负担、构建膨胀 |
| 重复代码 (Duplication) | 多次出现的相似逻辑 | 修改遗漏风险 |
| 注释代码 (Commented Code) | 被注释掉的旧实现 | 混淆视听 |
| 过度抽象 (Over-abstraction) | 为未来需求预留的扩展点 | 不必要的复杂度 |
| 无效注释 | 重复描述"做什么"而非"为什么" | 噪音 |

---

## 二、量化评估指标

### 2.1 核心指标

| 指标 | 计算公式 | 建议阈值 | 测量工具 |
|------|---------|---------|---------|
| 代码删除率 | 删除行数 / 总行数 | < 15% | git diff |
| 重复率 | 重复代码块数 / 总代码块数 | < 5% 优秀 | PMD, Simian |
| 超长函数占比 | 超长函数(>50行)数 / 总函数数 | < 10% | ESLint, SonarQube |
| 圈复杂度均值 | 所有函数复杂度之和 / 函数数 | < 10 | SonarQube |
| 注释比 | 注释行 / 总行数 | 10-20% | 静态分析工具 |

### 2.2 AI 生成代码专项指标

AI 生成的代码有其特殊性，需额外关注：

| 指标 | 问题表现 | 处理建议 |
|------|---------|---------|
| 过度错误处理 | 对不可能发生的错误进行捕获 | 评估实际风险后精简 |
| 防御性编程冗余 | 多次重复的参数校验 | 抽取公共校验函数 |
| 显而易见注释 | "这是一个函数"类注释 | 删除或改为 Why 注释 |
| 过度抽象层 | 为通用性预留的接口/基类 | 按需实现，非提前设计 |

---

## 三、评估方法

### 3.1 工具层面

```
静态分析 → 复杂度分析 → 重复检测 → 依赖分析
```

| 阶段 | 工具推荐 |
|------|---------|
| 静态分析 | ESLint, SonarQube, CodeClimate |
| 复杂度分析 | SonarQube, ESLint (complexity rule) |
| 重复检测 | PMD CPD, Simian, deep-code-analysis |
| 依赖分析 | dependency-cruiser, madge |

### 3.2 人工层面

| 场景 | 关注点 |
|------|-------|
| Code Review | 删除建议的数量和比例 |
| 需求变更 | 涉及代码范围 vs 影响范围 |
| Bug 修复 | 修复问题所需的代码理解成本 |
| 重构清理 | 每次重构的可删除代码量 |

---

## 四、质量门禁建议

### 4.1 CI/CD 集成

建议在 AI 生成代码的 PR 中设置以下质量门禁：

```yaml
quality_gates:
  - 重复率 > 5% → Block
  - 超长函数 > 10 个 → Warning
  - 圈复杂度均值 > 15 → Warning
  - 死代码检测发现 > 3 处 → Warning
```

### 4.2 评审 Checklist

- [ ] 是否有永远不会被调用的代码路径？
- [ ] 是否有可以抽象复用的重复逻辑？
- [ ] 注释掉的代码是否有保留价值？
- [ ] 抽象是否服务于当前需求，还是过度设计？
- [ ] 注释是否在解释"Why"而非"What"？

---

## 五、持续改进

### 5.1 度量趋势

建议跟踪以下趋势指标（按周/月）：

1. 冗余代码比例趋势
2. AI 生成代码的首次提交通过率
3. Code Review 中的删除建议采纳率
4. 重复代码消除带来的代码行数变化

### 5.2 反馈闭环

```
AI 生成代码 → 质量评估 → 识别冗余 → 清理 → 反馈规则优化 → AI 生成改进
```

---

## 六、SAST 安全静态分析集成

### Semgrep 集成（推荐）

```yaml
# .github/workflows/sast.yml
name: SAST 安全扫描

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  semgrep:
    runs-on: ubuntu-latest
    container:
      image: returntocorp/semgrep

    steps:
      - uses: actions/checkout@v4

      - name: Semgrep 扫描
        run: |
          semgrep ci \
            --config=p/security-audit \
            --config=p/owasp-top-ten \
            --config=p/javascript \
            --config=p/typescript \
            --json-output=semgrep-results.json \
            --severity=ERROR \
            --severity=WARNING

      - name: 上传扫描结果
        uses: actions/upload-artifact@v4
        with:
          name: semgrep-results
          path: semgrep-results.json

      - name: 评论 PR
        if: github.event_name == 'pull_request'
        run: |
          # 解析 semgrep-results.json 并生成摘要
          ERRORS=$(cat semgrep-results.json | jq '.results | length')
          echo "发现 $ERRORS 个安全问题"
```

### 自定义规则示例

```yaml
# .semgrep/ai-codegen-rules.yml
rules:
  - id: no-sql-injection-template-literal
    pattern: |
      const query = `SELECT * FROM ... WHERE ... ${...}`;
    message: "潜在 SQL 注入：不要将变量直接插入 SQL 字符串"
    languages: [javascript, typescript]
    severity: ERROR

  - id: no-hardcoded-secrets
    patterns:
      - pattern: |
          const $API_KEY = "sk-..."
      - pattern: |
          const $PASSWORD = "..."
    message: "不要在代码中硬编码密钥或密码"
    languages: [javascript, typescript]
    severity: ERROR

  - id: jwt-algorithm-none
    pattern: jwt.verify($TOKEN, $SECRET, { algorithms: ["none"] })
    message: "JWT 不应使用 none 算法"
    languages: [javascript, typescript]
    severity: ERROR
```

### CodeQL 集成（GitHub 原生）

```yaml
# .github/workflows/codeql.yml
name: CodeQL 分析

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  analyze:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        language: [javascript, typescript]

    steps:
      - uses: actions/checkout@v4

      - name: 初始化 CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: ${{ matrix.language }}
          queries: security-extended  # 包含更多安全规则

      - name: 自动构建
        uses: github/codeql-action/autobuild@v3

      - name: 执行 CodeQL 分析
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:${{ matrix.language }}"
```

---

## 七、完整 CI/CD 质量门禁

```yaml
# .github/workflows/ai-code-quality.yml
name: AI 代码质量门禁

on:
  pull_request:
    types: [opened, synchronize]
    labels: [ai-generated]

jobs:
  quality-gate:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      # 1. ESLint 代码规范
      - name: ESLint
        run: npx eslint src/ --max-warnings=10 --format=json > eslint-results.json || true

      # 2. 重复代码检测
      - name: 重复代码检测 (jscpd)
        run: |
          npx jscpd src/ \
            --min-lines=10 \
            --threshold=5 \
            --reporters=json \
            --output=./reports/jscpd/
          # 重复率超 5% 则失败
          CLONE_PERCENTAGE=$(cat reports/jscpd/jscpd-report.json | jq '.statistics.total.percentage')
          echo "重复率: $CLONE_PERCENTAGE%"
          [ $(echo "$CLONE_PERCENTAGE > 5" | bc) -eq 1 ] && exit 1 || true

      # 3. 圈复杂度
      - name: 圈复杂度检查
        run: |
          npx complexity-report src/ --format=json > complexity.json
          # 平均复杂度 > 10 则警告
          AVG_COMPLEXITY=$(cat complexity.json | jq '.averageCyclomatic')
          echo "平均圈复杂度: $AVG_COMPLEXITY"

      # 4. 测试覆盖率
      - name: 单元测试 + 覆盖率
        run: |
          npx jest --coverage --coverageThreshold='{"global":{"lines":70}}'

      # 5. TypeScript 类型检查
      - name: TypeScript 类型检查
        run: npx tsc --noEmit

      # 6. SAST（Semgrep）
      - name: Semgrep 安全扫描
        uses: returntocorp/semgrep-action@v1
        with:
          config: >-
            p/security-audit
            p/owasp-top-ten
          auditOn: push

      # 7. 汇总报告
      - name: 生成质量报告
        if: always()
        run: |
          echo "## AI 代码质量报告" >> $GITHUB_STEP_SUMMARY
          echo "| 检查项 | 状态 |" >> $GITHUB_STEP_SUMMARY
          echo "|--------|------|" >> $GITHUB_STEP_SUMMARY
          echo "| ESLint | $([ -f eslint-results.json ] && echo '✅' || echo '❌') |" >> $GITHUB_STEP_SUMMARY
```

---

## 附录：参考工具链

| 类别 | 工具 | 适用语言 |
|------|------|---------|
| 静态分析 | ESLint, SonarQube, CodeClimate | JS/TS, Java, Python |
| 安全扫描 | Semgrep, CodeQL, Snyk | 多语言 |
| 重复检测 | PMD CPD, jscpd, Simian | 多语言 |
| 复杂度 | SonarQube, lizard, complexity-report | 多语言 |
| 依赖分析 | dependency-cruiser, madge | JS/TS |
| 测试覆盖 | Jest, pytest, JUnit | 多语言 |
