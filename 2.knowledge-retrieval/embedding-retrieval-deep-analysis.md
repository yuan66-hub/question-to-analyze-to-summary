# Embedding 检索深度解析

## 什么是 Embedding 检索？

Embedding检索是基于向量相似度的信息检索方法。核心思想是将文本、图像、音频等数据通过embedding模型转换为稠密向量，然后在向量空间中进行相似度计算，找到与查询最匹配的结果。

```
query embedding → 向量数据库 → ANN近似最近邻搜索 → 返回结果
```

---

## 一、核心原理

### 1.1 向量化过程

```
原始数据 (文本/图像/音频)
       ↓
   Embedding Model (如 BERT、CLIP、Sentence-BERT)
       ↓
   稠密向量 (通常 256~1536 维)
```

**Embedding模型类型**:

| 类型 | 代表模型 | 输出维度 | 适用场景 |
|------|---------|---------|---------|
| 文本 | Word2Vec、GloVe | 100~300 | 词级别相似 |
| 文本 | BERT、Sentence-BERT | 768~1536 | 句子/段落语义 |
| 图像 | ResNet、EfficientNet | 512~2048 | 图像特征 |
| 多模态 | CLIP、BLIP | 512~768 | 图文跨模态 |

### 1.2 相似度度量

```python
# 余弦相似度 (最常用)
cosine_sim(a, b) = (a · b) / (||a|| × ||b||)
# 取值范围 [-1, 1]，越接近1越相似

# 点积 (当向量已归一化时，等价于余弦)
dot_product = Σ(a_i × b_i)

# 欧氏距离
euclidean = √(Σ(a_i - b_i)²)
```

### 1.3 搜索流程

```
用户查询
   ↓
查询文本 → Embedding Model → 查询向量 Q
   ↓
Q 与 数据库中所有向量 计算相似度
   ↓
排序取 Top-K
   ↓
返回对应原始数据
```

---

## 二、索引结构 (ANN算法)

精确搜索需要 O(N) 时间遍历所有向量，无法应对大规模数据。使用 **近似最近邻(ANN)** 索引:

### 2.1 常见索引算法

| 算法 | 核心思想 | 优点 | 缺点 |
|------|---------|------|------|
| **HNSW** | 分层可导航小世界图 | 高召回、毫秒级 | 内存占用大 |
| **IVF-Flat** | 倒排索引+聚类 | 可解释、精确 | 召回率依赖聚类数 |
| **PQ (Product Quantization)** | 向量分块量化 | 压缩率高、内存小 | 有精度损失 |
| **LSH** | 随机投影哈希 | 简单、保证召回 | 内存占用高、慢 |

### 2.2 HNSW详解 (Hierarchical Navigable Small World)

```
Layer 2:  [node] ────────── [node]      ← 粗粒度跳跃
Layer 1:  [node] ── [node] ── [node]
Layer 0:  [node]─[node]─[node]─[node]─[node]  ← 精确定位
```

**搜索过程**: 从顶层入口，贪心地向最邻近节点移动，跳跃到下层直到第0层

**参数调优**:
- `M`: 每个节点的最大连接数 (通常 16~64)
- `efConstruction`: 构建时的动态列表大小
- `efSearch`: 搜索时的候选集大小

---

## 三、主流向量数据库

| 数据库 | 特点 | 单节点向量容量 | 适用场景 |
|--------|------|--------------|---------|
| **Pinecone** | 全托管云服务 | 无限制 | 企业级、免运维 |
| **Milvus** | 开源、成熟 | ~10亿 | 大规模、自部署 |
| **Qdrant** | Rust实现、高性能 | ~1亿 | 实时性要求高 |
| **Weaviate** | 原生支持混合搜索 | ~10亿 | 需同时支持结构化数据 |
| **Redis** (Vector) | 复用现有Redis | ~1亿 | 已有Redis生态 |
| **Chroma** | 轻量、Python优先 | ~1000万 | 原型验证、快速开发 |

---

## 四、典型应用场景

### 4.1 RAG (Retrieval Augmented Generation)

```
用户问题
    ↓
Embedding → 向量数据库检索 → Top-K 相关文档
    ↓
[检索到的文档] + [用户问题] → LLM 生成回答
```

**RAG评分标准**:
- Hit Rate@K: Top-K中命中的比例
- MRR (Mean Reciprocal Rank): 第一个命中位置的倒数均值
- NDCG@K: 考虑排序的相关性评分

### 4.2 语义搜索 vs 关键词搜索

| 查询 | 关键词搜索 | 语义搜索 (Embedding) |
|------|----------|-------------------|
| "苹果" | 精确匹配"苹果" | 水果/公司相关都能返回 |
| "如何减肥" | 精确匹配"减肥" | 瘦身、控制饮食、健身等相关 |
| "pay for stuff" | 无法匹配 | "purchase items" 语义相近可返回 |

### 4.3 其他应用

- **推荐系统**: 用户行为序列 → embedding → 找相似item
- **图像相似搜索**: 以图搜图、版权检测
- **异常检测**: embedding距离异常大的点为异常
- **聚类分析**: embedding空间中的自然聚类

---

## 五、技术挑战与解决方案

### 5.1 维度选择

```
维度太低 → 表达能力不足，相似点区分不开
维度太高 → 维度灾难，稀疏性增加，存储/计算成本↑

经验公式: d ≈ 1.5 × log₂(N) × (1/ε²)，N为数据量，ε为误差界
实际常用: 256~1536维
```

### 5.2 向量数据库的核心参数

```python
# Pinecone示例
pinecone.create_index(
    name="my-index",
    dimension=1536,          # 向量维度
    metric="cosine",          # 相似度度量
    pods=1,
    replicas=1,
    pod_type="p1.x1"
)

# Qdrant示例
client.create_collection(
    collection_name="my_collection",
    vectors_size=768,
    distance="Cosine"
)
```

### 5.3 混合搜索 (Hybrid Search)

```
用户查询: "如何学习Python"
    ↓
[关键词部分] + [语义部分]
    ↓              ↓
BM25/BM25          Embedding检索
    ↓              ↓
  Score₁ ────── Score₂
       ↓
   RRF (Reciprocal Rank Fusion) 或 加权融合
       ↓
    最终排序结果
```

### 5.4 重排序 (Re-ranking)

```
向量检索 (Top-100) → 交叉编码器重排 → Top-10 精确结果

常用重排模型:
- bge-reranker (BAAI)
- Cohere Rerank
- 传统: Learnable Rank (LTR)
```

---

## 六、Embedding质量评估

### 6.1 常用benchmark

| Benchmark | 任务 | 代表数据集 |
|-----------|------|----------|
| **MTEB** | 全面评估 | 58个数据集，涵盖分类、聚类、检索等 |
| **BEIR** | 检索评估 | 17个专业领域 |
| **SimCSE** | 句子对相似度 | STS-B、SNLI |

### 6.2 离线评估指标

```python
# 检索评估
def evaluate_retrieval(retrieved_ids, relevant_ids, k):
    hit = len(set(retrieved_ids[:k]) & set(relevant_ids)) / len(relevant_ids)

    # MRR
    for i, doc in enumerate(retrieved_ids):
        if doc in relevant_ids:
            mrr = 1 / (i + 1)
            break

    # NDCG@K
    dcg = sum(1 / np.log2(i + 2) for i in range(k) if retrieved_ids[i] in relevant_ids)
    idcg = sum(1 / np.log2(i + 2) for i in range(len(relevant_ids)))
    ndcg = dcg / idcg if idcg > 0 else 0
```

---

## 七、工程实践建议

### 7.1 选型决策树

```
数据量 < 100万?
├── 是: Redis / Chroma (快速启动)
└── 否: 需要生产级方案
       │
       是否需要云服务?
       ├── 是: Pinecone / Azure Vector Search
       └── 否: Milvus / Qdrant (自部署)

是否需要混合搜索(向量+关键词)?
├── 是: Weaviate / Elasticsearch (KNN)
└── 否: Qdrant (性能优先)
```

### 7.2 性能优化技巧

1. **批量索引**: 攒批写入，减少I/O
2. **异步写入**: 写入与查询分离
3. **分区(Partition/Shard)**: 按业务线隔离，减少搜索范围
4. **预过滤**: 先过滤结构化字段，再向量检索
5. **缓存热点**: 热门查询结果缓存

### 7.3 监控指标

- **QPS**: 查询吞吐量
- **Latency P99**: 99分位延迟
- **Index Size**: 索引大小 vs 原始大小 (压缩比)
- **Recall@K**: 召回率 vs 精确搜索

---

## 八、成本估算参考

| 方案 | 100万向量/月 | 1亿向量/月 |
|------|------------|----------|
| Pinecone | ~$200 | ~$2000 |
| Azure AI Search | ~$300 | ~$3000 |
| 自建 Milvus (3节点) | ~$500 (EC2) | ~$5000 |

---

## 九、场景-技术矩阵

| 场景 | Embedding模型 | 向量数据库 | 索引算法 | 混合搜索 | 重排 |
|------|--------------|-----------|---------|---------|------|
| **RAG** | bge-large | Milvus/Pinecone | HNSW | ✅ | ✅ |
| **电商搜索** | text2vec | Milvus | HNSW+分区 | ✅ | 可选 |
| **推荐系统** | DSSM/Mind | Faiss | IVF-PQ | ❌ | ✅ |
| **图像检索** | CLIP/ResNet | Qdrant | HNSW | ❌ | ❌ |
| **代码搜索** | CodeBERT | Elasticsearch | HNSW | ✅ | ✅ |
| **异常检测** | AE/IF | - | - | - | - |
| **意图识别** | MiniLM | Redis | HNSW | ❌ | ❌ |

---

## 十 Cursor vs Claude Code 检索方案

### 10.1 核心差异

| 维度 | Cursor | Claude Code |
|------|--------|-------------|
| **检索核心** | Embedding + AST结构 | Glob + Grep + Read |
| **向量模型** | Code-specific embedding | 可配置 (OpenAI/Gemini等) |
| **索引方式** | 实时索引代码库 | 无持续索引，按需搜索 |
| **代码理解** | Treesitter AST | 文件内容 + 正则 |
| **混合搜索** | Vector + 结构 + 精确 | 纯文本搜索为主 |
| **上下文上限** | 动态窗口 | Token Budget控制 |
| **更新机制** | 文件变化触发重索引 | 每次命令重新读取 |

### 10.2 Cursor 检索架构

```
用户查询/光标位置
       ↓
   ┌───┴───┐
   ↓       ↓
代码结构   语义向量
分析       检索
   ↓       ↓
   └───┬───┘
       ↓
   分数融合 → 重排 → 上下文注入
```

**独特设计 - Context Pool**:
- 维护滑动窗口的候选上下文池
- 根据与当前光标的**距离**和**相关性**动态调整

**Prefix/suffix aware**:
- 理解当前编辑位置之前的代码 (prefix)
- 理解即将编写的代码结构 (suffix)
- 检索时考虑双向上下文

### 10.3 Claude Code 检索架构

```
用户请求
    ↓
解析WORKSPACE目录结构
    ↓
┌─────────────────────────────────┐
│  1. Glob模式匹配 (文件选择)      │
│  2. Grep全文搜索 (内容匹配)       │
│  3. 文件内容读取 (实际上下文)      │
└─────────────────────────────────┘
    ↓
Context压缩 (如果超限)
    ↓
组装到Prompt
```

### 10.4 两者融合趋势 - 现代Agent检索架构

```
┌─────────────────────────────────────────────┐
│           现代Agent检索架构                   │
├─────────────────────────────────────────────┤
│  1. 混合搜索 (Hybrid Search)                │
│     ├── 向量检索 (语义相似)                  │
│     └── BM25/关键词 (精确匹配)               │
│                                             │
│  2. 去重 (MMR - Maximal Marginal Releance) │
│                                             │
│  3. 重排 (Cross-Encoder Reranker)           │
│                                             │
│  4. 时间衰减 (Temporal Decay)               │
│     (近期内容权重更高)                        │
│                                             │
│  5. 可插拔Context Engine                    │
│     (支持自定义检索策略)                      │
└─────────────────────────────────────────────┘
```

### 10.5 一句话总结

| 工具 | 检索范式 | 核心创新 |
|------|---------|---------|
| **Cursor** | Embedding-first + AST结构 | 代码感知窗口 |
| **Claude Code** | Filesystem-first + 工具调用 | 可解释性 + 可控性 |

- Cursor像**"语义优先的代码搜索引擎"**
- Claude Code像**"文件系统操作的智能包装器"**
