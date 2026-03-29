# 前端算法应用场景详解

## 一、电商场景

### 1.1 排列组合 (Permutation & Combination)

**场景：SKU 组合问题**

```
商品规格：颜色 [红/蓝/黄] × 尺码 [S/M/L] × 材质 [棉/麻]
问题：生成所有有效组合，过滤无库存组合
```

**典型场景：**
- 购物车最优优惠组合 (动态规划)
- 促销满减凑单 (背包问题)
- 商品多维度筛选

---

## 二、低代码 / DSL 渲染引擎

### DFS 遍历 DSL

```javascript
// DSL 示例
{
  type: 'container',
  children: [
    { type: 'row', children: [...] },
    { type: 'form', children: [...] }
  ]
}

// DFS 遍历
function traverse(node) {
  render(node);
  node.children?.forEach(child => traverse(child));
}
```

**应用场景：**
- 组件树渲染
- 权限树/菜单树
- AST 语法树解析

### BFS 应用
- 层级菜单展开
- 表单级联联动

---

## 三、缓存策略 (LRU/LFU)

### 3.1 LRU Cache（最近最少使用）

**实现原理：**

```javascript
class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map(); // Map 保持插入顺序
  }

  get(key) {
    if (!this.map.has(key)) return -1;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value); // 移到末尾（最新使用）
    return value;
  }

  put(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // 删除最老的（Map 第一个）
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }
}
```

**前端应用场景：**

| 场景 | 说明 |
|------|------|
| **浏览器缓存** | localStorage/sessionStorage 管理 |
| **图片懒加载** | 只加载可视区域图片 |
| **组件缓存** | React Keep-Alive、Vue Keep-alive |
| **接口数据缓存** | SWR/React Query 的缓存策略 |
| **虚拟列表** | 只渲染可视区域 DOM 节点 |

### 3.2 虚拟列表实现（LRU + 懒加载）

```javascript
class VirtualList {
  constructor(options) {
    this.itemHeight = options.itemHeight;
    this.buffer = options.buffer || 3;
    this.getData = options.getData;
    this.cache = new LRUCache(options.cacheSize || 50);
  }

  getVisibleItems(scrollTop) {
    const startIndex = Math.floor(scrollTop / this.itemHeight);
    const visibleCount = Math.ceil(window.innerHeight / this.itemHeight);

    // LRU 缓存命中
    const items = [];
    for (let i = startIndex - this.buffer; i <= startIndex + visibleCount + this.buffer; i++) {
      if (this.cache.get(i)) {
        items.push(this.cache.get(i));
      } else {
        const item = this.getData(i);
        this.cache.put(i, item);
        items.push(item);
      }
    }
    return items;
  }
}
```

---

## 四、Diff 算法（虚拟 DOM）

### 4.1 React Diff 算法

**核心原则：**
1. 只比较同层节点，不跨层级比较
2. 类型不同的节点，直接替换
3. 类型相同的节点，递归比较属性

```javascript
// 简化版 Diff 逻辑
function diff(oldTree, newTree) {
  const patches = [];

  function walk(oldNode, newNode, index = 0) {
    if (!oldNode) {
      patches.push({ type: 'INSERT', node: newNode });
    } else if (!newNode) {
      patches.push({ type: 'REMOVE', index });
    } else if (oldNode.type !== newNode.type) {
      patches.push({ type: 'REPLACE', node: newNode });
    } else {
      // 比较属性
      const propsDiff = diffProps(oldNode.props, newNode.props);
      if (propsDiff.length > 0) {
        patches.push({ type: 'PROPS', props: propsDiff });
      }
      // 递归比较子节点
      oldNode.children.forEach((child, i) => walk(child, newNode.children[i], i));
    }
  }

  walk(oldTree, newTree);
  return patches;
}
```

### 4.2 Vue 3 静态标记 + 靶向更新

```javascript
// Vue3 静态提升 + 靶向更新
const oldVNode = {
  type: 'div',
  props: { class: 'container' },
  children: [
    { type: 'span', props: { class: 'static' }, children: 'text' },
    { type: 'span', props: { class: 'dynamic' }, children: '{{msg}}' }
  ]
};

// patchFlag 标记动态节点
const newVNode = {
  type: 'div',
  props: { class: 'container' },
  children: [
    { type: 'span', props: { class: 'static' }, children: 'text' },
    { type: 'span', props: { class: 'dynamic', patchFlag: 1 }, children: '{{msg}}' }
  ]
};

// 只比较有 patchFlag 的节点
```

### 4.3 应用场景

| 场景 | 算法选择 |
|------|----------|
| **React 16+** | Fiber 链表 + requestIdleCallback |
| **Vue 2** | 双端对比 + 静态节点标记 |
| **Vue 3** | 靶向更新 + 静态提升 |
| **图片列表** | keys + 移动检测 |
| **表单场景** | Input 靶向更新 |

---

## 五、图论算法

### 5.1 Dijkstra 最短路径

**场景：地图导航、流程审批路径**

```javascript
function dijkstra(graph, start, end) {
  const distances = {};
  const previous = {};
  const unvisited = new Set(Object.keys(graph));

  // 初始化
  for (const node of unvisited) {
    distances[node] = node === start ? 0 : Infinity;
  }

  while (unvisited.size > 0) {
    // 找到最近节点
    const current = [...unvisited].reduce((a, b) =>
      distances[a] < distances[b] ? a : b
    );

    if (current === end) break;
    unvisited.delete(current);

    // 更新邻居距离
    for (const [neighbor, weight] of Object.entries(graph[current])) {
      const distance = distances[current] + weight;
      if (distance < distances[neighbor]) {
        distances[neighbor] = distance;
        previous[neighbor] = current;
      }
    }
  }

  // 还原路径
  const path = [];
  let current = end;
  while (current) {
    path.unshift(current);
    current = previous[current];
  }
  return path;
}
```

**前端应用：**
- 思维导图/流程图最短路径
- 多人协作编辑的冲突解决（OT 算法底层）
- 游戏地图寻路

### 5.2 并查集 (Union-Find)

**场景：连通分量检测、依赖解析**

```javascript
class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x) {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]); // 路径压缩
    }
    return this.parent[x];
  }

  union(x, y) {
    const px = this.find(x), py = this.find(y);
    if (px === py) return false;

    // 按秩合并
    if (this.rank[px] < this.rank[py]) {
      this.parent[px] = py;
    } else if (this.rank[px] > this.rank[py]) {
      this.parent[py] = px;
    } else {
      this.parent[py] = px;
      this.rank[px]++;
    }
    return true;
  }
}
```

**应用：**
- 组件依赖关系检测（循环依赖）
- webpack 模块联邦依赖分析
- 表单联动关系判断

---

## 六、字符串算法

### 6.1 KMP 算法

**场景：搜索高亮、敏感词过滤**

```javascript
function buildKMPTable(pattern) {
  const table = [0];
  let j = 0;

  for (let i = 1; i < pattern.length; i++) {
    while (j > 0 && pattern[i] !== pattern[j]) {
      j = table[j - 1];
    }
    if (pattern[i] === pattern[j]) j++;
    table[i] = j;
  }
  return table;
}

function kmpSearch(text, pattern) {
  const table = buildKMPTable(pattern);
  const positions = [];
  let j = 0;

  for (let i = 0; i < text.length; i++) {
    while (j > 0 && text[i] !== pattern[j]) {
      j = table[j - 1];
    }
    if (text[i] === pattern[j]) j++;
    if (j === pattern.length) {
      positions.push(i - j + 1);
      j = table[j - 1];
    }
  }
  return positions;
}
```

**前端应用：**
- 搜索关键词高亮
- 敏感词/广告词检测
- 代码编辑器 Ctrl+F

### 6.2 前缀树 (Trie)

**场景：搜索联想、输入法**

```javascript
class Trie {
  constructor() {
    this.children = {};
    this.isEnd = false;
  }

  insert(word) {
    let node = this;
    for (const char of word) {
      if (!node.children[char]) {
        node.children[char] = new Trie();
      }
      node = node.children[char];
    }
    node.isEnd = true;
  }

  search(word) {
    let node = this;
    for (const char of word) {
      if (!node.children[char]) return false;
      node = node.children[char];
    }
    return node.isEnd;
  }

  startsWith(prefix) {
    let node = this;
    for (const char of prefix) {
      if (!node.children[char]) return false;
      node = node.children[char];
    }
    return true;
  }
}
```

**应用：**
- 搜索框自动补全
- 拼音输入法候选词
- 路由前缀匹配

---

## 七、滑动窗口

### 7.1 通用滑动窗口

```javascript
function slidingWindow(nums, k) {
  let left = 0, right = 0;
  const window = new Map(); // 窗口状态
  const result = [];

  while (right < nums.length) {
    // 扩大窗口
    const item = nums[right];
    window.set(item, (window.get(item) || 0) + 1);
    right++;

    // 收缩窗口
    while (window.get(item) > k) {
      const leftItem = nums[left];
      window.set(leftItem, window.get(leftItem) - 1);
      left++;
    }

    result.push(/* 当前窗口状态 */);
  }
  return result;
}
```

### 7.2 防抖节流实现

```javascript
// 防抖实现（时间窗口）
function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fn.apply(this, args);
    }, delay);
  };
}

// 节流实现（固定间隔）
function throttle(fn, interval) {
  let lastTime = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastTime >= interval) {
      lastTime = now;
      fn.apply(this, args);
    }
  };
}
```

**应用场景：**

| 场景 | 题目示例 |
|------|----------|
| **防抖节流** | 拖拽计算位置 |
| **长列表练习** | 最多出现 K 次的子串 |
| **缓存池** | 连接池管理 |
| **数据流** | 滑动平均值 |

---

## 八、动态规划

### 8.1 经典问题：背包问题

**场景：购物车最优优惠组合**

```javascript
function knapSack(items, capacity) {
  const n = items.length;
  const dp = Array(n + 1).fill(0).map(() => Array(capacity + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    const { weight, value } = items[i - 1];
    for (let w = 0; w <= capacity; w++) {
      if (weight <= w) {
        dp[i][w] = Math.max(dp[i - 1][w], dp[i - 1][w - weight] + value);
      } else {
        dp[i][w] = dp[i - 1][w];
      }
    }
  }
  return dp[n][capacity];
}
```

**电商应用：**
- 满减凑单最优解
- 红包叠加规则
- 优惠券组合

### 8.2 编辑距离 (Levenshtein)

```javascript
function editDistance(word1, word2) {
  const m = word1.length, n = word2.length;
  const dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (word1[i - 1] === word2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,     // 删除
          dp[i][j - 1] + 1,     // 插入
          dp[i - 1][j - 1] + 1  // 替换
        );
      }
    }
  }
  return dp[m][n];
}
```

**应用：**
- 搜索纠错（"输错了" → "输错了" 提示）
- 代码 diff 工具
- DNA 序列比对

---

## 九、回溯算法

### 9.1 全排列

```javascript
function permute(nums) {
  const result = [];

  function backtrack(path, used) {
    if (path.length === nums.length) {
      result.push([...path]);
      return;
    }

    for (let i = 0; i < nums.length; i++) {
      if (used[i]) continue;
      path.push(nums[i]);
      used[i] = true;
      backtrack(path, used);
      path.pop();
      used[i] = false;
    }
  }

  backtrack([], Array(nums.length).fill(false));
  return result;
}
```

### 9.2 应用场景

| 场景 | 算法 |
|------|------|
| **表单生成器** | 枚举所有可能的表单项组合 |
| **权限树** | 所有可能的权限组合 |
| **测试用例** | 场景组合覆盖 |
| **数独求解** | 回溯 + 剪枝 |

---

## 十、位运算与概率算法

### 10.1 布隆过滤器 (Bloom Filter)

**场景：推荐去重、搜索历史**

```javascript
class BloomFilter {
  constructor(size = 100000, hashCount = 3) {
    this.size = size;
    this.hashCount = hashCount;
    this.bitArray = new BitArray(size);
  }

  add(item) {
    for (let i = 0; i < this.hashCount; i++) {
      const index = this.hash(item, i);
      this.bitArray.set(index);
    }
  }

  contains(item) {
    for (let i = 0; i < this.hashCount; i++) {
      const index = this.hash(item, i);
      if (!this.bitArray.get(index)) return false;
    }
    return true;
  }

  hash(str, seed) {
    // 简单的哈希函数
    let hash = seed * 31 + str.charCodeAt(0);
    return hash % this.size;
  }
}
```

**应用：**
- 已读消息去重（可能误判，但空间极小）
- 搜索历史去重
- 商品推荐去重

---

## 十一、总结表格

| 算法 | 核心思想 | 前端高频场景 |
|------|----------|-------------|
| LRU Cache | 时间换空间 | 虚拟列表、组件缓存 |
| Diff | 靶向更新 | 虚拟 DOM |
| Dijkstra | 最短路径 | 流程图、导航 |
| KMP | 字符串匹配 | 搜索高亮 |
| Trie | 前缀树 | 自动补全 |
| 滑动窗口 | 范围缩小 | 防抖节流 |
| 动态规划 | 状态压缩 | 满减凑单 |
| 回溯 | 枚举+剪枝 | 表单生成 |
| 布隆过滤器 | 概率去重 | 推荐系统 |

---

## 十二、核心思想

1. **时间换空间**：虚拟滚动、防抖节流
2. **空间换时间**：缓存、备忘录
3. **分治思想**：大规模 DOM 分片渲染
4. **递归转迭代**：深度遍历避免栈溢出
