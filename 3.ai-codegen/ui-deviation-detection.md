# UI 偏差检测方法

## 问题

AI 生成代码后，UI 可能出现视觉或布局偏差，需要自动化检测。

---

## 检测方案

### 1. 视觉回归测试 (Visual Regression Testing)

| 方法 | 工具 | 原理 |
|------|------|------|
| 截图逐像素比对 | Percy, Chromatic, Loki | 拍摄基准截图，与新截图逐像素 Diff |
| 区域差异高亮 | pixelmatch, jest-image-snapshot | 标记出具体差异区域 |
| 视频帧对比 | Playwright + FFmpeg | 动态 UI 变化录制对比 |

### 2. DOM / Layout 检测

| 方法 | 工具 | 原理 |
|------|------|------|
| CLS 监测 | web-vitals | Cumulative Layout Shift 量化布局稳定性 |
| DOM 结构对比 | jest-axe | 对比渲染后的 DOM 树结构差异 |
| Computed Style 检测 | CSS regression tests | 检查 computed styles 变化 |

### 3. 自动化检测流程

```
AI 修改代码 → 触发构建 → Playwright 截图 → 与基准图 Diff → 报告偏差率 → 人工确认
```

**实现示例 (Playwright + pixelmatch):**

```javascript
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

async function detectUI偏差(page, baselinePath, currentPath) {
  await page.goto('http://localhost:3000');
  await page.screenshot({ path: currentPath });

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
  const img2 = PNG.sync.read(fs.readFileSync(currentPath));
  const diff = new PNG(img1.width, img1.height);

  const numDiffPixels = pixelmatch(img1, img2, diff, {
    threshold: 0.1,
    alpha: 0.5
  });

  const diffRatio = numDiffPixels / (img1.width * img1.height);
  return { diffRatio, numDiffPixels, diff };
}
```

### 4. CI 集成

```yaml
# .github/workflows/visual-regression.yml
- name: UI 偏差检测
  run: |
    npx playwright install
    npx playwright test --reporter=list
    npx pixelmatch tests/screenshots/baseline/*.png tests/screenshots/current/*.png tests/screenshots/diff/
```

---

## 与 AI Diff 控制结合

| 阶段 | 做法 |
|------|------|
| AI 生成代码前 | 用 git worktree 隔离修改范围 |
| AI 生成代码后 | 触发 UI 自动化检测 |
| 检测出偏差 | 结合 diff 控制，只让 AI 修复特定组件 |
| 人工复核 | 确认最终 UI是否符合预期 |

---

## 关键原则

> **AI 生成 UI → 自动化视觉检测 → 精准修复 → 再次验证**

视觉回归测试是保障 AI 生成代码质量的最后一道防线，与 diff 级别控制形成闭环。

---

## 相关文档

- [ai-code-diff-control.md](./ai-code-diff-control.md) — AI 代码 Diff 级别控制
- [ai-codegen-logic-errors-analysis.md](./ai-codegen-logic-errors-analysis.md) — AI 代码逻辑错误分析
