# 视频混剪规则与技术方案

> 覆盖单镜头、单次混剪、智能混剪、音画匹配等混剪模式的完整规则定义、组合算法与工程实现方案。

---

## 目录

1. [核心概念与数据模型](#1-核心概念与数据模型)
2. [四种混剪模式详解](#2-四种混剪模式详解)
3. [音画匹配与过滤规则](#3-音画匹配与过滤规则)
4. [组合算法与去重](#4-组合算法与去重)
5. [混剪 Pipeline 架构](#5-混剪-pipeline-架构)
6. [核心数据结构设计](#6-核心数据结构设计)
7. [边界场景与容错](#7-边界场景与容错)

---

## 1. 核心概念与数据模型

### 1.1 基础术语

| 术语 | 定义 |
|------|------|
| **镜头 (Shot)** | 一段连续的视频片段，是混剪的最小单位 |
| **镜头组 (ShotGroup)** | 逻辑上属于同一类别/场景的镜头集合，用户按场景分组（如"开场"、"卖点展示"、"结尾"） |
| **混剪位 (Slot)** | 时间轴上的一个占位，对应一个镜头组，该位置需要从组内选出镜头填充 |
| **混剪组合 (Combination)** | 所有 Slot 选中的镜头序列，构成一条完整的成片 |
| **音频轨 (AudioTrack)** | 与混剪位绑定的配音/BGM 片段，决定了该 Slot 的目标时长 |

### 1.2 输入模型

```
用户输入:
┌─────────────────────────────────────────┐
│  镜头组 1 (开场):    [A1, A2, A3]       │  ← 3 个候选镜头
│  镜头组 2 (卖点):    [B1, B2]           │  ← 2 个候选镜头
│  镜头组 3 (展示):    [C1, C2, C3, C4]   │  ← 4 个候选镜头
│  镜头组 4 (结尾):    [D1, D2]           │  ← 2 个候选镜头
│                                         │
│  音频轨: [Audio1(3s), Audio2(5s),       │
│           Audio3(4s), Audio4(2s)]        │
│                                         │
│  混剪模式: 单镜头 / 单次 / 智能         │
│  目标条数: N                            │
└─────────────────────────────────────────┘
```

---

## 2. 四种混剪模式详解

### 2.1 单镜头模式

**规则**：每个镜头组只取**一个**镜头参与混合，按组顺序各选一个组成序列。

```
镜头组 1: [A1, A2, A3]
镜头组 2: [B1, B2]
镜头组 3: [C1, C2]

可能的组合 = 3 × 2 × 2 = 12 条：
组合 1: A1 → B1 → C1
组合 2: A1 → B1 → C2
组合 3: A1 → B2 → C1
组合 4: A1 → B2 → C2
组合 5: A2 → B1 → C1
...
组合 12: A3 → B2 → C2
```

**算法**：笛卡尔积（Cartesian Product）

```typescript
function singleShotCombine(groups: Shot[][]): Shot[][] {
  return groups.reduce<Shot[][]>(
    (combos, group) =>
      combos.flatMap(combo => group.map(shot => [...combo, shot])),
    [[]]
  );
}
```

**组合数公式**：`∏(i=1..K) |Group_i|`，其中 K 为组数。

**特点**：
- 每个镜头组恰好贡献 1 个镜头
- 组合数 = 各组镜头数的乘积
- 适合组数多、每组镜头少的场景
- 结果确定性强，无随机性

---

### 2.2 单次混剪模式

**规则**：组内每个镜头**最多参与一次**混合。同一镜头不会出现在多条混剪结果中。

```
镜头组 1: [A1, A2, A3]  → 第 1 条用 A1，第 2 条用 A2，第 3 条用 A3
镜头组 2: [B1, B2]       → 第 1 条用 B1，第 2 条用 B2，第 3 条无可用（组耗尽）
镜头组 3: [C1, C2, C3]  → 第 1 条用 C1，第 2 条用 C2，第 3 条用 C3

结果:
组合 1: A1 → B1 → C1
组合 2: A2 → B2 → C2
组合 3: A3 → (跳过/回退) → C3  ← 镜头组 2 耗尽
```

**算法**：贪心分配 + 耗尽检测

```typescript
interface SingleUseMixResult {
  combinations: Shot[][];
  maxPossible: number;      // 受限于最小组的镜头数
  exhaustedGroups: number[]; // 哪些组先耗尽
}

function singleUseMix(groups: Shot[][]): SingleUseMixResult {
  const maxPossible = Math.min(...groups.map(g => g.length));
  const shuffled = groups.map(g => shuffle([...g])); // 随机化组内顺序
  const combinations: Shot[][] = [];

  for (let i = 0; i < maxPossible; i++) {
    combinations.push(shuffled.map(g => g[i]));
  }

  return {
    combinations,
    maxPossible,
    exhaustedGroups: groups
      .map((g, idx) => g.length === maxPossible ? idx : -1)
      .filter(idx => idx !== -1),
  };
}
```

**组合数上限**：`min(|Group_1|, |Group_2|, ..., |Group_K|)`

**特点**：
- 镜头使用无重复，素材利用率可控
- 组合数受限于最小的镜头组
- 适合需要严格去重的投放场景（避免重复素材被平台降权）
- 当某组耗尽时需要策略处理（跳过 / 用占位素材 / 停止生成）

---

### 2.3 智能混剪模式

**规则**：分两阶段——先对组内镜头**随机排列组合**，再以**单镜头模式**跨组组合。

```
阶段 1: 组内随机排列
  镜头组 1: [A1, A2, A3] → 排列: [A2, A3, A1], [A1, A3, A2], ...
  镜头组 2: [B1, B2]     → 排列: [B1, B2], [B2, B1]

阶段 2: 以排列后的序列作为新的"镜头"，用单镜头笛卡尔积组合
  如果每组取 1 个排列 → 笛卡尔积跨组
  组合 1: [A2,A3,A1] 的第1个 → B 组排列的第1个 → ...

实际效果: 增加了组内镜头的顺序变化，提升差异化
```

**算法**：排列 + 笛卡尔积

```typescript
function smartMix(groups: Shot[][], maxPerGroup: number = Infinity): Shot[][] {
  // 阶段 1: 对每组生成随机排列（限制排列数量避免爆炸）
  const permutedGroups = groups.map(group => {
    const perms = generatePermutations(group);
    // 限制每组最大排列数，随机采样
    return perms.length > maxPerGroup
      ? sampleRandom(perms, maxPerGroup)
      : perms;
  });

  // 阶段 2: 以单镜头模式跨组组合（每组选一个排列）
  const rawCombinations = singleShotCombine(permutedGroups);

  // 阶段 3: 展平排列为镜头序列
  return rawCombinations.map(combo => combo.flat());
}
```

**组合数**：`∏(i=1..K) P(|Group_i|)`，其中 `P(n) = n!`（全排列数）。实际需截断。

**特点**：
- 最大化差异性：同样的镜头以不同顺序出现
- 组合空间爆炸式增长，必须设置上限截断
- 适合素材有限但需要大量差异化成片的场景
- 随机性最强，适合 A/B 测试投放

---

### 2.4 模式对比

| 维度 | 单镜头 | 单次混剪 | 智能混剪 |
|------|--------|----------|----------|
| 组内选取 | 选 1 个 | 选 1 个（不复用） | 排列后选 1 组 |
| 跨组组合 | 笛卡尔积 | 贪心分配 | 笛卡尔积 |
| 同镜头复用 | 允许跨组合复用 | 不允许 | 允许 |
| 组合数量级 | 中（乘积） | 小（最小组） | 大（阶乘 × 乘积） |
| 差异化程度 | 中 | 低 | 高 |
| 适用场景 | 通用 | 投放去重 | 大量差异化 |
| 确定性 | 确定 | 半随机 | 随机 |

---

## 3. 音画匹配与过滤规则

### 3.1 核心原则

**素材时长必须 ≥ 音频时长**，否则该镜头不纳入混剪组合。

```
过滤规则:
  对于镜头组 G[i] 中的镜头 S[j]:
    if S[j].duration < AudioSlot[i].duration:
      从 G[i] 中移除 S[j]  // 不参与组合
```

### 3.2 音画匹配详细规则

| 场景 | 条件 | 处理策略 |
|------|------|---------|
| **素材短于音频** | `shot.duration < audio.duration` | **移除**，不参与混剪 |
| **素材略长于音频** | `audio.duration ≤ shot.duration ≤ audio.duration × 1.5` | 裁剪素材，保留高质量区间 |
| **素材远长于音频** | `shot.duration > audio.duration × 1.5` | 智能截取最佳片段 |
| **素材与音频等长** | `|shot.duration - audio.duration| < 0.5s` | 直接使用，微调对齐 |
| **组内全部不匹配** | 过滤后 `G[i].length === 0` | 该组跳过 / 使用静态图兜底 / 终止并提示 |

### 3.3 裁剪策略

当素材长于音频需要裁剪时：

```typescript
interface TrimStrategy {
  // 按质量分裁剪：选取素材中画面质量最高的连续区间
  qualityBased: {
    scorePerFrame: number[];     // 每帧质量评分
    windowSize: number;          // 目标时长对应的帧数
    // 滑动窗口取最高平均分区间
  };

  // 按运动量裁剪：选取运动幅度最合适的区间（避免截断动作）
  motionBased: {
    motionCurve: number[];       // 运动量曲线
    // 寻找运动量的自然低谷作为裁剪点
  };

  // 按场景边界裁剪：在镜头内的场景切换点附近裁剪
  sceneBoundary: {
    boundaries: number[];        // 场景变化时间点
    // 优先在场景边界处裁剪，避免截断连贯内容
  };
}
```

### 3.4 音频节拍对齐

镜头切换点应尽量对齐 BGM 节拍：

```
BGM 节拍:  ↓     ↓     ↓     ↓     ↓     ↓
时间轴:    |-----|-----|-----|-----|-----|-----|
镜头切换:  ↓           ↓           ↓
对齐后:    ↓           ↓           ↓     (吸附到最近节拍点)

容差: ±100ms 以内自动吸附到节拍点
超过容差: 保持原切换点，不强制对齐（避免音画不同步）
```

---

## 4. 组合算法与去重

### 4.1 组合生成流程

```
原始镜头组
    │
    ▼
[音画匹配过滤] ── 移除时长不足的镜头
    │
    ▼
[模式选择] ── 单镜头 / 单次 / 智能
    │
    ▼
[生成候选组合]
    │
    ▼
[去重与评分] ── 移除过于相似的组合
    │
    ▼
[排序截取 Top-N]
    │
    ▼
[音画对齐 + 裁剪]
    │
    ▼
最终混剪结果
```

### 4.2 去重策略

当组合数量过多时，需要去重和筛选：

```typescript
// 组合相似度计算
function combinationSimilarity(a: Shot[], b: Shot[]): number {
  let sameCount = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id === b[i].id) sameCount++;
  }
  return sameCount / a.length; // 0~1，1 表示完全相同
}

// 去重：移除与已选组合相似度 > 阈值的候选
function deduplicate(
  candidates: Shot[][],
  maxResults: number,
  similarityThreshold = 0.6
): Shot[][] {
  const selected: Shot[][] = [];

  for (const candidate of candidates) {
    const tooSimilar = selected.some(
      s => combinationSimilarity(s, candidate) > similarityThreshold
    );
    if (!tooSimilar) {
      selected.push(candidate);
      if (selected.length >= maxResults) break;
    }
  }

  return selected;
}
```

### 4.3 组合评分

多维度打分排序，优先选择高分组合：

| 评分维度 | 权重 | 说明 |
|---------|------|------|
| 素材质量分 | 0.3 | 各镜头画面清晰度、曝光、稳定性的平均分 |
| 音画匹配度 | 0.25 | 素材时长与音频时长的匹配程度 |
| 场景多样性 | 0.2 | 组合中镜头的场景丰富度（避免连续相似场景） |
| 节奏合理性 | 0.15 | 镜头时长变化是否自然（避免忽长忽短） |
| 转场友好度 | 0.1 | 相邻镜头的色调/内容是否适合转场 |

---

## 5. 混剪 Pipeline 架构

### 5.1 整体流程

```
┌──────────────────────────────────────────────────────────────┐
│                         混剪 Pipeline                        │
│                                                              │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐  │
│  │ 素材预处理 │──▶│ 音画过滤  │──▶│ 组合生成  │──▶│ 评分排序  │  │
│  │          │   │          │   │          │   │          │  │
│  │• 转码统一 │   │• 时长校验 │   │• 模式分发 │   │• 多维评分 │  │
│  │• 抽帧分析 │   │• 质量门槛 │   │• 笛卡尔积 │   │• 去重过滤 │  │
│  │• 元数据提取│   │• 标记移除 │   │• 排列生成 │   │• Top-N   │  │
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘  │
│                                                    │         │
│                                                    ▼         │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐  │
│  │ 成片输出  │◀──│ 渲染合成  │◀──│ 时间轴装配│◀──│ 音画对齐  │  │
│  │          │   │          │   │          │   │          │  │
│  │• 编码输出 │   │• 多轨合成 │   │• 素材裁剪 │   │• 节拍吸附 │  │
│  │• 封面抽帧 │   │• 转场效果 │   │• 转场插入 │   │• 配音同步 │  │
│  │• 元数据写入│   │• 字幕叠加 │   │• 特效叠加 │   │• 字幕定位 │  │
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 关键模块职责

**素材预处理**：
- 统一编码格式（H.264）、帧率（25/30fps）、采样率（44100Hz）
- 提取关键帧、计算画面质量评分、检测场景切换点
- 生成素材元数据（时长、分辨率、运动量曲线）

**音画过滤**：
- 逐组检查每个镜头时长是否满足对应音频时长要求
- 移除不满足条件的镜头并记录日志
- 检测过滤后的空组，触发异常处理

**组合生成**：
- 根据选定模式调用对应算法
- 对大量候选进行随机采样（避免内存爆炸）
- 输出候选组合列表

**音画对齐**：
- 将每个组合的镜头与对应音频 Slot 对齐
- 执行 BGM 节拍吸附
- 计算实际裁剪的 In/Out Point

---

## 6. 核心数据结构设计

```typescript
/** 镜头 */
interface Shot {
  id: string;
  groupId: string;           // 所属镜头组
  sourceUrl: string;         // 源视频 URL
  inPoint: number;           // 源视频内起始时间 (秒)
  outPoint: number;          // 源视频内结束时间 (秒)
  duration: number;          // outPoint - inPoint
  qualityScore: number;      // 画面质量评分 0~1
  motionScore: number;       // 运动量评分 0~1
  sceneTags: string[];       // 场景标签
  resolution: { w: number; h: number };
}

/** 镜头组 */
interface ShotGroup {
  id: string;
  name: string;              // 如 "开场"、"卖点展示"
  shots: Shot[];
  slotIndex: number;         // 对应时间轴上的位置索引
}

/** 音频 Slot */
interface AudioSlot {
  slotIndex: number;
  audioUrl: string;
  duration: number;          // 音频时长
  beats?: number[];          // 节拍点 (秒)
  text?: string;             // 对应文案 (用于字幕)
}

/** 混剪配置 */
interface MixConfig {
  mode: 'single-shot' | 'single-use' | 'smart';
  targetCount: number;       // 期望生成条数
  maxCombinations: number;   // 组合数上限（防爆炸）
  similarityThreshold: number; // 去重阈值 (0~1)
  audioMatchTolerance: number; // 音频匹配容差 (秒)
  beatAlignTolerance: number;  // 节拍对齐容差 (毫秒)
}

/** 混剪结果 */
interface MixResult {
  id: string;
  config: MixConfig;
  combinations: CombinationResult[];
  statistics: MixStatistics;
}

/** 单条混剪组合 */
interface CombinationResult {
  index: number;
  shots: SelectedShot[];     // 选中的镜头序列
  totalDuration: number;
  score: number;             // 综合评分
  timeline: TimelineData;    // 时间轴数据（含裁剪点、转场）
}

/** 选中的镜头（含裁剪信息） */
interface SelectedShot {
  shot: Shot;
  trimmedInPoint: number;    // 裁剪后的起始点
  trimmedOutPoint: number;   // 裁剪后的结束点
  trimmedDuration: number;
  audioSlot: AudioSlot;      // 对应的音频
  transition?: TransitionConfig;
}

/** 混剪统计 */
interface MixStatistics {
  totalCandidates: number;   // 候选组合总数
  afterFilter: number;       // 音画过滤后
  afterDedup: number;        // 去重后
  finalCount: number;        // 最终输出数
  filteredShots: {           // 被过滤的镜头明细
    shotId: string;
    reason: 'duration_short' | 'quality_low' | 'group_exhausted';
  }[];
}
```

---

## 7. 边界场景与容错

### 7.1 常见边界场景

| 场景 | 描述 | 处理策略 |
|------|------|---------|
| **组内全部过滤** | 某组所有镜头时长都短于音频 | 1) 该组降级：用静态封面图 + Ken Burns 效果填充<br>2) 提示用户补充素材<br>3) 缩短该 Slot 音频 |
| **组合数不足** | 过滤后无法凑够目标条数 | 降低去重阈值 / 允许部分镜头复用 / 告知用户实际可生成条数 |
| **组合数爆炸** | 智能模式下排列组合过多 | 设置 `maxCombinations` 上限，随机采样 |
| **单组仅 1 个镜头** | 单次混剪模式下该组无法差异化 | 该位置所有组合使用同一镜头，差异化由其他组承担 |
| **素材分辨率不一致** | 不同镜头分辨率差异大 | 统一输出分辨率 + 智能裁剪/缩放/加黑边 |
| **音频为空** | 某 Slot 无配音/BGM | 使用素材原声或静音，不做时长过滤 |

### 7.2 降级策略优先级

```
L1: 正常混剪 → 目标条数、全部镜头组参与
    │ 某组过滤后为空
    ▼
L2: 跳过空组 → 生成少一个 Slot 的组合
    │ 目标条数不足
    ▼
L3: 放宽去重 → 降低 similarityThreshold
    │ 仍不足
    ▼
L4: 允许复用 → 单次模式降级为单镜头模式
    │ 仍不足
    ▼
L5: 返回实际数 → 告知用户最多生成 X 条
```

### 7.3 需要补充的细节清单

以下是工程落地时需要进一步明确的问题：

| 领域 | 待确认细节 |
|------|-----------|
| **转场** | 不同组合间转场类型如何分配？是固定 cut 还是按内容智能选择？ |
| **音频裁剪** | 当素材短于音频时，是否允许裁剪音频（而非只移除素材）？ |
| **镜头最短时长** | 是否有最短镜头时长限制？（如 < 0.5s 的镜头不参与） |
| **速度变换** | 素材略短时是否允许变速（0.8x~1.2x）补偿时长差？ |
| **组内排序** | 单镜头模式下组内是否有优先级（如质量分高的优先）？ |
| **跨组复用** | 同一镜头是否允许出现在不同镜头组中？ |
| **预览机制** | 混剪结果是否需要低分辨率预览再确认导出？ |
| **增量混剪** | 用户追加素材后是否支持增量生成，而非全量重算？ |
| **并发控制** | 批量生成 N 条时的最大并行数和资源分配策略？ |
| **结果缓存** | 同样的输入是否缓存组合结果，避免重复计算？ |

---

## 附录：组合数速查

假设有 K 个镜头组，每组 n 个镜头：

| 模式 | 组合数公式 | K=4, n=3 | K=4, n=5 | K=6, n=4 |
|------|-----------|----------|----------|----------|
| 单镜头 | n^K | 81 | 625 | 4,096 |
| 单次混剪 | min(n_i) | 3 | 5 | 4 |
| 智能混剪 | (n!)^K | 1,296 | 1.73×10^9 | 191,102,976 |

> 智能模式必须设置截断上限，建议 `maxCombinations ≤ 10000`。
