# pnpm Monorepo 按权限拉取子包完整落地示例

## 最终目录结构

```
company-monorepo/                    ← 主仓库（所有人可访问）
├── .gitmodules                      ← submodule 配置
├── .npmrc                           ← pnpm workspace 链接配置
├── .nvmrc                           ← Node 版本锁定
├── package.json                     ← 根 package，含 scripts
├── pnpm-workspace.yaml              ← workspace 包路径配置
├── pnpm-lock.yaml                   ← 锁文件（含两种来源）
├── packages/
│   └── core-algo/                   ← git submodule（仅有权限者可 init）
│       ├── .git                     ← 指向私有仓库
│       ├── src/
│       │   ├── index.ts
│       │   └── algorithm.ts
│       ├── dist/                    ← 编译产物（构建后生成）
│       │   ├── index.js
│       │   ├── index.d.ts
│       │   └── index.js.map
│       ├── package.json
│       └── tsconfig.json
└── apps/
    └── main-app/                    ← 主项目（所有人可访问）
        ├── src/
        │   └── index.ts
        ├── package.json
        └── tsconfig.json
```

---

## Step 1：初始化主仓库

```bash
mkdir company-monorepo && cd company-monorepo
git init
```

---

## Step 2：添加 git submodule

```bash
# 将私有算法仓库挂载为 submodule
git submodule add git@github.com:company/core-algo-private.git packages/core-algo

# 指定 branch（推荐，方便后续更新）
git submodule add -b main git@github.com:company/core-algo-private.git packages/core-algo
```

生成的 `.gitmodules`：

```ini
# .gitmodules
[submodule "packages/core-algo"]
    path = packages/core-algo
    url = git@github.com:company/core-algo-private.git
    branch = main
    # shallow = true  # 可选：浅克隆，减少拉取体积
```

> 此文件提交到主仓库，无权限的人 clone 后看得到配置，但 init 时会因 SSH 权限拒绝而跳过。

---

## Step 3：核心配置文件

### `.npmrc`

```ini
# .npmrc ── 最关键的配置

# workspace 包优先于 registry（有本地源码就链接）
link-workspace-packages=true

# 私有 registry（存放编译后的 @company/core-algo）
@company:registry=https://npm.company.com
//npm.company.com/:_authToken=${COMPANY_NPM_TOKEN}

# 公共包走默认 registry
registry=https://registry.npmjs.org

# 其他推荐配置
shamefully-hoist=false
strict-peer-dependencies=false
auto-install-peers=true
```

### `pnpm-workspace.yaml`

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'   # core-algo 目录存在时自动纳入 workspace
  - 'apps/*'
```

### 根 `package.json`

```json
{
  "name": "company-monorepo",
  "private": true,
  "engines": {
    "node": ">=18.0.0",
    "pnpm": ">=8.0.0"
  },
  "scripts": {
    "dev": "pnpm -r --parallel run dev",
    "build": "pnpm -r run build",
    "build:algo": "pnpm --filter @company/core-algo run build",
    "install:privileged": "git submodule update --init --recursive && pnpm install",
    "install:standard": "pnpm install"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
```

---

## Step 4：core-algo 子包配置

### `packages/core-algo/package.json`

```json
{
  "name": "@company/core-algo",
  "version": "1.2.0",
  "description": "Core algorithm - source only for authorized developers",
  "license": "UNLICENSED",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "dev": "tsup src/index.ts --format esm,cjs --dts --watch",
    "prepublishOnly": "pnpm build"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.4.0"
  }
}
```

### `packages/core-algo/src/index.ts`（示意）

```typescript
// packages/core-algo/src/index.ts
export { runAlgorithm } from './algorithm'
export type { AlgorithmOptions, AlgorithmResult } from './algorithm'
```

```typescript
// packages/core-algo/src/algorithm.ts
export interface AlgorithmOptions {
  input: number[]
  threshold: number
}

export interface AlgorithmResult {
  output: number[]
  score: number
}

export function runAlgorithm(options: AlgorithmOptions): AlgorithmResult {
  // 核心算法实现（源码仅有权限者可见）
  const output = options.input.filter(n => n > options.threshold)
  return { output, score: output.length / options.input.length }
}
```

---

## Step 5：主项目配置

### `apps/main-app/package.json`

```json
{
  "name": "@company/main-app",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "ts-node src/index.ts",
    "build": "tsc"
  },
  "dependencies": {
    "@company/core-algo": "^1.0.0"
  },
  "devDependencies": {
    "ts-node": "^10.9.0",
    "typescript": "^5.4.0"
  }
}
```

> **关键**：使用版本范围 `^1.0.0`，不用 `workspace:*`。
> - 有权限 → pnpm 发现 workspace 中有满足此范围的本地包，自动链接
> - 无权限 → workspace 中没有该包，回退从私有 registry 拉取

### `apps/main-app/src/index.ts`

```typescript
import { runAlgorithm } from '@company/core-algo'

const result = runAlgorithm({
  input: [1, 5, 3, 8, 2, 9],
  threshold: 4
})

console.log('Algorithm result:', result)
// 无论源码链接还是编译包，此处代码完全一致
```

### `apps/main-app/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

---

## Step 6：开发者操作流程

### 无权限开发者

```bash
# 1. clone 主仓库（不含 submodule 内容）
git clone git@github.com:company/company-monorepo.git
cd company-monorepo

# 此时 packages/core-algo/ 是空目录（或不存在）
ls packages/core-algo   # 空

# 2. 配置 npm token（公司内网 registry 的读取权限，所有人都有）
export COMPANY_NPM_TOKEN=your_read_only_token

# 3. 直接安装
pnpm install
# pnpm 在 workspace 找不到 @company/core-algo
# 自动从 https://npm.company.com 拉取编译包

# 4. 开发
pnpm dev
```

### 有权限开发者

```bash
# 1. clone 主仓库
git clone git@github.com:company/company-monorepo.git
cd company-monorepo

# 2. 初始化 submodule（需要私有仓库 SSH 权限）
git submodule update --init --recursive
# 或用根目录 script：
pnpm run install:privileged

# 此时 packages/core-algo/ 有完整源码
ls packages/core-algo/src   # algorithm.ts  index.ts

# 3. 安装依赖
pnpm install
# pnpm 在 workspace 发现 @company/core-algo@1.2.0 满足 ^1.0.0
# 自动创建 workspace link，不从 registry 拉取

# 4. 验证链接
ls apps/main-app/node_modules/@company/core-algo
# → 指向 packages/core-algo 的符号链接

# 5. 修改源码后实时生效（配合 tsup --watch）
pnpm --filter @company/core-algo dev
pnpm --filter @company/main-app dev
```

---

## Step 7：发布编译包流程

有权限开发者修改源码后，需要发布供无权限者使用：

```bash
# 1. 构建
pnpm --filter @company/core-algo run build

# 2. 升版本
pnpm --filter @company/core-algo exec npm version patch
# 1.2.0 → 1.2.1

# 3. 发布到私有 registry
pnpm --filter @company/core-algo publish --registry https://npm.company.com --no-git-checks

# 4. 提交 submodule 引用更新到主仓库
git add packages/core-algo
git commit -m "chore: bump core-algo to 1.2.1"
git push

# 无权限开发者 pnpm install 后自动获得 1.2.1 编译包
```

---

## Step 8：CI/CD 配置

### GitHub Actions（无权限，始终用编译包）

```yaml
# .github/workflows/ci.yml
name: CI

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # 不拉取 submodule，CI 不需要源码
          submodules: false

      - uses: pnpm/action-setup@v3
        with:
          version: 8

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install
        env:
          COMPANY_NPM_TOKEN: ${{ secrets.COMPANY_NPM_TOKEN }}

      - name: Build
        run: pnpm build
```

### 发布 workflow（有权限，需要 submodule）

```yaml
# .github/workflows/publish-algo.yml
name: Publish core-algo

on:
  workflow_dispatch:
    inputs:
      version_bump:
        type: choice
        options: [patch, minor, major]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive        # 拉取 submodule
          token: ${{ secrets.ALGO_REPO_TOKEN }}  # 有权限的 token

      - uses: pnpm/action-setup@v3

      - name: Build and publish
        run: |
          pnpm --filter @company/core-algo run build
          pnpm --filter @company/core-algo exec npm version ${{ inputs.version_bump }}
          pnpm --filter @company/core-algo publish --registry https://npm.company.com
        env:
          COMPANY_NPM_TOKEN: ${{ secrets.COMPANY_NPM_PUBLISH_TOKEN }}
```

---

## 常见问题处理

### Q1：pnpm install 时 submodule 目录存在但为空

根 `package.json` 挂载 preinstall：

```json
{
  "scripts": {
    "preinstall": "node scripts/check-submodule.js"
  }
}
```

完整实现 `scripts/check-submodule.js`：

```javascript
#!/usr/bin/env node
// scripts/check-submodule.js
//
// 解决：git clone 后 submodule 目录存在但未初始化（空目录）时
// pnpm workspace glob 会把空目录当作本地包解析，导致 install 失败。
// 本脚本在 preinstall 阶段检测所有 submodule 状态并修正。

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync, spawnSync } = require('child_process')

// ─── 配置 ────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..')

/**
 * 需要检测的 submodule 列表
 * - dir:      相对于根目录的路径
 * - required: false = 无权限时允许降级；true = 必须存在，缺失直接报错
 */
const SUBMODULES = [
  { dir: 'packages/core-algo', required: false },
]

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function log(level, msg) {
  const prefix = {
    info:  '\x1b[36m[submodule]\x1b[0m',
    ok:    '\x1b[32m[submodule]\x1b[0m',
    warn:  '\x1b[33m[submodule]\x1b[0m',
    error: '\x1b[31m[submodule]\x1b[0m',
  }[level] || '[submodule]'
  console.log(`${prefix} ${msg}`)
}

/**
 * 判断目录是否是有效的 workspace 包：
 * 存在 package.json 且包含 "name" 字段
 */
function isValidPackage(absDir) {
  const pkgPath = path.join(absDir, 'package.json')
  if (!fs.existsSync(pkgPath)) return false
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return typeof pkg.name === 'string' && pkg.name.length > 0
  } catch {
    return false
  }
}

/**
 * 目录存在但是空（或只有 .git 空引用文件）
 * git submodule 未初始化时留下的是一个空目录或只含 .git 文件的目录
 */
function isEmptySubmodule(absDir) {
  if (!fs.existsSync(absDir)) return false
  const entries = fs.readdirSync(absDir).filter(e => e !== '.git')
  return entries.length === 0
}

/**
 * 获取当前 git submodule 状态
 * 返回 Map<path, status>
 * status: 'uninitialized' | 'initialized' | 'modified'
 */
function getSubmoduleStatus() {
  const result = spawnSync('git', ['submodule', 'status'], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  const map = new Map()
  if (result.status !== 0) return map

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // 格式：[-|+| ]<sha> <path> [(<desc>)]
    const flag = line[0]   // '-' 未初始化, '+' 有改动, ' ' 正常
    const parts = trimmed.replace(/^[-+ ]/, '').split(' ')
    const subPath = parts[1]
    if (!subPath) continue

    if (flag === '-') {
      map.set(subPath, 'uninitialized')
    } else if (flag === '+') {
      map.set(subPath, 'modified')
    } else {
      map.set(subPath, 'initialized')
    }
  }
  return map
}

/**
 * 安全删除目录（只删空目录，防止误删有内容的目录）
 */
function safeRemoveEmptyDir(absDir) {
  // 再次校验确实是空/无效状态，防止误删
  if (isValidPackage(absDir)) {
    log('warn', `skip remove: ${absDir} contains valid package.json`)
    return false
  }
  try {
    fs.rmSync(absDir, { recursive: true, force: true })
    return true
  } catch (err) {
    log('error', `failed to remove ${absDir}: ${err.message}`)
    return false
  }
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

function main() {
  log('info', 'checking submodule states before install...')

  const submoduleStatus = getSubmoduleStatus()
  let hasError = false

  for (const { dir, required } of SUBMODULES) {
    const absDir = path.join(ROOT, dir)
    const status = submoduleStatus.get(dir)

    // ── 情况 1：目录根本不存在 ──────────────────────────────────────────────
    if (!fs.existsSync(absDir)) {
      if (required) {
        log('error', `${dir} is required but missing. Run: git submodule update --init ${dir}`)
        hasError = true
      } else {
        log('info', `${dir} not present → will resolve from registry`)
      }
      continue
    }

    // ── 情况 2：目录存在，是有效包（有权限，已正常初始化）─────────────────
    if (isValidPackage(absDir)) {
      if (status === 'modified') {
        log('warn', `${dir} has uncommitted changes (submodule modified)`)
      } else {
        log('ok', `${dir} is a valid workspace package → will use local source`)
      }
      continue
    }

    // ── 情况 3：目录存在但是空（clone 了主仓库，submodule 未 init）─────────
    if (isEmptySubmodule(absDir)) {
      if (required) {
        log('error', `${dir} is empty. You need access to initialize it:`)
        log('error', `  git submodule update --init ${dir}`)
        hasError = true
        continue
      }

      log('warn', `${dir} is empty (submodule not initialized) → removing to allow registry fallback`)
      const removed = safeRemoveEmptyDir(absDir)
      if (removed) {
        log('ok', `${dir} removed → pnpm will resolve from registry`)
      }
      continue
    }

    // ── 情况 4：目录存在但 package.json 损坏或缺失（异常状态）──────────────
    log('warn', `${dir} exists but has no valid package.json (corrupt state?)`)
    log('warn', `removing and falling back to registry`)
    safeRemoveEmptyDir(absDir)
  }

  if (hasError) {
    log('error', 'preinstall check failed. Resolve the errors above and retry.')
    process.exit(1)
  }

  log('ok', 'submodule check passed')
}

main()
```

### Q2：有权限但想临时用编译包调试

```bash
# 临时绕过 workspace link，强制用 registry 版本
pnpm install --ignore-workspace
```

### Q3：确认当前用的是源码还是编译包

```bash
# 查看实际解析路径
pnpm why @company/core-algo

# 或检查 node_modules 是否为符号链接
ls -la apps/main-app/node_modules/@company/core-algo
# 符号链接 → ../../packages/core-algo  (源码模式)
# 普通目录                              (编译包模式)
```

### Q4：TypeScript 在无权限模式下的类型提示

编译包的 `dist/index.d.ts` 提供完整类型，无需源码。
如果需要在 IDE 中跳转查看实现，有权限者用源码，无权限者看 `.d.ts` 声明。

---

## 关键设计原则总结

| 问题 | 解决方式 |
|------|---------|
| 主项目 package.json 不变 | 用 `^1.0.0` 版本范围，不用 `workspace:*` |
| 权限控制下沉到 git 层 | submodule 访问失败不影响主仓库 clone |
| pnpm 自动路由 | `link-workspace-packages=true` 让本地包优先 |
| 无权限透明降级 | 私有 registry 始终有最新编译包 |
| 源码变更即时生效 | workspace link 是符号链接，修改不需重装 |
