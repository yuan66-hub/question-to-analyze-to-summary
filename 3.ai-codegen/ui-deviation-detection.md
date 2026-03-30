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

## Storybook + Chromatic 集成

### 为什么选择 Storybook + Chromatic

- **Storybook**：隔离组件故事，为每个状态生成独立截图
- **Chromatic**：基于 Storybook 的云端视觉回归服务，自动管理基准快照版本

```bash
# 安装
npm install --save-dev @chromatic-com/storybook chromatic

# 首次发布基准快照
npx chromatic --project-token=<your-token> --auto-accept-changes
```

```yaml
# .github/workflows/chromatic.yml
name: Chromatic 视觉回归

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  chromatic:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # 需要完整历史来比对

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - name: 运行 Chromatic
        uses: chromaui/action@latest
        with:
          projectToken: ${{ secrets.CHROMATIC_PROJECT_TOKEN }}
          exitZeroOnChanges: false  # 检测到变化时 CI 失败，需要人工确认
          onlyChanged: true         # 只测试受代码变更影响的故事
          autoAcceptChanges: "main" # main 分支自动接受（更新基准）
```

### 组织 Storybook Stories

```typescript
// Button.stories.tsx
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  component: Button,
  // 为视觉回归定义多个状态
  parameters: {
    chromatic: {
      modes: {
        light: { backgrounds: { value: '#fff' } },
        dark: { backgrounds: { value: '#1a1a1a' } },
        mobile: { viewport: { width: 375 } },
        desktop: { viewport: { width: 1440 } },
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

// 每个 Story = 一个视觉测试用例
export const Default: Story = { args: { label: '提交' } };
export const Loading: Story = { args: { label: '提交', loading: true } };
export const Disabled: Story = { args: { label: '提交', disabled: true } };
export const Danger: Story = { args: { label: '删除', variant: 'danger' } };
```

---

## AI 驱动的语义视觉比对（Applitools）

### 与像素比对的区别

| 比对方式 | 对什么敏感 | 假阳性率 |
|---------|-----------|---------|
| 像素比对 | 任何像素变化（含字体渲染差异） | 高 |
| **AI 语义比对** | 视觉内容变化（忽略渲染噪音） | 低 |

### Applitools Eyes 集成

```javascript
const { Eyes, Target, Configuration, BatchInfo } = require('@applitools/eyes-playwright');

async function runVisualTest() {
  const eyes = new Eyes();

  const config = new Configuration();
  config.setBatch(new BatchInfo('AI 生成 UI 验证'));
  config.setMatchLevel('STRICT'); // 语义匹配级别

  eyes.setConfiguration(config);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await eyes.open(page, 'MyApp', 'Homepage Test');

    await page.goto('http://localhost:3000');

    // 全页面截图 + AI 语义比对
    await eyes.check('Homepage', Target.window().fully());

    // 区域比对
    await eyes.check('Header', Target.region(page.locator('header')));

    await eyes.closeAsync();
  } finally {
    await eyes.abortAsync();
    await browser.close();
  }
}
```

---

## 响应式多断点检测策略

### 自动化多断点截图

```javascript
const BREAKPOINTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'wide', width: 1920, height: 1080 },
];

async function captureAllBreakpoints(url: string, outputDir: string) {
  const browser = await chromium.launch();
  const results = [];

  for (const bp of BREAKPOINTS) {
    const context = await browser.newContext({
      viewport: { width: bp.width, height: bp.height },
    });
    const page = await context.newPage();
    await page.goto(url);

    // 等待动画完成
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      // 禁用 CSS 动画，避免截图不稳定
      const style = document.createElement('style');
      style.textContent = '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }';
      document.head.appendChild(style);
    });

    const screenshotPath = `${outputDir}/${bp.name}-${bp.width}x${bp.height}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    results.push({ breakpoint: bp, path: screenshotPath });

    await context.close();
  }

  await browser.close();
  return results;
}

// 对比所有断点
async function compareAllBreakpoints(baselineDir: string, currentDir: string) {
  const report = [];

  for (const bp of BREAKPOINTS) {
    const filename = `${bp.name}-${bp.width}x${bp.height}.png`;
    const { diffRatio } = await detectUI偏差(
      `${baselineDir}/${filename}`,
      `${currentDir}/${filename}`
    );

    report.push({
      breakpoint: bp.name,
      diffRatio: (diffRatio * 100).toFixed(2) + '%',
      passed: diffRatio < 0.01, // 差异 < 1% 视为通过
    });
  }

  return report;
}
```

---

## 基准图像版本管理

### Git LFS 管理截图基准

```bash
# 初始化 Git LFS
git lfs install

# 追踪截图文件
git lfs track "tests/screenshots/baseline/*.png"
git lfs track "tests/screenshots/baseline/**/*.png"

# 提交 .gitattributes
git add .gitattributes
git commit -m "chore: 配置 Git LFS 追踪视觉回归基准截图"
```

### 基准更新工作流

```bash
# 1. 确认 UI 变更是符合预期的（人工审查）
# 2. 更新基准截图
npm run test:visual -- --update-snapshots

# 3. 提交新基准（通过 Git LFS 存储）
git add tests/screenshots/baseline/
git commit -m "chore: 更新视觉回归基准（含响应式重构变更）"

# 4. 推送到远程
git push
```

### 基准版本回退

```bash
# 查看截图历史
git log --oneline tests/screenshots/baseline/Button.png

# 回退到指定版本
git checkout <commit-hash> -- tests/screenshots/baseline/Button.png
```

---

## 关键原则

> **AI 生成 UI → 自动化视觉检测 → 精准修复 → 再次验证**

视觉回归测试是保障 AI 生成代码质量的最后一道防线，与 diff 级别控制形成闭环。

---

## 相关文档

- [ai-code-diff-control.md](./ai-code-diff-control.md) — AI 代码 Diff 级别控制
- [ai-codegen-logic-errors-analysis.md](./ai-codegen-logic-errors-analysis.md) — AI 代码逻辑错误分析
