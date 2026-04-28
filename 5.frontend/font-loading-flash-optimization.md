# 字体包过大与字体闪烁优化工程方案

## 一、问题背景

字体闪烁通常不是单一问题，而是字体文件体积、字体加载时机、CSS 阻塞、fallback 字体差异和缓存策略共同作用的结果。

常见现象包括：

- **FOIT**（Flash of Invisible Text）：字体加载期间文字不可见，用户看到空白文本。
- **FOUT**（Flash of Unstyled Text）：先显示 fallback 字体，Web Font 加载完成后切换，用户看到字体闪动。
- **布局跳动**：目标字体和 fallback 字体的字宽、行高、基线不同，切换后文本重新排版。
- **首屏变慢**：字体文件过大、跨域字体缺少预连接或缓存命中率低，拖慢 LCP 和首屏渲染。

工程目标不是“完全不闪”，而是在性能、品牌一致性和可用性之间建立稳定策略：

1. 首屏文字必须尽快可见。
2. 字体切换不能造成明显布局跳动。
3. 字体文件体积、数量和加载优先级可控。
4. 关键字体可被长期缓存，发布后可灰度和回滚。

---

## 二、问题定位与指标

### 1. 先确认闪烁类型

使用 Chrome DevTools 定位：

1. 打开 DevTools → Network → 勾选 `Disable cache`。
2. 将网络切到 `Fast 3G` 或 `Slow 4G`。
3. 刷新页面，观察首屏文本：
   - 文字先空白再出现：偏 FOIT。
   - 文字先用系统字体显示，再变成品牌字体：偏 FOUT。
   - 字体变化时页面内容上下抖动：fallback 指标不一致。
4. 在 Network 中筛选 `font`，查看字体资源的数量、大小、协议、缓存和加载时机。

### 2. 建议关注的性能指标

| 指标 | 目标 | 说明 |
|---|---:|---|
| 单个字体文件 gzip/brotli 后大小 | 英文字体 `< 50KB`，中文子集按场景控制 | 全量中文字体往往非常大，应避免首屏加载 |
| 首屏字体请求数 | `1-2` 个 | 字重、语言、图标字体都可能增加请求 |
| LCP | `< 2.5s` | 字体阻塞文本渲染会影响 LCP |
| CLS | `< 0.1` | 字体切换导致排版变化会增加 CLS |
| 字体缓存命中率 | 越高越好 | 字体属于强缓存资源，应该长期缓存 |

### 3. 快速排查清单

```bash
# 查看构建产物中的字体文件
du -h dist/assets/*.{woff,woff2,ttf,otf} 2>/dev/null

# 查看字体资源是否被 gzip/brotli 压缩
curl -I https://example.com/fonts/brand.woff2

# 查看缓存头
curl -I https://example.com/fonts/brand.woff2 | grep -i cache-control
```

Windows PowerShell 可使用：

```powershell
Get-ChildItem -Recurse dist -Include *.woff,*.woff2,*.ttf,*.otf |
  Select-Object FullName, Length |
  Sort-Object Length -Descending
```

---

## 三、总体治理策略

推荐按优先级分层治理：

1. **不用不必要的字体**：正文优先使用系统字体，品牌字体只用于关键视觉区域。
2. **减少字体文件体积**：只保留必要字重、格式和字符集。
3. **控制字体加载策略**：通过 `font-display`、`preload`、`preconnect` 管理渲染行为。
4. **降低字体切换影响**：选择相近 fallback，必要时用字体指标覆盖。
5. **建立工程约束**：体积预算、CI 检查、缓存策略、监控指标和回滚方案。

---

## 四、方案一：使用系统字体替代大体积字体

### 适用场景

- 中文正文内容较多。
- 品牌对正文字体要求不强。
- 当前加载了全量中文字体，例如思源黑体、阿里巴巴普惠体全字符集。
- 移动端或弱网环境下字体闪烁明显。

### 实施方式

将正文统一改为系统字体栈：

```css
:root {
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}

body {
  font-family: var(--font-sans);
}
```

中文站点推荐策略：

- 正文、表格、表单、弹窗使用系统字体。
- Logo、活动页标题、品牌视觉模块使用自定义字体。
- 不要为了正文统一视觉而首屏加载全量中文字体。

### 优点

- 不需要额外字体请求。
- 无字体加载闪烁。
- 兼容性好，维护成本最低。

### 风险

- 不同系统显示效果略有差异。
- 品牌一致性弱于自定义字体。

### 验收标准

- Network 面板首屏没有正文 Web Font 请求。
- 首屏文本无 FOIT。
- CLS 不因字体切换上升。

---

## 五、方案二：字体格式治理，只保留 WOFF2

### 适用场景

- 项目同时引入了 `.ttf`、`.otf`、`.woff`、`.woff2`。
- 历史兼容包未清理。
- 字体文件体积异常大。

### 实施方式

优先使用 `woff2`：

```css
@font-face {
  font-family: "BrandFont";
  src: url("/fonts/brand-regular.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

不推荐：

```css
@font-face {
  font-family: "BrandFont";
  src:
    url("/fonts/brand.woff2") format("woff2"),
    url("/fonts/brand.woff") format("woff"),
    url("/fonts/brand.ttf") format("truetype");
}
```

现代浏览器已普遍支持 WOFF2。除非项目明确要求兼容非常老的浏览器，否则不需要同时下发多格式字体。

### 构建侧处理

如果字体在源码中通过 import 引入：

```js
import "./fonts.css";
```

需要确认打包产物中只保留实际被 CSS 引用的字体文件。对于 Vite、Webpack、Rollup，未引用文件通常不会进入产物；如果放在 `public/`，则需要人工清理历史文件。

### 验收标准

- 线上字体资源只包含 `.woff2`。
- 单个字体文件大小明显下降。
- 没有重复下载同一字体不同格式。

---

## 六、方案三：按字重、样式拆分并删除无用字重

### 适用场景

- 同时加载 `100-900` 多个字重。
- 实际页面只用到 `400`、`500`、`700`。
- 字体文件按字重分包后请求数过多。

### 实施步骤

1. 全局搜索 `font-weight`：

```bash
rg "font-weight|font:" src
```

2. 统计真实使用的字重。
3. 与设计规范确认允许的字重集合。
4. 只保留必要字重。

推荐配置：

```css
@font-face {
  font-family: "BrandFont";
  src: url("/fonts/brand-regular.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "BrandFont";
  src: url("/fonts/brand-medium.woff2") format("woff2");
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "BrandFont";
  src: url("/fonts/brand-bold.woff2") format("woff2");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
```

如果设计上允许，可进一步减少为：

```css
@font-face {
  font-family: "BrandFont";
  src: url("/fonts/brand-variable.woff2") format("woff2");
  font-weight: 400 700;
  font-style: normal;
  font-display: swap;
}
```

可变字体不一定总是更小。它适合多字重场景；如果只用一个字重，单字重 WOFF2 通常更划算。

### 验收标准

- 首屏字体请求数控制在 `1-2` 个。
- 未使用字重不再出现在 Network 字体请求中。
- 设计稿主要字号和字重渲染一致。

---

## 七、方案四：字体子集化

### 适用场景

- 字体包含大量不会使用的字符。
- 只在标题、数字、品牌词中使用自定义字体。
- 中文字体体积过大。

### 子集化策略

按业务场景拆分：

| 字体用途 | 子集策略 |
|---|---|
| 英文品牌字体 | 保留 `A-Z`、`a-z`、数字、常用符号 |
| 数字字体 | 保留 `0-9`、货币符号、百分号、小数点 |
| 活动页标题 | 保留固定文案字符 |
| 中文正文 | 不建议全量自定义字体，优先系统字体 |
| 多语言站点 | 按语言拆分字体文件 |

### 使用 fonttools 生成子集

安装：

```bash
pip install fonttools brotli
```

生成英文和数字子集：

```bash
pyftsubset BrandFont.ttf \
  --output-file=brand-latin.woff2 \
  --flavor=woff2 \
  --unicodes=U+0020-007E \
  --layout-features='*' \
  --name-IDs='*' \
  --glyph-names \
  --symbol-cmap
```

生成指定文案子集：

```bash
pyftsubset BrandFont.ttf \
  --output-file=brand-slogan.woff2 \
  --flavor=woff2 \
  --text="限时优惠新品上市立即购买" \
  --layout-features='*'
```

### 使用 unicode-range 分段加载

```css
@font-face {
  font-family: "BrandFont";
  src: url("/fonts/brand-latin.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0020-007E;
}

@font-face {
  font-family: "BrandFont";
  src: url("/fonts/brand-cjk-common.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: optional;
  unicode-range: U+4E00-9FFF;
}
```

浏览器只会在页面实际出现对应 unicode 字符时请求该字体分片。

### 工程注意事项

- 子集化必须保留必要 OpenType 特性，否则可能影响连字、标点、字距。
- 动态内容不要使用过窄的固定文案子集，否则会缺字。
- CMS、用户输入、国际化文本应使用语言级子集或系统字体。
- 子集文件名要带 hash，避免缓存污染。

### 验收标准

- 子集字体覆盖页面实际字符，无乱码、方块字。
- 未出现的语言分片不会被请求。
- 字体总体下载体积明显降低。

---

## 八、方案五：font-display 控制字体显示策略

### 核心配置

```css
@font-face {
  font-family: "BrandFont";
  src: url("/fonts/brand-regular.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

### 取值选择

| 值 | 行为 | 适用场景 |
|---|---|---|
| `block` | 短时间隐藏文本，等待字体 | 不推荐，容易 FOIT |
| `swap` | 立即显示 fallback，加载后切换 | 品牌字体重要，允许轻微 FOUT |
| `fallback` | 短暂等待，超时后 fallback | 希望减少长时间等待 |
| `optional` | 网络差时放弃 Web Font | 正文、弱网、非关键字体 |

推荐策略：

- 正文：`font-display: optional` 或直接系统字体。
- 品牌标题：`font-display: swap`。
- 图标字体：尽量迁移 SVG；如不能迁移，避免 `block`。
- 首屏核心品牌字体：`swap + preload`。

### 典型落地

```css
/* 正文：允许弱网直接使用系统字体 */
@font-face {
  font-family: "ContentFont";
  src: url("/fonts/content-subset.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: optional;
}

/* 品牌标题：优先保持品牌表现 */
@font-face {
  font-family: "BrandFont";
  src: url("/fonts/brand-title.woff2") format("woff2");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
```

### 验收标准

- 不再出现长时间文字空白。
- 弱网下页面可读性稳定。
- 字体切换符合业务对品牌一致性的要求。

---

## 九、方案六：预加载首屏关键字体

### 适用场景

- 首屏 LCP 文本使用了自定义字体。
- 字体文件发现较晚，例如 CSS 下载解析后才发现字体。
- 字体来自 CDN 或跨域静态域名。

### HTML 配置

```html
<link
  rel="preload"
  href="/fonts/brand-title.woff2"
  as="font"
  type="font/woff2"
  crossorigin
>
```

如果字体在 CDN：

```html
<link rel="preconnect" href="https://static.example.com" crossorigin>
<link
  rel="preload"
  href="https://static.example.com/fonts/brand-title.woff2"
  as="font"
  type="font/woff2"
  crossorigin
>
```

### 注意事项

- 只 preload 首屏必需字体。
- `href` 必须和 CSS 中实际字体 URL 完全一致。
- 跨域字体必须加 `crossorigin`，否则可能重复下载。
- 不要 preload 非首屏字重和语言分片。

### Next.js 示例

如果使用 Next.js App Router，可优先使用 `next/font`：

```tsx
import localFont from "next/font/local";

const brandFont = localFont({
  src: "../public/fonts/brand-title.woff2",
  display: "swap",
  preload: true,
  variable: "--font-brand",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={brandFont.variable}>
      <body>{children}</body>
    </html>
  );
}
```

CSS 使用：

```css
.hero-title {
  font-family: var(--font-brand), system-ui, sans-serif;
}
```

### Vite / React 示例

在 `index.html` 中声明：

```html
<link
  rel="preload"
  href="/fonts/brand-title.woff2"
  as="font"
  type="font/woff2"
  crossorigin
>
```

在全局 CSS 中声明：

```css
@font-face {
  font-family: "BrandFont";
  src: url("/fonts/brand-title.woff2") format("woff2");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
```

### 验收标准

- 关键字体请求在 Network 中提前出现。
- 字体没有被重复下载。
- LCP 文本渲染时间改善或保持稳定。

---

## 十、方案七：优化 fallback 字体，降低布局跳动

### 适用场景

- 使用 `font-display: swap` 后文本明显跳动。
- 字体切换导致按钮宽度、标题换行、列表高度变化。
- CLS 异常升高。

### 基础做法

选择和目标字体更接近的 fallback：

```css
.title {
  font-family: "BrandFont", "Arial", sans-serif;
}
```

中文字体建议：

```css
body {
  font-family: "BrandFont", "PingFang SC", "Microsoft YaHei", sans-serif;
}
```

### 使用 CSS 字体指标覆盖

现代浏览器支持通过 `size-adjust`、`ascent-override`、`descent-override`、`line-gap-override` 调整 fallback 字体指标。

```css
@font-face {
  font-family: "BrandFallback";
  src: local("Arial");
  size-adjust: 102%;
  ascent-override: 92%;
  descent-override: 24%;
  line-gap-override: 0%;
}

.title {
  font-family: "BrandFont", "BrandFallback", sans-serif;
}
```

### 落地方法

1. 截取目标字体加载前后的文本区域。
2. 对比文本宽度、行高和换行。
3. 逐步调整 `size-adjust`，先让文本宽度接近。
4. 再调整 `ascent-override`、`descent-override`，减少上下跳动。
5. 用 Lighthouse 或 Web Vitals 验证 CLS。

### 验收标准

- 字体加载完成后文本不明显换行。
- 首屏 CLS 保持 `< 0.1`。
- 关键按钮、价格、导航不因字体切换改变尺寸。

---

## 十一、方案八：图标字体迁移为 SVG

### 适用场景

- 项目使用 iconfont。
- 图标字体文件体积大。
- 图标加载失败时出现方块、乱码或闪烁。

### 推荐方案

优先使用 SVG Symbol 或组件化 SVG。

SVG Symbol：

```html
<svg aria-hidden="true" style="display: none">
  <symbol id="icon-search" viewBox="0 0 24 24">
    <path d="M21 21l-4.35-4.35" />
  </symbol>
</svg>

<svg class="icon" aria-hidden="true">
  <use href="#icon-search" />
</svg>
```

React 组件：

```tsx
export function SearchIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}
```

### 优点

- 不受字体加载影响。
- 可以按需打包。
- 可访问性和样式控制更清晰。
- 避免 iconfont 字体映射变更导致图标错乱。

### 验收标准

- 首屏不再请求 iconfont 字体。
- 图标无闪烁、无方块字。
- 未使用图标不会进入主包。

---

## 十二、方案九：缓存与 CDN 策略

### 字体资源缓存头

字体文件应使用 hash 文件名并长期缓存：

```http
Cache-Control: public, max-age=31536000, immutable
```

HTML 不应长期强缓存：

```http
Cache-Control: no-cache
```

### Nginx 示例

```nginx
location ~* \.(woff2)$ {
  add_header Cache-Control "public, max-age=31536000, immutable";
  add_header Access-Control-Allow-Origin "*";
  types {
    font/woff2 woff2;
  }
}
```

如果字体跨域加载，需要确认：

```http
Access-Control-Allow-Origin: *
```

或限制为业务域名：

```http
Access-Control-Allow-Origin: https://www.example.com
```

### CDN 注意事项

- 字体文件必须带内容 hash，例如 `brand-title.8f3a1c.woff2`。
- CDN 缓存清理只针对异常版本，正常发布依赖 hash 换 URL。
- 字体响应头需要包含正确 `Content-Type`。
- 跨域字体要和 `preload crossorigin` 配套。

### 验收标准

- 第二次访问字体从 memory cache、disk cache 或 CDN cache 命中。
- 字体更新后不会出现新旧版本缓存混乱。
- 跨域字体没有 CORS 报错。

---

## 十三、方案十：延迟加载非关键字体

### 适用场景

- 非首屏页面、弹窗、图表、活动模块使用特殊字体。
- 字体只在用户交互后出现。
- 首屏不应该为低频模块加载字体。

### CSS 分层

将非关键字体声明放到异步样式中：

```js
async function openCampaignModal() {
  await import("./campaign-font.css");
  await import("./CampaignModal");
}
```

`campaign-font.css`：

```css
@font-face {
  font-family: "CampaignFont";
  src: url("/fonts/campaign.woff2") format("woff2");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
```

### 交互前预取

```js
const preloadCampaignFont = () => {
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = "/fonts/campaign.woff2";
  link.as = "font";
  link.type = "font/woff2";
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);
};

button.addEventListener("mouseenter", preloadCampaignFont, { once: true });
```

### 验收标准

- 首屏不加载非关键字体。
- 用户打开模块前可按需预取。
- 交互路径没有明显字体空白。

---

## 十四、构建与 CI 约束

### 1. 字体体积预算

建议在工程中定义预算：

| 资源 | 建议预算 |
|---|---:|
| 首屏字体总大小 | `< 100KB` |
| 单个英文字体 | `< 50KB` |
| 数字字体 | `< 20KB` |
| 首屏字体请求数 | `<= 2` |

### 2. CI 检查脚本示例

创建 `scripts/check-font-size.js`：

```js
const fs = require("fs");
const path = require("path");

const distDir = path.resolve(__dirname, "../dist");
const limit = 100 * 1024;
const fontExts = new Set([".woff2", ".woff", ".ttf", ".otf"]);

function walk(dir, files = []) {
  for (const item of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      walk(fullPath, files);
    } else if (fontExts.has(path.extname(fullPath))) {
      files.push({ path: fullPath, size: stat.size });
    }
  }

  return files;
}

const fonts = walk(distDir);
const total = fonts.reduce((sum, file) => sum + file.size, 0);

for (const font of fonts) {
  console.log(`${font.path}: ${(font.size / 1024).toFixed(2)}KB`);
}

if (total > limit) {
  console.error(`Font budget exceeded: ${(total / 1024).toFixed(2)}KB`);
  process.exit(1);
}
```

在 `package.json` 中接入：

```json
{
  "scripts": {
    "check:font-size": "node scripts/check-font-size.js"
  }
}
```

### 3. PR 检查项

字体相关 PR 必须说明：

- 新增字体用途。
- 新增字体大小。
- 是否为首屏字体。
- 是否使用 WOFF2。
- 是否配置 `font-display`。
- 是否具备缓存策略。
- 是否影响 LCP、CLS。

---

## 十五、推荐落地路线

### 阶段一：快速止血

目标：减少明显 FOIT、FOUT 和首屏等待。

1. 正文字体切换为系统字体。
2. 所有 `@font-face` 增加 `font-display`。
3. 首屏关键字体增加 `preload`。
4. 删除未使用的字体格式和字重。
5. 字体文件开启长期缓存。

预期收益：

- 文本更快可见。
- 字体下载体积下降。
- 弱网闪烁和空白问题明显缓解。

### 阶段二：体积治理

目标：让字体成本可控。

1. 统计页面真实使用字重。
2. 对品牌字体和数字字体做子集化。
3. 使用 `unicode-range` 拆分语言分片。
4. 图标字体迁移 SVG。
5. 增加字体体积 CI 检查。

预期收益：

- 字体总体积稳定受控。
- 首屏字体请求数量减少。
- 后续新增字体不再失控。

### 阶段三：体验精修

目标：降低字体切换带来的视觉跳动。

1. 为品牌字体选择相近 fallback。
2. 对关键标题和导航使用字体指标覆盖。
3. 用 Web Vitals 监控 CLS 和 LCP。
4. 对弱网用户使用 `optional` 策略。

预期收益：

- 字体切换不再导致明显布局变化。
- 首屏体验更稳定。
- 性能指标可被持续观测。

---

## 十六、完整推荐模板

### HTML

```html
<link rel="preconnect" href="https://static.example.com" crossorigin>
<link
  rel="preload"
  href="https://static.example.com/fonts/brand-title.woff2"
  as="font"
  type="font/woff2"
  crossorigin
>
```

### CSS

```css
:root {
  --font-system: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --font-brand: "BrandFont", var(--font-system);
}

@font-face {
  font-family: "BrandFont";
  src: url("https://static.example.com/fonts/brand-title.woff2") format("woff2");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0020-007E, U+4E00-9FFF;
}

body {
  font-family: var(--font-system);
}

.hero-title,
.brand-title {
  font-family: var(--font-brand);
  font-weight: 700;
}
```

### 服务端缓存

```http
Cache-Control: public, max-age=31536000, immutable
Content-Type: font/woff2
Access-Control-Allow-Origin: *
```

---

## 十七、验收清单

上线前检查：

- [ ] 首屏字体请求数不超过 2 个。
- [ ] 首屏字体总大小符合预算。
- [ ] 所有 Web Font 使用 WOFF2。
- [ ] 所有 `@font-face` 配置 `font-display`。
- [ ] 首屏关键字体已 preload。
- [ ] 非首屏字体未被首屏加载。
- [ ] 字体 URL 与 preload URL 一致。
- [ ] 跨域字体配置 `crossorigin` 和 CORS 响应头。
- [ ] 字体文件使用 hash 文件名和长期缓存。
- [ ] 弱网下无长时间文字空白。
- [ ] 字体切换不造成明显换行和布局跳动。
- [ ] Lighthouse / Web Vitals 中 LCP、CLS 未退化。

---

## 十八、常见问题

### 1. 为什么加了 preload 字体还会下载两次？

通常是因为 preload 的 URL、`crossorigin`、`type` 和 CSS 中实际请求不一致。

修复方式：

```html
<link
  rel="preload"
  href="/fonts/brand.woff2"
  as="font"
  type="font/woff2"
  crossorigin
>
```

CSS 中也必须使用同一个 URL：

```css
src: url("/fonts/brand.woff2") format("woff2");
```

### 2. 为什么设置了 font-display: swap 还是闪？

`swap` 的设计就是先显示 fallback，再切换成 Web Font。它解决的是文字空白，不是完全消除视觉变化。

如果希望减少闪动：

- 使用更接近的 fallback 字体。
- 对正文使用系统字体。
- 对非关键字体使用 `optional`。
- 使用 `size-adjust` 等指标覆盖。

### 3. 中文字体必须用品牌字体怎么办？

优先考虑：

1. 只在标题、营销文案中使用品牌中文字体。
2. 对固定文案做子集化。
3. 对正文使用系统字体。
4. 按语言或页面拆分字体。
5. 弱网下允许 fallback。

不建议首屏加载全量中文字体。

### 4. iconfont 是否还推荐？

不推荐作为新方案。SVG 在按需加载、可访问性、颜色控制、稳定性上更好。历史项目可以逐步迁移，优先迁移首屏图标和核心导航图标。

---

## 十九、最终推荐组合

大多数项目可采用以下组合：

1. **正文系统字体**：彻底规避正文大字体闪烁。
2. **品牌字体 WOFF2 + 子集化**：只为必要区域加载必要字符。
3. **首屏关键字体 preload**：避免字体发现过晚。
4. **`font-display: swap / optional` 分场景使用**：平衡可见性和品牌一致性。
5. **fallback 指标优化**：降低切换时的布局跳动。
6. **长期缓存 + CI 预算**：让字体治理可持续。

该方案既能快速缓解线上闪烁问题，也能形成长期工程约束，避免字体资源在后续迭代中重新膨胀。
