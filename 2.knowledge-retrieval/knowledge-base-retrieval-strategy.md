# 知识库裁剪与命中策略

## 一、裁剪策略（压缩知识库）

### 1. 文本压缩

| 方法 | 说明 |
|------|------|
| **语义摘要** | 用 LLM 对每个 chunk 生成摘要，只存摘要或摘要+原文 |
| **滑动窗口** | 512 tokens 窗口，保留核心语义 + 上一段的 context |
| **层次化索引** | 大段→小段→句子多级索引，按需检索 |

### 2. 向量压缩

| 方法 | 说明 |
|------|------|
| **降维** | 1024维 → 128维，减少存储但保留主要语义 |
| **二值化** | 使用二进制向量（0/1），极快检索 |
| **聚类** | 相似的知识块聚类，只存储代表点 |

### 3. 知识结构化

```
原始文档 → 结构化知识（实体、关系、属性） → 知识图谱
```

## 二、命中策略（检索增强）

### 1. 检索流程

```
用户问题 → 向量检索 → 候选 chunks → 重排序 → 上下文
```

### 2. 常见检索方式

| 方式 | 适用场景 |
|------|----------|
| **向量检索** | 语义相似、概念相关 |
| **关键词检索（BM25）** | 精确术语、专有名词 |
| **混合检索** | 结合两者优势 |
| **知识图谱检索** | 关系型知识、实体问答 |

### 3. 命中优化

- **Top-K 召回**：先召回 K 个候选（如 K=20）
- **Rerank 重排**：用更大模型对候选重新排序
- **上下文窗口**：问题附近的 chunks 优先

## 三、关键权衡

| 策略 | 优点 | 缺点 |
|------|------|------|
| 压缩多 | 降低上下文压力 | 可能丢失细节 |
| 保留多 | 信息完整 | 成本高、可能引入噪声 |
| 精确检索 | 命中准确 | 泛化能力弱 |
| 语义检索 | 理解意图 | 可能文不对题 |

## 四、推荐配置

```
推荐方案：
1. chunk 大小：256~512 tokens
2. overlap：保留 10~15% 跨 chunk 语义
3. 索引：向量 + 关键词混合索引
4. 召回：Top-K = 5~10，再 Rerank 精选 3~5
```

## 五、架构示意

```
┌─────────────────────────────────────────────────────────┐
│                      用户问题                            │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    混合检索引擎                          │
│  ┌─────────────┐              ┌─────────────┐           │
│  │  向量检索   │              │  BM25检索   │           │
│  │ (语义相似) │              │ (关键词匹配) │           │
│  └─────────────┘              └─────────────┘           │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                     Top-K 召回                          │
│                   (如 K=20)                             │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    Rerank 重排                          │
│              (更大模型评分精选 3~5)                      │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    上下文窗口                            │
│                 (最终输入 LLM)                          │
└─────────────────────────────────────────────────────────┘
```

---

## 六、高级检索策略（Advanced RAG）

### 1. HyDE — 假设文档嵌入（Hypothetical Document Embeddings）

**核心思想**：先让 LLM 根据问题生成一段"假想的答案"，再用这个假想答案去检索，而不是直接用问题检索。

**为什么有效**：向量空间中"答案与答案"的相似度通常高于"问题与答案"的相似度，HyDE 填补了这个语义鸿沟。

```python
from langchain.chat_models import ChatOpenAI
from langchain.embeddings import OpenAIEmbeddings
from langchain.vectorstores import Chroma

llm = ChatOpenAI(temperature=0)
embeddings = OpenAIEmbeddings()

def hyde_retrieve(question: str, vectorstore, k: int = 5):
    # Step 1：生成假设文档
    hyde_prompt = f"""请根据以下问题，写一段简短的假设性答案（即使你不确定答案，也请尽力生成）：

问题：{question}

假设答案："""
    hypothetical_doc = llm.predict(hyde_prompt)

    # Step 2：用假设文档的向量检索真实文档
    query_embedding = embeddings.embed_query(hypothetical_doc)
    docs = vectorstore.similarity_search_by_vector(query_embedding, k=k)

    return docs, hypothetical_doc

# 使用示例
docs, hypo = hyde_retrieve("什么是向量数据库的 HNSW 索引？", vectorstore)
```

**适用场景**：问题比较抽象、开放式或技术性强时效果显著；对文档覆盖不全时尤其有用。

---

### 2. Multi-Query Retrieval — 多角度查询

**核心思想**：用 LLM 将原始问题改写为多个不同角度的子问题，分别检索后合并去重。

**为什么有效**：单一问题可能只匹配文档的一个侧面，多角度查询覆盖更多召回面。

```python
from langchain.retrievers.multi_query import MultiQueryRetriever
from langchain.chat_models import ChatOpenAI

llm = ChatOpenAI(temperature=0)

# 使用 LangChain 内置的 MultiQueryRetriever
retriever = MultiQueryRetriever.from_llm(
    retriever=vectorstore.as_retriever(),
    llm=llm
)

# 手动实现版本，控制改写 prompt
def multi_query_retrieve(question: str, vectorstore, n_queries: int = 3):
    rewrite_prompt = f"""请将以下问题改写为 {n_queries} 个不同角度的问题，每行一个：

原始问题：{question}

改写后的问题："""

    rewritten = llm.predict(rewrite_prompt)
    queries = [question] + [q.strip() for q in rewritten.strip().split('\n') if q.strip()]

    # 分别检索，合并去重
    all_docs = {}
    for q in queries:
        docs = vectorstore.similarity_search(q, k=5)
        for doc in docs:
            doc_id = doc.metadata.get('id', doc.page_content[:50])
            all_docs[doc_id] = doc

    return list(all_docs.values())

# 示例：原问题 → 生成多个子查询
# "如何优化 RAG 的召回率？"
# → "RAG 检索增强生成有哪些召回优化方法？"
# → "向量检索精度不足时怎么处理？"
# → "知识库问答系统如何减少漏召回？"
```

---

### 3. Parent Document Retrieval — 父子文档检索

**核心思想**：索引时用小 chunk 建立精细索引，检索时返回其父文档（大 chunk）提供完整上下文。

**解决的问题**：小 chunk 检索精准，但上下文碎片化；大 chunk 上下文完整，但向量匹配模糊。

```python
from langchain.storage import InMemoryStore
from langchain.retrievers import ParentDocumentRetriever
from langchain.text_splitter import RecursiveCharacterTextSplitter

# 父文档切分：较大块（保留上下文）
parent_splitter = RecursiveCharacterTextSplitter(chunk_size=2000, chunk_overlap=200)

# 子文档切分：较小块（用于精准匹配）
child_splitter = RecursiveCharacterTextSplitter(chunk_size=400, chunk_overlap=50)

# 存储层：父文档存 InMemoryStore，子文档向量存 vectorstore
store = InMemoryStore()
retriever = ParentDocumentRetriever(
    vectorstore=vectorstore,
    docstore=store,
    child_splitter=child_splitter,
    parent_splitter=parent_splitter,
)

# 添加文档（自动切分成父子结构）
retriever.add_documents(documents)

# 检索时：子 chunk 匹配 → 返回对应父 chunk
relevant_docs = retriever.get_relevant_documents("问题内容")
# 返回的是父文档，包含完整上下文
```

**效果对比**：

| 方式 | 检索精度 | 上下文完整性 |
|------|---------|------------|
| 纯小 chunk | 高 | 低（碎片化） |
| 纯大 chunk | 低 | 高 |
| **父子文档** | **高** | **高** |

---

### 4. Step-back Prompting — 退一步提问

**核心思想**：对具体问题先生成一个更抽象/通用的"退一步"问题，用两个问题分别检索，合并后回答原问题。

**适用场景**：原问题过于具体，文档中直接匹配不到，但更高层次的文档可以支撑推理。

```python
def stepback_retrieve(question: str, vectorstore):
    # Step 1：生成退一步的抽象问题
    stepback_prompt = f"""给定以下具体问题，请生成一个更抽象、更通用的"退一步"问题，
帮助我们检索到有用的背景知识：

具体问题：{question}

退一步的问题："""
    abstract_question = llm.predict(stepback_prompt)

    # Step 2：两个问题分别检索
    specific_docs = vectorstore.similarity_search(question, k=3)
    abstract_docs = vectorstore.similarity_search(abstract_question, k=3)

    # Step 3：合并上下文
    all_context = specific_docs + abstract_docs

    return all_context, abstract_question

# 示例：
# 具体问题："2024年 GPT-4o 的视觉能力在哪些方面有提升？"
# 退一步问题："多模态大模型的视觉理解能力包括哪些维度？"
```

---

### 5. Self-RAG — 自适应检索

**核心思想**：让 LLM 自己判断什么时候需要检索、检索结果是否有用、生成结果是否忠实。

```python
def self_rag_pipeline(question: str, vectorstore, llm):
    # Step 1：判断是否需要检索
    need_retrieval_prompt = f"""对于以下问题，你是否需要检索外部文档才能回答？

问题：{question}
请回答 Yes 或 No，并简要说明理由。"""

    decision = llm.predict(need_retrieval_prompt)

    if "No" in decision:
        # 直接生成
        return llm.predict(question)

    # Step 2：检索
    docs = vectorstore.similarity_search(question, k=5)

    # Step 3：对每个文档评估相关性（ISREL）
    relevant_docs = []
    for doc in docs:
        relevance_prompt = f"""文档是否与问题相关？
问题：{question}
文档：{doc.page_content}
回答 Relevant 或 Irrelevant："""
        if "Relevant" in llm.predict(relevance_prompt):
            relevant_docs.append(doc)

    # Step 4：生成并验证忠实度（ISSUP）
    context = "\n\n".join([d.page_content for d in relevant_docs])
    answer = llm.predict(f"基于以下文档回答：\n{context}\n\n问题：{question}")

    return answer
```

---

### 6. 策略对比与选型指南

| 策略 | 适用场景 | 额外 LLM 调用 | 实现复杂度 |
|------|---------|--------------|-----------|
| **基础向量检索** | 简单 QA，文档覆盖充分 | 0 | 低 |
| **HyDE** | 抽象问题，问题与文档语义差距大 | 1 | 低 |
| **Multi-Query** | 多角度问题，召回率不足 | 1 | 低 |
| **父子文档** | 上下文碎片化，需要完整段落 | 0 | 中 |
| **Step-back** | 专业术语多，需要背景知识 | 1 | 低 |
| **Self-RAG** | 动态问题，需要自适应 | 多次 | 高 |
| **混合检索** | 专有名词多，召回要求全面 | 0 | 中 |

**推荐组合**：
- 通用知识库：`混合检索 + Rerank + 父子文档`
- 专业领域：`HyDE + 混合检索 + Step-back`
- 复杂推理：`Multi-Query + Self-RAG`

---

## 七、检索质量评估

### RAGAS 评估框架

```python
from ragas import evaluate
from ragas.metrics import (
    faithfulness,         # 生成答案忠实于检索文档
    answer_relevancy,     # 答案与问题相关性
    context_precision,    # 检索文档精确度
    context_recall,       # 检索文档召回率
)
from datasets import Dataset

# 准备评估数据集
eval_data = {
    "question": ["什么是 HyDE？"],
    "answer": ["HyDE 是假设文档嵌入技术..."],
    "contexts": [["HyDE 全称是 Hypothetical Document Embeddings..."]],
    "ground_truth": ["HyDE 通过生成假想答案来改善检索质量"],
}

dataset = Dataset.from_dict(eval_data)

# 运行评估
results = evaluate(
    dataset,
    metrics=[faithfulness, answer_relevancy, context_precision, context_recall],
)

print(results)
# {'faithfulness': 0.85, 'answer_relevancy': 0.90, 'context_precision': 0.75, 'context_recall': 0.80}
```

### 关键指标说明

| 指标 | 含义 | 目标值 |
|------|------|--------|
| **Faithfulness** | 答案是否基于检索内容，不幻觉 | > 0.8 |
| **Answer Relevancy** | 答案是否回答了问题 | > 0.85 |
| **Context Precision** | 检索到的文档有多少是真正有用的 | > 0.7 |
| **Context Recall** | 需要的信息有多少被检索到了 | > 0.75 |
