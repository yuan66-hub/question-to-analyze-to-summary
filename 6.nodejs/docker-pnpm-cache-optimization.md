# Docker 容器构建中 pnpm install 缓存复用指南

## 核心原则

Docker 构建利用层缓存（Layer Cache）：**每一层只有在其内容或依赖层发生变化时才会重建**。
pnpm 的优化目标是：让 `node_modules` 安装层尽可能命中缓存，减少重复下载。

---

## 方案一：层缓存排序（基础方案）

**原理**：先复制 lock 文件再安装依赖，源码变更不会触发重新安装。

```dockerfile
FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# 只复制依赖相关文件（lock 文件不变则此层命中缓存）
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

# 最后复制源码（源码变动不影响依赖层）
COPY . .

RUN pnpm build
```

**缺点**：`pnpm-lock.yaml` 任何改动都会导致 `node_modules` 全量重建。

---

## 方案二：BuildKit Cache Mount（推荐）

**原理**：将 pnpm store 挂载为持久缓存目录，跨构建复用已下载的包。
即使 lock 文件变了，已缓存的包不会重新下载，只处理新增/变更的包。

```dockerfile
FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# 挂载 pnpm store 缓存目录，构建之间持久复用
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm build
```

**启用 BuildKit**：

```bash
# 方式一：环境变量
DOCKER_BUILDKIT=1 docker build .

# 方式二：使用 buildx（推荐，Docker 18.09+ 支持）
docker buildx build .
```

**docker-compose 中启用**：

```yaml
# docker-compose.yml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
```

```bash
COMPOSE_DOCKER_CLI_BUILD=1 DOCKER_BUILDKIT=1 docker-compose build
```

---

## 方案三：pnpm fetch + offline install（极致优化）

**原理**：将"下载包"和"安装到 node_modules"分两步，lock 文件不变时下载层完全跳过。

```dockerfile
FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# 第一步：只复制 lock 文件，预下载所有包到 store（不产生 node_modules）
COPY pnpm-lock.yaml ./

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm fetch

# 第二步：复制 package.json，从本地 store 离线安装
COPY package.json ./

RUN pnpm install --offline --frozen-lockfile

COPY . .

RUN pnpm build
```

**优势**：`pnpm fetch` 和 `package.json` 分离，lock 文件不变时下载层 100% 命中缓存。

---

## 方案四：Monorepo 场景

```dockerfile
FROM node:20-slim AS deps

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# 复制所有 package.json，保持目录结构
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/web/package.json ./packages/web/
COPY packages/api/package.json ./packages/api/

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm build --filter=web
```

**技巧**：可用脚本自动收集所有子包的 `package.json`：

```bash
# 在 CI 中预处理，生成 package-list.txt
find . -name "package.json" -not -path "*/node_modules/*" | xargs ...
```

---

## 方案对比

| 方案 | lock 文件未变 | lock 文件有变动 | 实现复杂度 |
|------|-------------|----------------|-----------|
| 层缓存排序 | 极快（跳过安装） | 全量重装 | 低 |
| Cache Mount | 极快 | 只下载新增包 | 中 |
| fetch + offline | 极快 | 只下载新增包 | 中 |
| Monorepo 分层 | 极快 | 只下载新增包 | 高 |

---

## 最佳实践组合

生产环境推荐将**层缓存排序 + Cache Mount** 叠加使用：

```dockerfile
FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# ---- 依赖安装阶段 ----
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---- 构建阶段 ----
FROM base AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- 运行阶段（最小镜像）----
FROM node:20-slim AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

CMD ["node", "dist/index.js"]
```

**多阶段构建好处**：
- `deps` 阶段只包含生产依赖，减小最终镜像体积
- `builder` 阶段包含 devDependencies 用于构建
- `runner` 阶段只有运行所需文件

---

## 常见问题

**Q: pnpm store 默认在哪里？**

```bash
pnpm store path
# 通常为 ~/.local/share/pnpm/store（Linux）
#        ~/Library/pnpm/store（macOS）
```

**Q: 如何验证缓存是否生效？**

```bash
# 第二次构建时，命中缓存的层会显示 CACHED
docker buildx build --progress=plain .
```

**Q: CI/CD 中如何持久化 cache？**

```yaml
# GitHub Actions 示例
- name: Build Docker image
  uses: docker/build-push-action@v5
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```
