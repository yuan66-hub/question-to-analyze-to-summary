# 测试 Bug 单自动分诊到解决方案：Skill 还是 MCP 的可行性方案

> 日期：2026-07-10

## 一句话结论

把「从外部测试平台拉取 bug 单 → 清洗成统一结构 → 抽取多模态有效信息（含截图涂鸦/框选）→ 分类（历史 bug / 优化点 / 扩展需求）→ 用 codegraph 定位代码 → 产出『原因 → 多方案 → 修复步骤』详情」这条链路自动化，**技术上完全可行**。

关键判断是：**不要在「Skill 还是 MCP」之间二选一，而应做成 `MCP（能力层） + Skill（编排层）` 的混合架构**：

- **MCP 负责「有副作用、需凭证、需确定性」的能力**：拉单、图片下载、OCR/视觉标注区域解析、写回评论。
- **Skill 负责「需要推理、需要读代码、需要产出方案」的编排**：调用 codegraph、判定分类、生成解决方案、组织输出格式。

单独用 Skill 做不了稳定的跨平台鉴权与图像处理；单独用 MCP 做不了灵活的推理编排与方案撰写。混合方案各取所长。

| 维度 | 纯 Skill | 纯 MCP | 混合（推荐） |
| --- | --- | --- | --- |
| 跨平台鉴权/拉单 | 弱（凭证难托管） | 强 | 强 |
| 图片下载/OCR/框选解析 | 弱（无确定性执行环境） | 强 | 强 |
| 分类与方案推理 | 强 | 弱（MCP 不做推理） | 强 |
| 调用 codegraph 定位代码 | 强（模型自主编排） | 中 | 强 |
| 可移植性（换 IDE/换 Agent） | 中 | 强 | 强 |
| 维护成本 | 低 | 高 | 中 |

---

## 目标定义

输入：测试同学在**外部项目平台**（Jira / TAPD / 禅道 / GitLab Issue / 飞书多维表格等）提交的一条或一批 bug 单，字段往往是「非结构化 + 半结构化 + 图片附件」混合：

- 复现步骤（步骤描述，常常口语化、缺步骤）
- 实际结果 / 期望结果
- 测试备注（环境、账号、版本、偶现概率等）
- 截图附件：**带涂鸦标注、红框框选、箭头、文字批注**

输出：一份对每张单子的**结构化诊断报告**，包含：

1. 清洗后的规范化 bug 单（统一 schema）
2. 抽取出的有效信息（含图片中框选区域对应的 UI/文案/元素）
3. 类型判定：`历史 bug` / `优化点` / `扩展需求`（附置信度与依据）
4. 基于当前项目代码的**详情解决方案**：
   - 原因分析（root cause，附代码证据链）
   - 多个候选解决方案（含取舍）
   - 修复步骤（**需要改动的具体文件/函数/代码片段**）

本质流程：

```text
外部 bug 单 → 规范化清洗 → 多模态信息抽取 → 分类 → 代码定位(codegraph) → 方案生成 → 结构化报告
```

---

## 全链路架构总览

```text
┌─────────────────────────────────────────────────────────────┐
│                     Skill（编排层 / 大脑）                     │
│  bug-triage SKILL.md：定义流程、分类规则、方案模板、输出格式    │
└───────┬───────────────────────────────────────────┬─────────┘
        │ 调用                                        │ 调用（已有）
        ▼                                             ▼
┌──────────────────────────┐              ┌──────────────────────────┐
│   bug-intake MCP（能力层） │              │   codegraph MCP（已具备）  │
│  - fetch_tickets          │              │  - codegraph_context      │
│  - normalize_ticket       │              │  - codegraph_search       │
│  - download_attachments   │              │  - codegraph_trace        │
│  - extract_annotations    │              │  - codegraph_impact       │
│  - ocr_image              │              │  - codegraph_callers/ees  │
│  - post_comment(写回)     │              └──────────────────────────┘
└───────┬──────────────────┘
        │ 适配
        ▼
┌──────────────────────────────────────────────┐
│  平台适配器 Adapters（可插拔）                 │
│  Jira / TAPD / 禅道 / GitLab / 飞书多维表格    │
└──────────────────────────────────────────────┘
```

阶段拆分与「谁来做」：

| 阶段 | 承载者 | 理由 |
| --- | --- | --- |
| ① 拉取 bug 单 | MCP tool `fetch_tickets` | 需平台鉴权、分页、限流，天然确定性 |
| ② 数据清洗规范化 | MCP tool `normalize_ticket` | 字段映射是规则活，代码比 prompt 稳 |
| ③ 附件下载 | MCP tool `download_attachments` | IO 副作用，需落盘缓存 |
| ④ 图片信息抽取 | MCP tool `extract_annotations` + `ocr_image` | 需 CV/OCR 库，确定性执行环境 |
| ⑤ 有效信息归纳 | Skill（LLM） | 语义理解，去噪、补全 |
| ⑥ 分类判定 | Skill（LLM + 规则） | 需推理 + 历史知识 |
| ⑦ 代码定位 | Skill 调 codegraph MCP | 模型自主决定查什么 |
| ⑧ 方案生成 | Skill（LLM） | 撰写「原因→方案→步骤」 |
| ⑨ 写回平台 | MCP tool `post_comment` | 副作用，可选、需二次确认 |

---

## 阶段详解

### ① 拉取 bug 单（平台适配层 + MCP）

用「适配器模式」抹平各平台差异，对上暴露统一 tool：

```jsonc
// MCP tool: fetch_tickets
{
  "name": "fetch_tickets",
  "input": {
    "platform": "jira | tapd | zentao | gitlab | feishu",
    "query": { "sprint": "S-2026-07", "status": "open", "assignee": "..." },
    "since": "2026-07-01T00:00:00Z",
    "limit": 50
  }
}
```

要点：

- 凭证走 MCP 服务端环境变量 / 密钥管理，**不进模型上下文**（安全）。
- 支持增量拉取（`since` / 游标），避免重复处理。
- 输出保留 `raw`（原始 payload）以便回溯，同时给 `normalized` 草稿。

### ② 数据清洗与规范化（统一 Schema）

所有平台字段映射到一个 canonical schema：

```jsonc
// NormalizedTicket
{
  "id": "TAPD-10231",
  "title": "编辑器保存后图层顺序错乱",
  "source": { "platform": "tapd", "url": "https://..." },
  "reproSteps": ["1. 打开画布", "2. 拖入 3 个图层", "3. Ctrl+S 保存", "4. 刷新页面"],
  "actualResult": "刷新后图层顺序变成倒序",
  "expectedResult": "图层顺序与保存前一致",
  "testNotes": { "env": "Chrome 126 / Win", "version": "v2.3.1", "frequency": "必现" },
  "attachments": [
    { "id": "a1", "type": "image", "localPath": ".cache/a1.png", "annotations": [] }
  ],
  "rawRef": "..."
}
```

清洗规则（代码化，放 MCP 侧）：

- 复现步骤：拆句、编号、去除「如图」等指代噪声（但保留与图片的关联指针）。
- 环境信息：正则/字典抽取版本号、浏览器、OS、账号。
- 去重与合并：同一现象的多条单子做相似度聚类（可选）。

### ③ 多模态信息抽取（截图涂鸦 / 框选 / 批注）

这是最有价值也最容易被忽略的一步。测试的红框/箭头/文字往往**直接指向问题元素**。

抽取流水线（MCP tool `extract_annotations`）：

1. **标注检测**：用颜色阈值 + 轮廓检测找出红框/高亮矩形（多数标注工具用醒目色）；箭头用形态学 + 直线检测。
2. **ROI 裁剪**：把框选区域裁出来单独送 OCR，识别框内文案/按钮标题/报错文本。
3. **手写/批注文字 OCR**：整图 OCR + 区域 OCR，输出带 bbox 的文本块。
4. **区域语义化**：把「框选坐标 + 框内 OCR 文本」组织为结构化线索：

```jsonc
{
  "annotations": [
    {
      "kind": "rect",          // rect | arrow | text | freehand
      "bbox": [120, 340, 260, 380],
      "color": "#ff0000",
      "ocrText": "保存",       // 框内识别到的文案
      "note": "这里点了没反应"  // 附近手写/批注
    }
  ]
}
```

这样 LLM 拿到的不再是「一张图」，而是「测试圈出了『保存』按钮并批注点了没反应」——可直接用于 codegraph 搜索（如搜 `保存` / `save` 相关组件与 handler）。

技术选型：OCR 用 PaddleOCR / Tesseract / 云 OCR；标注检测用 OpenCV；也可用多模态大模型（如带视觉的模型）直接产出结构化描述，作为兜底或增强。

### ④ 有效信息归纳与分类（Skill）

分类三型，给出可判定的规则骨架（Skill 内固化，LLM 结合项目历史执行）：

| 类型 | 判定信号 | 处理策略 |
| --- | --- | --- |
| 历史 bug | 与既有需求/设计不符；曾正常、现回归；有明确期望值 | 走「原因→方案→修复步骤」全流程 |
| 优化点 | 功能可用但体验/性能不佳；期望是「更好」而非「修正」 | 产出优化建议 + 收益/成本评估 |
| 扩展需求 | 期望的是**当前不存在**的能力；属新增功能 | 转需求流程，产出方案但标注「需排期」 |

判定要点：对比 `期望结果` 与「代码现状 + PRD/设计」的差集。若期望落在既有约定内 → 历史 bug；落在约定外 → 扩展需求；落在「都满足但不够好」→ 优化点。输出置信度与依据链。

### ⑤ 代码定位（codegraph MCP）

复用仓库已接入的 codegraph。典型调用序列（写进 Skill 的 SOP）：

1. 从标注 OCR 文案 / 报错信息 / 步骤关键词提取 symbol 候选。
2. `codegraph_context`：一次拿到相关符号的定义 + 调用方 + 被调用方。
3. `codegraph_trace`：追「用户操作 → 事件 handler → 状态更新 → 渲染」的完整链路（对前端 bug 尤其有效，能跨动态派发）。
4. `codegraph_impact`：评估拟改动点的爆炸半径，为「多方案取舍」提供依据。

> 注意：codegraph 返回结果直接信任，不再用 grep 复核；编辑后留意 staleness 提示。

### ⑥ 解决方案生成（Skill 输出模板）

每张单子固定产出如下结构（强约束模板，保证一致性）：

```markdown
## [TAPD-10231] 编辑器保存后图层顺序错乱  ·  类型：历史 bug（置信度 0.9）

### 有效信息
- 复现：拖入 3 图层 → Ctrl+S → 刷新 → 顺序倒序（必现，v2.3.1）
- 截图线索：红框圈出「图层面板」，批注「刷新后就乱了」
- 期望：顺序与保存前一致

### 原因分析（root cause）
保存时按 Map 迭代序列化，未持久化 zIndex；反序列化按插入顺序重建，导致顺序丢失。
证据：`saveLayers()` → `serializeLayer()`（未写 order 字段）| codegraph_trace 链路 ...

### 候选解决方案
1. 【推荐】序列化时显式写入 `order` 字段，反序列化按 order 排序。改动小、兼容旧数据（缺失时回退插入序）。
2. 用有序结构（数组替代 Map）承载图层。更彻底但改动面大，影响 N 处调用（codegraph_impact）。
3. 前端渲染时按 zIndex 二次排序兜底。治标，不改存储，快速止血。

### 修复步骤（需改动代码）
- `src/editor/serialize.ts` `serializeLayer()`：新增 `order: layer.zIndex`
- `src/editor/deserialize.ts` `parseLayers()`：`layers.sort((a,b)=>a.order-b.order)`
- 迁移：旧数据无 order 时按数组下标兜底
- 影响面：codegraph_impact 显示仅 2 处调用，风险低
```

---

## Skill 与 MCP 的落地形态

### MCP 侧：`bug-intake` server（能力层）

工具清单（保持少而正交，符合工具设计原则）：

| tool | 作用 | 副作用 |
| --- | --- | --- |
| `fetch_tickets` | 拉单（多平台适配） | 只读 |
| `normalize_ticket` | 规范化到统一 schema | 无 |
| `download_attachments` | 下载图片到本地缓存 | 写盘 |
| `extract_annotations` | 框选/箭头/批注检测 + ROI 裁剪 | 无 |
| `ocr_image` | 整图/区域 OCR | 无 |
| `post_comment` | 把方案写回平台（可选，需确认） | 写外部 |

建议 Node/TS 或 Python 实现，凭证走 env；产出统一 JSON，图片以 `localPath` 引用避免塞爆上下文。

### Skill 侧：`bug-triage` skill（编排层）

目录结构：

```text
.cursor/skills/bug-triage/
  SKILL.md            # 流程 SOP、分类规则、输出模板、codegraph 调用策略
  templates/
    report.md         # 诊断报告模板
    classify-rubric.md # 三分类判定标准
  scripts/
    run.md            # 批处理编排说明（可选）
```

`SKILL.md` 骨架：

```markdown
---
name: bug-triage
description: 从测试平台拉取 bug 单，清洗、抽取截图标注信息、分类，并结合 codegraph 产出「原因→多方案→修复步骤」诊断报告。当用户要求处理/分析测试 bug 单时使用。
---

# 流程
1. 调 bug-intake.fetch_tickets 拉单 → normalize_ticket 清洗
2. download_attachments → extract_annotations + ocr_image 抽取图片线索
3. 按 templates/classify-rubric.md 判定类型（历史bug/优化点/扩展需求）
4. 用标注文案/报错关键词，调 codegraph_context / codegraph_trace / codegraph_impact 定位代码
5. 按 templates/report.md 产出诊断报告；如需写回，调 post_comment（先向用户确认）

# 约束
- codegraph 结果直接信任，不用 grep 复核
- 扩展需求只出方案不改代码，标注「需排期」
- 每条方案必须给出具体文件/函数与改动点
```

### 为什么这样切分（决策依据）

- **副作用与凭证** → 必须在 MCP：Skill 是 prompt，不适合托管密钥、跑 OpenCV/OCR。
- **推理与读码** → 必须在 Skill：MCP 不做推理，分类和方案撰写是模型强项，且要灵活调 codegraph。
- **可移植** → 换 Agent 时，MCP 能力零改动复用；Skill 可按平台/团队微调。

---

## 分阶段落地路线图

| 阶段 | 目标 | 交付 | 周期 |
| --- | --- | --- | --- |
| P0 PoC | 单平台（先选团队在用的那个）+ 纯文本单 | Skill + `fetch_tickets`/`normalize_ticket`，跑通「拉单→分类→codegraph→报告」 | 3-5 天 |
| P1 多模态 | 加截图标注抽取 | `download_attachments`/`extract_annotations`/`ocr_image` | 1 周 |
| P2 多平台 | 适配器扩展到 2-3 个平台 | Adapters + 统一 schema 稳定 | 1 周 |
| P3 闭环 | 写回评论、批量、增量、去重聚类 | `post_comment` + 批处理编排 | 1 周 |

先做 P0 验证「模型产出的方案是否靠谱」——这是整个方案的最大不确定性，应最先证伪。

---

## 风险与规避

| 风险 | 影响 | 规避 |
| --- | --- | --- |
| 方案幻觉（改错文件/编造函数） | 高 | 强制方案引用 codegraph 返回的真实符号；无证据不给结论 |
| OCR/标注误检 | 中 | 保留原图链接，低置信度时标注「需人工核对」，多模态模型兜底 |
| 平台鉴权/限流 | 中 | 凭证服务端托管，增量拉取 + 退避重试 |
| 图片进上下文爆 token | 中 | 只传结构化 annotation + localPath，不传原图 base64 |
| 分类边界模糊 | 中 | rubric 固化 + 输出置信度与依据，低置信转人工 |
| codegraph 索引滞后 | 低 | 留意 staleness 提示，必要时对提示文件直接 Read |

---

## 验收标准

- 给定一批真实 bug 单，**≥80% 能自动产出结构化报告**且分类正确。
- 每条「历史 bug」报告的修复步骤所引用的文件/函数**真实存在**（可被 codegraph 命中）。
- 截图中被框选的关键元素，**≥70% 能被 OCR 正确关联**到线索文本。
- 换一个测试平台时，只需新增一个 adapter，Skill 与其余 tool 零改动。

---

## 结论

- **形态**：`bug-intake MCP（拉单/清洗/图像抽取/写回） + bug-triage Skill（分类/编排/方案）` 混合，复用已有 codegraph MCP。
- **不建议纯 Skill**：无法稳妥处理鉴权与图像处理。
- **不建议纯 MCP**：无法承载灵活推理与方案撰写，且把推理硬塞进 tool 会让工具臃肿难维护。
- **先做 P0**：用最小成本验证「AI 方案质量」这一核心风险，再逐步补齐多模态与多平台。
