# LLM 错别字纠错原理

## 核心机制

### 1. 注意力机制 (Attention)

LLM 通过**自注意力机制**理解上下文关系。当遇到错别字时，模型会：

- 根据周围词汇的语义关联，推断出"应该是哪个词"
- 注意力权重会分布到多个候选词上，最终选择概率最高的

```
示例：
"我今天要去公义看望父母"  →  "公"与"公司"语义相关，推断可能想说"公司"
```

### 2. 预训练语言模型

模型在海量文本上训练，已经学习了：

- 词与词之间的共现概率
- 常见的拼写错误模式
- 拼音/形近字的纠正规律

### 3. 纠错策略

| 策略 | 说明 | 示例 |
|------|------|------|
| **语义纠错** | 通过上下文理解意图 | "我想吃苹因" → "苹果" |
| **语音纠错** | 拼音相似、音近字 | "公" → "公司" |
| **字形纠错** | 形近字误用 | "己" vs "已" vs "巳" |
| **语法纠错** | 主谓搭配、时态等 | "我今天很开心" + "喜极而泣" |

### 4. 实现方式

#### 纯 LLM 方式

```
输入："我明天的飞机" → 模型直接理解并纠错
```

#### 混合方式（更准确）

```
错别字检测模型 → 候选纠正列表 → LLM 评分选择 → 最终输出
```

## 本质

LLM 纠错本质是**基于语义理解的概率推断**，不是显式规则匹配。它利用：

- 词的分布式表示（Embedding）
- 上下文关联性
- 海量数据中学到的语言规律

## 对比传统方法

| 方法 | 能力 | 示例 |
|------|------|------|
| 正则表达式 | 规则匹配 | 只能替换已知错误模式 |
| 字典查错 | 词形校验 | 无法判断语义是否正确 |
| **LLM 纠错** | 语义理解 | "我想吃苹因" → "苹果"（知道"因"是"果"的形近误用） |

## 总结

LLM 能纠正传统正则表达式无法处理的错误，核心原因在于：**它理解词语的语义，而不是仅匹配字符模式**。

---

## 多语言纠错差异

### 中文纠错的特殊挑战

中文纠错比英文复杂得多，主要来源于以下几类错误：

| 错误类型 | 原因 | 示例 |
|---------|------|------|
| **形近字** | 字形相似，手写/输入误用 | "己"→"已"、"戊"→"戌" |
| **音近字** | 拼音相同或相似 | "在"→"再"、"的/地/得"混用 |
| **简繁转换错误** | 繁体简体混用 | "後"→"后"、"發"→"发" |
| **输入法联想错误** | 候选词选错 | "今天"→"斤天" |
| **语序错误** | 语法习惯差异 | "我把饭吃了"→"我吃饭了" |

### 英文纠错

```
常见模式：
- 拼写错误：recieve → receive（字母顺序错误）
- 单词重复：the the → the
- 时态错误：I goed → I went
- 大小写：iPhone → iPhone（专有名词）
```

### 多语言混合场景

中英文混排是现代中文语料的常态，LLM 需处理：

```
"这个API的endpoint要加authentication" → 正确，无需纠正
"这个api的end point要加auth" → "endpoint"和"auth"均为常规写法，上下文是否明确
```

---

## 完整混合纠错实现

### 架构设计

```
输入文本
    │
    ▼
┌─────────────────┐
│  候选错误检测    │  ← 规则引擎 + 专用小模型（速度快）
│  (Error Detect) │
└─────────────────┘
    │ 候选错误位置 + 候选纠正词列表
    ▼
┌─────────────────┐
│  LLM 语义评分   │  ← 结合上下文选最佳纠正
│  (LLM Rerank)   │
└─────────────────┘
    │
    ▼
最终纠正结果
```

### 代码实现

```python
from openai import OpenAI
import re
from difflib import get_close_matches

client = OpenAI()

# 常见错别字词典（可扩展）
COMMON_TYPOS = {
    "的地": ["的", "地", "得"],
    "在再": ["在", "再"],
    "做作": ["做", "作"],
}

def detect_candidates(text: str) -> list[dict]:
    """规则 + 词典检测候选错误位置"""
    candidates = []
    # 简单示例：检测常见混淆词
    confused_pairs = [
        ("在", "再"), ("的", "地"), ("做", "作"),
        ("己", "已"), ("带", "戴"), ("坐", "座"),
    ]
    for char1, char2 in confused_pairs:
        for i, char in enumerate(text):
            if char == char1:
                candidates.append({
                    "position": i,
                    "original": char1,
                    "candidates": [char1, char2],
                    "context": text[max(0, i-10):i+11],
                })
    return candidates


def llm_correct(text: str, candidates: list[dict]) -> str:
    """用 LLM 结合上下文做最终纠错决策"""
    if not candidates:
        return text

    # 构建纠错提示
    candidate_desc = "\n".join([
        f"- 位置 {c['position']}: '{c['original']}' (上下文: '{c['context']}'，候选: {c['candidates']})"
        for c in candidates
    ])

    prompt = f"""请对以下文本进行错别字纠错。

原文：{text}

检测到的可疑位置：
{candidate_desc}

请返回纠正后的完整文本。如果某处无需纠正，保持原样。
只返回纠正后的文本，不要解释。"""

    response = client.chat.completions.create(
        model="gpt-4o-mini",  # 用小模型降低成本
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
    )
    return response.choices[0].message.content.strip()


def hybrid_spell_correct(text: str) -> dict:
    """混合纠错主函数"""
    candidates = detect_candidates(text)

    if not candidates:
        # 无明显候选错误，做整体 LLM 检查（可选，增加成本）
        corrected = text
        changed = False
    else:
        corrected = llm_correct(text, candidates)
        changed = corrected != text

    return {
        "original": text,
        "corrected": corrected,
        "changed": changed,
        "candidates_count": len(candidates),
    }


# 使用示例
result = hybrid_spell_correct("我今天要去公司，在路上买了一杯咖啡，然后坐车去了。")
print(result)
```

### 批量纠错（生产环境）

```python
import asyncio
from openai import AsyncOpenAI

async_client = AsyncOpenAI()

async def batch_correct(texts: list[str], batch_size: int = 10) -> list[str]:
    """异步批量纠错，控制并发"""
    semaphore = asyncio.Semaphore(batch_size)

    async def correct_one(text: str) -> str:
        async with semaphore:
            response = await async_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{
                    "role": "user",
                    "content": f"纠正以下文本的错别字，只返回纠正后的文本：\n{text}"
                }],
                temperature=0,
                max_tokens=len(text) * 2,  # 限制输出长度
            )
            return response.choices[0].message.content.strip()

    tasks = [correct_one(t) for t in texts]
    return await asyncio.gather(*tasks)
```

---

## 质量评估指标

### 核心指标

| 指标 | 公式 | 含义 |
|------|------|------|
| **Precision（精确率）** | TP / (TP + FP) | 纠正的词中，真正需要纠正的占比 |
| **Recall（召回率）** | TP / (TP + FN) | 所有需要纠正的词中，被检测到的占比 |
| **F1 Score** | 2×P×R / (P+R) | Precision 和 Recall 的调和平均 |
| **Accuracy** | 正确字符 / 总字符 | 字符级准确率 |

```python
def evaluate_correction(
    original: str,
    predicted: str,
    ground_truth: str
) -> dict:
    """评估单条纠错结果"""
    orig_chars = list(original)
    pred_chars = list(predicted)
    truth_chars = list(ground_truth)

    # 找出真实错误位置
    true_errors = {i for i, (o, t) in enumerate(zip(orig_chars, truth_chars)) if o != t}
    # 找出模型纠正位置
    pred_corrections = {i for i, (p, o) in enumerate(zip(pred_chars, orig_chars)) if p != o}

    tp = len(true_errors & pred_corrections)
    fp = len(pred_corrections - true_errors)  # 过度纠正
    fn = len(true_errors - pred_corrections)  # 漏纠

    precision = tp / (tp + fp) if (tp + fp) > 0 else 1.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 1.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "tp": tp, "fp": fp, "fn": fn,
    }

# 使用
result = evaluate_correction(
    original="我今天很高兴，因为我己完成了任务",
    predicted="我今天很高兴，因为我已完成了任务",
    ground_truth="我今天很高兴，因为我已完成了任务",
)
# {'precision': 1.0, 'recall': 1.0, 'f1': 1.0, 'tp': 1, 'fp': 0, 'fn': 0}
```

### 基准数据集

| 数据集 | 语言 | 规模 | 特点 |
|--------|------|------|------|
| SIGHAN | 中文 | ~7K | 拼音/形近字混合 |
| CSCD | 中文 | ~30K | 社交媒体语料 |
| BEA-2019 | 英文 | ~50K | 学习者语料（GED） |
| CoNLL-2013/2014 | 英文 | ~1.2K | 语法错误纠正 |

---

## 延迟优化策略

### 1. 缓存高频纠错结果

```python
import hashlib
from functools import lru_cache
import redis

redis_client = redis.Redis()

def get_cache_key(text: str) -> str:
    return f"spell_correct:{hashlib.md5(text.encode()).hexdigest()}"

async def cached_correct(text: str) -> str:
    cache_key = get_cache_key(text)
    cached = redis_client.get(cache_key)
    if cached:
        return cached.decode()

    result = await correct_one(text)

    # 缓存 24 小时，文本纠错结果较稳定
    redis_client.setex(cache_key, 86400, result)
    return result
```

### 2. 选择性调用 LLM

```python
def needs_correction(text: str) -> bool:
    """快速预判是否需要 LLM 纠错，避免不必要的 API 调用"""
    # 规则 1：太短的文本跳过
    if len(text) < 5:
        return False

    # 规则 2：纯英文/数字跳过
    chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    if chinese_chars == 0:
        return False

    # 规则 3：高置信度词典匹配
    suspicious_patterns = ["己", "已", "在/再", "的/地/得"]
    # 简化判断：如果有常见混淆字，才调用 LLM
    for pattern in ["己", "做/作"]:
        if any(c in text for c in pattern.split("/")):
            return True

    return False
```

### 3. 模型选择与延迟对比

| 模型 | 平均延迟 | 纠错质量 | 推荐场景 |
|------|---------|---------|---------|
| GPT-4o-mini | ~300ms | 高 | 实时纠错，成本低 |
| GPT-4o | ~800ms | 极高 | 关键内容，要求准确 |
| 本地小模型 (BERT-based) | ~50ms | 中 | 高并发，延迟敏感 |
| 纯规则 | < 5ms | 低（覆盖有限） | 预过滤层 |

### 4. 流水线架构（生产推荐）

```
请求
  │
  ├── 规则预检（< 5ms）→ 无问题 → 直接返回
  │
  ├── 缓存命中（< 1ms）→ 直接返回缓存
  │
  ├── 专用小模型（~50ms）→ 高置信纠正 → 返回
  │
  └── LLM 兜底（~300ms）→ 低置信或复杂情况 → 返回
```

---

## 与搜索引擎集成

### 纠错 + 搜索联动

```python
async def search_with_correction(query: str, search_fn) -> dict:
    """搜索时自动纠错查询词"""
    # 先用原始查询
    original_results = await search_fn(query)

    # 如果结果不理想，尝试纠错后的查询
    if len(original_results) < 3:
        corrected_query = await cached_correct(query)
        if corrected_query != query:
            corrected_results = await search_fn(corrected_query)
            return {
                "query": query,
                "corrected_query": corrected_query,
                "results": corrected_results,
                "correction_applied": True,
            }

    return {
        "query": query,
        "corrected_query": None,
        "results": original_results,
        "correction_applied": False,
    }
```

### "您是否想搜索" 提示逻辑

```python
CORRECTION_THRESHOLD = 0.7  # 置信度阈值

def suggest_correction(query: str, corrected: str, confidence: float) -> dict:
    """返回纠错建议，而非强制替换"""
    if query == corrected or confidence < CORRECTION_THRESHOLD:
        return {"original": query, "suggestion": None}

    return {
        "original": query,
        "suggestion": corrected,
        "message": f"您是否想搜索：{corrected}？",
    }
```
