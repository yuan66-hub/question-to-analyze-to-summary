# 大规模项目AI快速理解策略

## 问题本质

在几十万代码量级的项目中，AI面临核心矛盾：
- **上下文窗口有限**（通常 128K-1M tokens）
- **代码总量巨大**（可能超过 10M tokens）

核心挑战不是"让AI看完所有代码"，而是**构建多层抽象，让AI按需获取**。

---

## 核心策略一：分层抽象降维

### 四层结构模型

```
┌─────────────────────────────────────────────────┐
│  Level 0: 项目全景图                              │
│  - 目录结构、模块划分、语言栈                      │
│  - AI首先加载，2-5KB 建立全局感                     │
├─────────────────────────────────────────────────┤
│  Level 1: 模块接口                               │
│  - API、导出函数、类定义、公共接口                  │
│  - 每个模块 1-3KB                                 │
├─────────────────────────────────────────────────┤
│  Level 2: 核心逻辑                               │
│  - 关键实现、核心算法、业务流程                    │
│  - 按需加载，通常 < 50KB                          │
├─────────────────────────────────────────────────┤
│  Level 3: 细节代码                               │
│  - 具体实现、边界情况处理                         │
│  - 极少加载，只在精准定位问题时查阅                │
└─────────────────────────────────────────────────┘
```

### 索引文件示例

创建 `CODEMAP.md` 或在每个目录下创建 `SUMMARY.md`：

```markdown
## 模块: user-service

**职责**: 用户认证、权限管理、会话管理

**入口**: `UserService.start()`, `AuthModule.verify()`

**关键依赖**:
- `db/user-repository` - 用户数据访问
- `cache/session-store` - 会话存储

**关键实体**:
- `User` - 用户实体
- `Permission` - 权限模型

**业务规则**:
- 密码需要 bcrypt 加密，强度要求：8位以上
- Token 有效期 24 小时
```

---

## 核心策略二：生成代码地图

### 依赖关系分析

自动提取 import/export 关系：

```bash
# Python: 提取模块依赖
pip install pipreqs && pipreqs ./ --encoding=utf-8

# JavaScript/TypeScript
npx madge --circular --extensions ts src/

# Go
go mod graph > dependency.txt
```

### 调用图提取

```bash
# C/C++: ctags + cscope
ctags -R .
cscope -R

# Python: pycallgraph
pip install pycallgraph
pycallgraph graphviz --module my_module
```

### 输出格式

```
项目依赖结构:
├── frontend/
│   ├── api-client (依赖: backend-api, utils)
│   └── ui-components (依赖: design-system)
├── backend-api/
│   ├── auth (依赖: db, cache)
│   ├── user-service (依赖: db, auth, notification)
│   └── order-service (依赖: db, payment-gateway, inventory)
└── shared/
    ├── utils (无外部依赖)
    └── types (无外部依赖)
```

---

## 核心策略三：语义聚类

### 按功能领域组织，而非按文件目录

识别每个目录/模块的**职责**，而非仅描述路径：

```markdown
## 功能域: 订单处理

**包含模块**:
- `src/orders/` - 订单 CRUD
- `src/payment/` - 支付流程
- `src/inventory/` - 库存扣减
- `src/notification/` - 订单通知

**核心流程**:
创建订单 → 支付确认 → 库存扣减 → 发送通知 → 订单完成

**关键文件**:
- `orders/create.ts` - 订单创建入口
- `payment/handler.ts` - 支付回调处理
- `inventory/deduct.ts` - 库存事务
```

### 实体关系图

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│   User  │────<│  Order  │────<│ OrderItem│
└─────────┘     └────┬────┘     └─────────┘
                     │
                     ▼
              ┌─────────────┐
              │   Payment   │
              └─────────────┘
```

---

## 核心策略四：增量上下文

### 动态组装流程

```
用户问题
    ↓
意图识别: "用户问的是哪个功能域？"
    ↓
相关模块索引加载 (Level 1)
    ↓
判断: 是否需要深入实现？ (Level 2)
    ↓
按需获取关键文件 (Level 3)
```

### 上下文选择策略

| 问题类型 | 加载范围 |
|----------|----------|
| "模块是做什么的" | Level 0 + 相关模块索引 |
| "某个函数逻辑" | Level 1 索引 + 该函数实现 |
| "这个Bug怎么修" | Level 1 + 相关实现 + 单元测试 |
| "怎么扩展功能" | Level 0 + 1 + 核心领域模型 |

---

## 核心策略五：善用现有文档

优先级：**设计文档 > 类型定义 > 实现 > 注释**

### 文档优先级

1. **README/SUMMARY** - 项目整体介绍
2. **ARCHITECTURE.md** - 架构设计文档
3. **API.md/SWAGGER** - 接口定义
4. **domain model** - 领域模型（ER图、类图）
5. **interface/type** - 类型定义（比实现更高效）

### 提取类型定义

```bash
# TypeScript: 提取所有 interface
grep -r "interface " src/ --include="*.ts" -A 5

# Go: 提取 struct 和 interface
grep -r "type.*struct" . --include="*.go" -A 10
grep -r "type.*interface" . --include="*.go" -A 5
```

---

## 实践工具链

### 快速了解结构

```bash
# 目录结构
tree -L 3 -I 'node_modules|dist|build|.git' .

# 文件统计
find . -name "*.py" -o -name "*.ts" | wc -l

# 大文件检测
find . -name "*.py" -exec wc -l {} + | sort -rn | head
```

### 代码索引

| 工具 | 语言 | 用途 |
|------|------|------|
| ctags/cscope | C/C++ | 符号索引 |
| gtags | 多语言 | 全局符号索引 |
| sourcetrail | 多语言 | 可视化代码地图 |
| madge | JS/TS | 依赖图 |
| pycallgraph | Python | 调用图 |

---

## 实施步骤

### Phase 1: 建立基础 (1-2天)
- [ ] 生成目录结构快照
- [ ] 提取关键模块的索引描述
- [ ] 创建项目全景图

### Phase 2: 自动化 (持续)
- [ ] 集成 pre-commit 生成 CODEMAP
- [ ] CI 自动更新依赖图
- [ ] 文档与代码同步机制

### Phase 3: 智能化 (进阶)
- [ ] 基于 Embedding 的语义搜索
- [ ] LLM 自动生成模块摘要
- [ ] 增量索引更新

---

## 核心原则

> **让AI理解"项目骨架"比塞给它全部代码更有效**

1. **先抽象后具体** - 先建立空间感，再按需深入
2. **索引优于全文** - 索引文件是关键加速器
3. **按需加载** - 不是所有问题都需要看代码
4. **维护成本意识** - 代码地图需要同步更新

---

## 常见错误

| 错误做法 | 后果 |
|----------|------|
| 直接塞全部代码给 AI | 上下文溢出、关键信息被稀释 |
| 忽略文档先看代码 | 效率低下、难以理解设计意图 |
| 只看当前文件 | 缺乏全局视野、容易局部优化 |
| 依赖代码注释理解 | 注释可能过时、不准确 |

---

## CODEMAP.md 完整模板

```markdown
# CODEMAP — [项目名称]

> 最后更新：{{date}}
> 代码行数：{{loc}}
> 主要语言：{{languages}}

---

## 项目全景

### 技术栈

| 层次 | 技术 | 版本 |
|------|------|------|
| 前端 | React / Next.js | 18 / 14 |
| 后端 | Node.js / NestJS | 20 / 10 |
| 数据库 | PostgreSQL + Redis | 15 / 7 |
| 消息队列 | RabbitMQ | 3.12 |
| 部署 | K8s + Helm | - |

### 目录结构（关键路径）

```
src/
├── modules/           # 业务模块（按领域划分）
│   ├── auth/         # 认证授权
│   ├── user/         # 用户管理
│   ├── order/        # 订单处理
│   └── payment/      # 支付
├── shared/            # 公共模块
│   ├── database/     # 数据库连接、Repository 基类
│   ├── cache/        # Redis 缓存封装
│   └── events/       # 事件总线
├── config/            # 配置文件
└── main.ts            # 应用入口
```

---

## 模块索引

### auth 模块

**职责**：JWT 认证、OAuth 第三方登录、权限校验

**入口文件**：`src/modules/auth/auth.module.ts`

**核心方法**：
- `AuthService.login(dto)` — 用户名密码登录，返回 JWT
- `AuthService.refreshToken(token)` — 刷新 AccessToken
- `JwtGuard.canActivate()` — 路由守卫，验证请求 Token

**关键依赖**：
- `UserModule` — 查询用户信息
- `CacheModule` — 存储 RefreshToken 黑名单

**业务规则**：
- AccessToken 有效期 15 分钟
- RefreshToken 有效期 7 天，单设备限制
- 连续失败 5 次锁定账户 30 分钟

---

### order 模块

**职责**：订单生命周期管理（创建→支付→发货→完成→退款）

**状态机**：
```
PENDING → PAID → SHIPPED → DELIVERED → COMPLETED
   ↓         ↓       ↓          ↓
CANCELLED  REFUNDING REFUNDING  REFUNDED
```

**核心方法**：
- `OrderService.create(dto, userId)` — 创建订单，含库存预占
- `OrderService.pay(orderId)` — 触发支付流程
- `OrderEventHandler.onPaymentSuccess()` — 支付成功事件处理

**关键依赖**：
- `InventoryModule` — 库存扣减（分布式事务）
- `PaymentModule` — 支付网关调用
- `NotificationModule` — 订单状态推送

---

## 核心业务流程

### 下单流程

```
用户提交 → 参数校验 → 库存预占 → 创建订单 → 发起支付
    ↓                              ↓           ↓
  校验失败                     超时取消     支付成功/失败
                                  ↓              ↓
                             释放库存         扣减库存
```

---

## 数据模型关系

```
User (1) ──── (N) Order
Order (1) ──── (N) OrderItem
OrderItem (N) ──── (1) Product
Order (1) ──── (1) Payment
```

---

## 对外接口清单

| 接口 | 方法 | 路径 | 认证 | 限流 |
|------|------|------|------|------|
| 登录 | POST | /auth/login | 否 | 10次/分钟 |
| 创建订单 | POST | /orders | 是 | 5次/分钟 |
| 查询订单 | GET | /orders/:id | 是 | 100次/分钟 |

---

## 常见问题排查索引

| 问题现象 | 排查入口 |
|---------|---------|
| 登录失败 | `AuthService.login` → `UserRepository.findByUsername` |
| 订单不更新 | `OrderEventHandler` → RabbitMQ 消费者日志 |
| 支付回调未处理 | `PaymentController.webhook` → 幂等性检查 |
```

---

## pre-commit 自动更新 CODEMAP

```bash
#!/bin/bash
# .git/hooks/pre-commit 或 .husky/pre-commit

set -e

echo "📖 更新 CODEMAP.md..."

# 统计代码行数
LOC=$(find src -name "*.ts" | xargs wc -l | tail -1 | awk '{print $1}')

# 更新日期
DATE=$(date '+%Y-%m-%d')

# 自动更新 CODEMAP 头部信息
sed -i "s/> 最后更新：.*/> 最后更新：$DATE/" CODEMAP.md
sed -i "s/> 代码行数：.*/> 代码行数：$LOC/" CODEMAP.md

# 如果 CODEMAP.md 有修改，加入本次提交
if git diff --name-only | grep -q "CODEMAP.md"; then
    git add CODEMAP.md
    echo "✅ CODEMAP.md 已更新并加入本次提交"
fi
```

配置 Husky：

```json
// package.json
{
  "husky": {
    "hooks": {
      "pre-commit": "bash .husky/update-codemap.sh && lint-staged"
    }
  }
}
```

---

## MCP 工具 Prompt 示例

当使用 Claude Code 或支持 MCP 的 IDE 时，可以配置以下 Prompt 让 AI 优先读取 CODEMAP：

```markdown
# 项目理解规则

## 加载顺序

在回答任何代码问题前，请按以下顺序加载上下文：

1. 首先读取 `CODEMAP.md` 建立全局感知
2. 根据问题定位相关模块的 `README.md` 或 `SUMMARY.md`
3. 仅在确实需要时读取具体实现文件

## 禁止行为

- 不要在未读 CODEMAP 前就尝试搜索实现代码
- 不要一次性读取超过 3 个完整实现文件
- 如果问题涉及跨模块交互，先理解模块边界再看实现

## 问题类型与加载策略

| 问题类型 | 应读取的层级 |
|---------|------------|
| "这个项目是做什么的" | 只需 CODEMAP.md |
| "某功能在哪里实现" | CODEMAP + 模块 README |
| "某函数有 bug" | CODEMAP + 函数实现 + 相关测试 |
```
