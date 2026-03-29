# 需求-代码映射：精确定位实践

## 目录

- [核心问题](#核心问题)
- [映射链路总览](#映射链路总览)
- [实战示例：用户登录功能](#实战示例用户登录功能)
- [四层映射机制](#四层映射机制)
- [精确定位到代码段的方法](#精确定位到代码段的方法)
- [AI 辅助定位](#ai-辅助定位)
- [模板与工具](#模板与工具)

---

## 核心问题

**问题：** 如何确保 PRD 中的每一个需求点，最终都能对应到具体的代码文件，甚至具体到某一行/某一段逻辑？

**答案：** 建立四级映射链路，每一层都有唯一的 ID 和交叉引用，确保需求从 PRD 到代码的每一步都有据可查。

---

## 映射链路总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           PRD (需求定义层)                                 │
│                    REQ-001: 用户名密码登录                                │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                     Task/Story (任务拆解层)                               │
│              TASK-001: 实现用户名密码认证                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                     Design.md (设计文档层)                                │
│         DESIGN-001: 认证模块设计 → auth.go, login_handler.go            │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                       代码实现层                                          │
│     auth.go:45-67      login_handler.go:102-115     middleware.go:20-30  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 实战示例：用户登录功能

### 第一层：PRD 定义需求

```markdown
# PRD-2024-001: 用户认证系统

## 功能需求

| 需求 ID | 描述 | 验收标准 | 优先级 |
|---------|------|----------|--------|
| REQ-001 | 用户名密码登录 | 输入正确账号密码返回 token，错误返回明确错误信息 | P0 |
| REQ-002 | 登录失败锁定 | 连续 5 次失败后锁定账号 30 分钟 | P0 |
| REQ-003 | Token 有效期 | Token 有效期 24 小时，过期需重新登录 | P1 |

## 非功能需求

| 需求 ID | 描述 | 验收标准 |
|---------|------|----------|
| PERF-001 | 登录响应时间 | 95% 请求在 200ms 内响应 |
| SEC-001 | 密码安全 | 密码加密存储，加密算法 bcrypt |
```

---

### 第二层：Task 拆解

```markdown
# Task List - 用户认证系统

## TASK-001: 实现用户名密码认证
- **来源需求:** REQ-001
- **设计文档:** DESIGN-001
- **预计工时:** 2d
- **验收标准:**
  - [ ] 正确账号密码返回 JWT token
  - [ ] 错误密码返回 "用户名或密码错误"
  - [ ] 账号不存在返回 "用户名或密码错误"（不暴露账号是否存在）

## TASK-002: 实现登录失败锁定
- **来源需求:** REQ-002
- **设计文档:** DESIGN-002
- **预计工时:** 1d
- **验收标准:**
  - [ ] 连续 5 次失败后记录锁定状态
  - [ ] 锁定期间登录返回 "账号已锁定"
  - [ ] 锁定 30 分钟后自动解锁

## TASK-003: 实现 Token 校验
- **来源需求:** REQ-003
- **设计文档:** DESIGN-003
- **预计工时:** 0.5d
```

---

### 第三层：Design 文档映射

```markdown
# Design-001: 认证模块设计

## 需求追踪

| 需求 ID | 设计章节 | 实现文件 |
|---------|---------|---------|
| REQ-001 | 3.1 认证流程 | auth.go, login_handler.go |
| REQ-002 | 3.2 锁定机制 | auth.go, lock_service.go |
| PERF-001 | 3.3 性能设计 | middleware.go (缓存) |
| SEC-001 | 3.4 安全设计 | password.go (bcrypt) |

## 3.1 认证流程设计

### 接口设计

```go
// POST /api/v1/login
// Request: { "username": string, "password": string }
// Response: { "token": string, "expires_at": timestamp }

// 对应需求: REQ-001, REQ-003
// 实现文件: auth.go:45-67, login_handler.go:102-115
```

### 数据流

```
用户请求 → Middleware → LoginHandler (102-115行)
                            ↓
                      AuthService.Login (auth.go:45-67)
                            ↓
                      PasswordVerify (auth.go:68-80)
                            ↓
                      TokenGenerate (auth.go:81-95)
```

## 3.2 登录锁定机制

```go
// 锁定检查: auth.go:96-110
// 锁定记录: lock_service.go:20-45
// 解锁定时器: lock_service.go:50-65

// 对应需求: REQ-002
// 实现文件: auth.go, lock_service.go
```

## 3.4 密码安全设计

```go
// 加密存储: password.go:15-30
// bcrypt 成本因子: 12

// 对应需求: SEC-001
// 实现文件: password.go
```

---

### 第四层：代码实现

#### auth.go - 核心认证逻辑

```go
package auth

// ============================================================================
// 文件: auth.go
// 需求追踪:
//   - REQ-001: 用户名密码登录 → 本文件 45-95 行
//   - REQ-002: 登录失败锁定 → 本文件 96-110 行
//   - REQ-003: Token 有效期 → 本文件 81-95 行
//   - SEC-001: 密码加密存储 → password.go:15-30
// ============================================================================

// Login 核心认证流程
// REQ-001 实现: auth.go:45-67
func (s *AuthService) Login(ctx context.Context, req *LoginRequest) (*LoginResponse, error) {
    // 1. 参数校验 (45-48行)
    if err := validateRequest(req); err != nil {
        return nil, err
    }

    // 2. 锁定检查 (49-55行) → REQ-002
    if s.isLocked(req.Username) {
        return nil, ErrAccountLocked  // 账号已锁定
    }

    // 3. 用户认证 (56-67行) → REQ-001
    user, err := s.getUser(req.Username)
    if err != nil {
        s.recordFailedLogin(req.Username) // 记录失败 → REQ-002
        return nil, ErrInvalidCredentials
    }

    if !s.verifyPassword(user, req.Password) { // → SEC-001
        s.recordFailedLogin(req.Username)
        return nil, ErrInvalidCredentials
    }

    // 4. 生成 Token (68-75行) → REQ-003
    token, err := s.generateToken(user.ID)
    if err != nil {
        return nil, err
    }

    return &LoginResponse{
        Token:     token,
        ExpiresAt: time.Now().Add(24 * time.Hour), // REQ-003: 24小时有效期
    }, nil
}

// isLocked 检查账号是否被锁定
// REQ-002 实现: auth.go:96-103
func (s *AuthService) isLocked(username string) bool {
    lock, ok := s.lockStore.Get(username)
    if !ok {
        return false
    }
    return lock.ExpiredAt.After(time.Now())
}

// recordFailedLogin 记录失败次数，触发锁定
// REQ-002 实现: auth.go:104-110
func (s *AuthService) recordFailedLogin(username string) {
    // ... 锁定逻辑
}
```

#### login_handler.go - HTTP 处理层

```go
package handler

// ============================================================================
// 文件: login_handler.go
// 需求追踪:
//   - REQ-001: HTTP 接口暴露 → 本文件 102-115 行
// ============================================================================

// Login HTTP 处理函数
// REQ-001 接口定义: login_handler.go:102-115
func (h *AuthHandler) Login(c *gin.Context) {
    var req LoginRequest

    // 102-105: 请求解析
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(400, gin.H{"error": "invalid request"})
        return
    }

    // 106-110: 调用认证服务
    resp, err := h.authService.Login(c.Request.Context(), &req)
    if err != nil {
        // 111-114: 统一错误处理，不暴露内部细节
        switch err {
        case auth.ErrAccountLocked:
            c.JSON(403, gin.H{"error": "账号已锁定"})
        case auth.ErrInvalidCredentials:
            c.JSON(401, gin.H{"error": "用户名或密码错误"})
        default:
            c.JSON(500, gin.H{"error": "服务异常"})
        }
        return
    }

    // 115: 成功返回
    c.JSON(200, resp)
}
```

#### password.go - 密码安全实现

```go
package auth

// ============================================================================
// 文件: password.go
// 需求追踪:
//   - SEC-001: 密码加密存储 → 本文件 15-30 行
// ============================================================================

// HashPassword 密码加密存储
// SEC-001 实现: password.go:15-25
func HashPassword(password string) (string, error) {
    // bcrypt 成本因子 12，符合安全标准
    bytes, err := bcrypt.GenerateFromPassword([]byte(password), 12)
    return string(bytes), err
}

// VerifyPassword 密码校验
// SEC-001 实现: password.go:26-30
func VerifyPassword(password, hash string) bool {
    return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}
```

---

## 四层映射机制

### 映射矩阵

| PRD 需求 | Task | Design 章节 | 代码文件 | 代码行号 |
|---------|------|------------|---------|---------|
| REQ-001 | TASK-001 | DESIGN-001 §3.1 | auth.go | 45-67, 102-115 |
| REQ-002 | TASK-002 | DESIGN-001 §3.2 | auth.go, lock_service.go | 96-110, 20-65 |
| REQ-003 | TASK-003 | DESIGN-001 §3.1 | auth.go | 81-95 |
| PERF-001 | TASK-004 | DESIGN-001 §3.3 | middleware.go | 20-30 |
| SEC-001 | TASK-001 | DESIGN-001 §3.4 | password.go | 15-30 |

### 交叉引用注释规范

代码中的需求追踪注释：

```go
// 格式: // REQ-XXX: 需求描述 → 文件:行号
// REQ-001: 用户名密码登录 → auth.go:45-67
// REQ-002: 登录失败锁定 → auth.go:96-110
// SEC-001: 密码加密存储 → password.go:15-30
```

---

## 精确定位到代码段的方法

### 方法一：行号锚定

```
PRD REQ-001
    ↓
Design §3.1 认证流程
    ↓
auth.go:45-67 (Login 函数主体)
    ↓
login_handler.go:102-115 (HTTP 入口)
```

**优点：** 精确到行号，定位速度快
**缺点：** 代码重构后行号可能变化

### 方法二：函数/方法锚定

```
PRD REQ-001
    ↓
Design §3.1 认证流程
    ↓
AuthService.Login()
    ↓
PasswordVerify() [auth.go:68-80]
    ↓
TokenGenerate() [auth.go:81-95]
```

**优点：** 重构后仍可通过函数名定位
**缺点：** 需要函数命名规范

### 方法三：ID 标签锚定

```go
// [REQ-001] 用户名密码登录 - 核心认证
func (s *AuthService) Login() {
    // [REQ-001-START]
    // ... 实现 ...
    // [REQ-001-END]
}
```

**优点：** 强关联，搜索友好
**缺点：** 代码可读性稍差

### 方法四：测试用例锚定

```go
// auth_test.go
// [REQ-001] 用户名密码登录测试
func TestLogin_Success(t *testing.T) { /* ... */ }

// [REQ-002] 登录失败锁定测试
func TestLogin_FailedLockout(t *testing.T) { /* ... */ }
```

**优点：** 从需求可直接找到对应测试
**缺点：** 需要维护测试与需求的映射

---

## AI 辅助定位

### 场景：需求变更影响分析

当 PRD 中的某个需求变更时，AI 可自动定位受影响代码：

```markdown
## AI 定位 Prompt

**输入：**
REQ-002 变更：登录失败锁定从 5 次改为 3 次，锁定时间从 30 分钟改为 15 分钟

**AI 分析输出：**
```
## 影响范围分析

### 直接影响代码
1. auth.go:96-110
   - 锁定阈值常量：MAX_FAILED_ATTEMPTS (当前: 5)
   - 锁定时长常量：LOCKOUT_DURATION (当前: 30min)

2. lock_service.go:20-65
   - 锁定记录创建逻辑
   - 定时器设置

### 建议修改
| 文件 | 行号 | 当前值 | 修改为 |
|-----|------|--------|-------|
| auth.go | 97 | 5 | 3 |
| auth.go | 98 | 30*time.Minute | 15*time.Minute |

### 测试需更新
- auth_test.go: TestLogin_FailedLockout (失败次数断言)
- lock_service_test.go: TestLockoutDuration (锁定时长断言)
```
```

### 场景：代码追溯到需求

```markdown
## AI 追溯 Prompt

**输入：**
发现 password.go:15-30 有变更

**AI 追溯输出：**
```
## 代码变更追溯

### 变更代码
password.go:15-30 (HashPassword, VerifyPassword)

### 对应需求
- SEC-001: 密码加密存储

### 关联 Task
- TASK-001: 实现用户名密码认证

### 关联 Design
- DESIGN-001 §3.4: 密码安全设计

### 建议检查
- [ ] 安全评审是否需要？
- [ ] 测试覆盖是否充分？
- [ ] 其他系统是否有依赖？
```
```

---

## 模板与工具

### 需求追踪表模板

```markdown
## 需求追踪表

| 需求 ID | 来源 | 描述 | Task | Design | 代码文件 | 代码行号 | 状态 |
|--------|------|------|------|--------|---------|---------|------|
| REQ-001 | PRD | 用户名密码登录 | TASK-001 | DESIGN-001 | auth.go | 45-67 | 实现中 |
| REQ-002 | PRD | 登录失败锁定 | TASK-002 | DESIGN-002 | auth.go | 96-110 | 实现中 |

## 覆盖率统计
- 总需求数: 5
- 已追踪: 5
- 未实现: 1 (REQ-004)
- 覆盖率: 80%
```

### 代码头部注释模板

```go
/*
 * 文件: [文件名]
 * 创建日期: [日期]
 * 最后更新: [日期]
 *
 * 需求追踪:
 *   - REQ-XXX: [需求描述] → [文件:行号]
 *   - SEC-XXX: [安全需求] → [文件:行号]
 *
 * 变更记录:
 *   - [日期] [作者]: [变更内容] (对应需求: REQ-XXX)
 */
```

### 快速查询命令

```bash
# 查找某个需求的所有实现位置
grep -rn "REQ-001" --include="*.go" --include="*.md"

# 查找某个文件涉及的所有需求
grep -o "REQ-[0-9]*" auth.go | sort | uniq

# 查找未实现的需求
grep -rn "TODO.*REQ" --include="*.go" --include="*.md"
```

---

## 总结

| 层级 | 核心要素 | 定位精度 |
|------|---------|---------|
| PRD | 需求 ID + 验收标准 | 功能级 |
| Task | 需求 ID 映射 | 模块级 |
| Design | 章节 + 文件映射 | 文件级 |
| 代码 | 行号/函数/标签 | **行级/段级** |

**精确定位三要素：**
1. **唯一 ID** - 每个需求有唯一编号，全链路引用
2. **交叉引用** - 每层文档都标注与其他层的对应关系
3. **代码注释** - 代码中标注对应的需求 ID 和行号
