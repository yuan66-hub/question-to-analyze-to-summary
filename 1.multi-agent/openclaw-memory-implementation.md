# OpenClaw Memory 实现详解

> 本文档基于 [OpenClaw GitHub 官方仓库](https://github.com/openclaw/openclaw) 的源码和文档分析
>
> 最后更新：2026-03-28

## 概述

OpenClaw 的 Memory 不是传统意义上的 RAG (Retrieval-Augmented Generation)，而是一个基于**语义搜索**的多层记忆系统。它将记忆存储在 Markdown 文件中，通过向量嵌入实现语义检索。

## 核心架构

### 1. 记忆存储层 (File-Based Memory)

```
workspace/
├── MEMORY.md              # 根记忆文件 (永不过期)
└── memory/                # 分类记忆目录
    ├── projects.md        # 项目相关
    ├── 2026-03-28.md      # 按日期的日记式记忆
    └── ...
```

**关键特性：**
- Markdown 文件作为唯一事实来源 (SSOT - Single Source of Truth)
- `MEMORY.md` 和非日期文件永不做时间衰减
- 日期文件 (`memory/YYYY-MM-DD.md`) 享受时间衰减优化

### 2. 检索引擎 (Pluggable Context Engine)

OpenClaw 采用**可插拔架构**，支持多种 Context Engine：

| Engine | 描述 |
|--------|------|
| `legacy` | 内置引擎，原生压缩和上下文组装 |
| 自定义插件 | 可注入自己的 Context Engine 实现 |

**Context Engine 生命周期：**

```typescript
interface ContextEngine {
  // 1. Ingest - 新消息进入时存储
  ingest({ sessionId, message, isHeartbeat });

  // 2. Assemble - 构建模型上下文
  assemble({ sessionId, messages, tokenBudget });

  // 3. Compact - 压缩上下文窗口
  compact({ sessionId, force });

  // 4. After Turn - 持久化/后台压缩
  afterTurn({ sessionId });
}
```

### 3. 记忆搜索流程 (Memory Search Pipeline)

```
用户查询 → 向量检索 + BM25 → 分数融合 → MMR去重 → 时间衰减 → Top-K结果
```

#### 3.1 混合搜索 (Hybrid Search)

**向量检索** (Vector Similarity)：
- 语义匹配："Mac Studio gateway host" ≈ "the machine running the gateway"
- 弱点：对精确 token (ID、环境变量、代码符号) 不敏感

**BM25 全文检索**：
- 精确匹配：IDs (`a828e60`)、代码符号、错误字符串
- 弱点：无法处理同义词/ paraphrases

**分数融合：**
```typescript
finalScore = vectorWeight * vectorScore + textWeight * textScore
// 默认: vectorWeight=0.7, textWeight=0.3
```

#### 3.2 MMR 去重 (Maximal Marginal Relevance)

解决多个相似片段重复返回的问题：

```
查询: "home network setup"

无 MMR:
1. memory/2026-02-10.md (score: 0.92) - router + VLAN
2. memory/2026-02-08.md (score: 0.89) - router + VLAN (近似重复!)
3. memory/network.md   (score: 0.85)

有 MMR (lambda=0.7):
1. memory/2026-02-10.md (score: 0.92)
2. memory/network.md   (score: 0.85) - 多样化!
3. memory/2026-02-05.md (score: 0.78) - 多样化!
```

#### 3.3 时间衰减 (Temporal Decay)

对日期文件应用指数衰减：

```
decayedScore = score × e^(-λ × ageInDays)
// λ = ln(2) / halfLifeDays (默认 halfLife = 30天)
```

**衰减示例：**
| 时间 | 原始分数 | 衰减后 |
|------|---------|--------|
| 今天 | 0.82 | 0.82 (100%) |
| 7天前 | 0.80 | 0.68 (85%) |
| 30天前 | 0.91 | 0.46 (50%) |
| 90天前 | 0.95 | 0.12 (12.5%) |

### 4. 向量存储 (Vector Store)

**默认存储：** SQLite + sqlite-vec 扩展

```
~/.openclaw/memory/<agentId>.sqlite
```

**索引内容：**
- 文件路径
- 分块 (chunk)：~400 tokens，80 token 重叠
- 向量嵌入 (3072 维，默认 Gemini-embedding-2)
- 元数据 (日期、来源)

### 5. 嵌入提供者 (Embedding Providers)

| Provider | 模型 | 特点 |
|----------|------|------|
| `local` | ggml-org/embeddinggemma-300m | 本地离线 |
| `openai` | text-embedding-3-small | 快速/便宜 |
| `gemini` | gemini-embedding-2-preview | 3072 维，支持多模态 |
| `voyage` | voyage-3 | - |
| `mistral` | mistral-embed | - |
| `ollama` | 自托管 | - |

**多模态支持** (Gemini only)：
- 图片：`.jpg`, `.png`, `.webp`, `.gif`, `.heic`, `.heif`
- 音频：`.mp3`, `.wav`, `.ogg`, `.opus`, `.m4a`, `.aac`, `.flac`

### 6. 记忆工具 (Memory Tools)

```typescript
// 语义搜索
memory_search({
  query: "meeting notes",
  maxResults: 6,
  minScore: 0.5
})
// 返回: [{ snippet, path, lineRange, score, provider }]

// 读取指定记忆文件
memory_get({
  path: "memory/projects.md",
  startLine: 1,
  maxLines: 100
})
```

### 7. 同步机制 (Sync)

```
文件变化 (debounce 1.5s)
    ↓
标记 index 为 dirty
    ↓
后台重新索引 (异步)
    ↓
搜索时检测并触发同步
```

**触发条件：**
- 启动时
- 搜索时
- 定时间隔 (默认 5m)

## 上下文与记忆的关系

| 概念 | 存储位置 | 生命周期 |
|------|---------|---------|
| **Context** | 模型上下文窗口 | 当前 Run |
| **Memory** | 磁盘 (Markdown) | 持久化 |
| **Session** | JSONL 文件 | 跨会话 |

**上下文组装流程：**
```
System Prompt
  ├── Tools list + schemas
  ├── Skills list (metadata only)
  ├── Workspace bootstrap files
  │   ├── AGENTS.md
  │   ├── SOUL.md
  │   ├── TOOLS.md
  │   └── ...
  ├── Conversation History
  └── Memory Search Results (注入)
```

## 关于 "GAG" / RAG

GAG 应该是 **RAG (Retrieval-Augmented Generation)** 的误写或变体。OpenClaw 的 Memory 正是基于 **RAG 架构**实现的。

### OpenClaw RAG 流程

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│   Query     │───▶│  Retrieval   │───▶│  Generation │
│  (用户输入)  │    │  (向量+BM25) │    │  (模型回答)  │
└─────────────┘    └──────────────┘    └─────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  Memory Store   │
              │  (Markdown文件)  │
              │  + SQLite向量库  │
              └─────────────────┘
```

### 完整 RAG Pipeline

1. **Indexing (索引阶段)**
   - 读取 `MEMORY.md` 和 `memory/**/*.md`
   - 分块 (Chunking): ~400 tokens，80 token overlap
   - 使用 Embedding 模型生成向量
   - 存储到 SQLite 向量库

2. **Retrieval (检索阶段)**
   - 用户查询 → Embedding
   - 向量相似度搜索 (Top-K)
   - BM25 关键词搜索
   - 分数融合 + MMR 去重 + 时间衰减

3. **Generation (生成阶段)**
   - 检索结果作为上下文注入 System Prompt
   - 模型基于增强的上下文生成回答

### 与标准 RAG 的区别

| 特性 | 标准 RAG | OpenClaw Memory |
|------|---------|-----------------|
| 存储格式 | 通常 Vector DB | **Markdown 文件** (SSOT) |
| 向量存储 | 专用向量数据库 | **SQLite + sqlite-vec** |
| 检索方式 | 纯向量检索 | **混合搜索** (Vector + BM25) |
| 后处理 | 简单 | **MMR + 时间衰减** |
| Context Engine | 固定 | **可插拔** |

OpenClaw 的设计理念：**文件即记忆，向量只是索引**。

## 配置示例

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "gemini",
        model: "gemini-embedding-2-preview",
        query: {
          hybrid: {
            enabled: true,
            vectorWeight: 0.7,
            textWeight: 0.3,
            mmr: { enabled: true, lambda: 0.7 },
            temporalDecay: { enabled: true, halfLifeDays: 30 }
          }
        }
      }
    }
  }
}
```

## 参考链接

- [OpenClaw Memory 文档](./docs/concepts/memory.md)
- [OpenClaw Context 文档](./docs/concepts/context.md)
- [OpenClaw Context Engine](./docs/concepts/context-engine.md)
- [Memory Config Reference](./docs/reference/memory-config.md)
