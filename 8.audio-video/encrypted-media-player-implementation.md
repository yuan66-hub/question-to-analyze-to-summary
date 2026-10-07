# 音视频加密播放器完整落地技术方案

> 面向 Web、Android、iOS 和桌面端的加密点播系统。采用“双轨渐进”路线：先用自定义 AES 分片加密建立业务闭环，再升级到 CENC + Widevine/FairPlay/PlayReady 商业 DRM。

---

## 目录

1. [目标、范围与安全边界](#1-目标范围与安全边界)
2. [方案与格式选型](#2-方案与格式选型)
3. [总体系统架构](#3-总体系统架构)
4. [核心服务设计](#4-核心服务设计)
5. [播放器内部架构](#5-播放器内部架构)
6. [音视频数据完整流转](#6-音视频数据完整流转)
7. [密钥与 License 设计](#7-密钥与-license-设计)
8. [接口与数据模型](#8-接口与数据模型)
9. [多端技术方案](#9-多端技术方案)
10. [部署、容错与可观测性](#10-部署容错与可观测性)
11. [安全、测试与验收](#11-安全测试与验收)
12. [分阶段实施计划](#12-分阶段实施计划)
13. [风险与最终决策](#13-风险与最终决策)

---

## 1. 目标、范围与安全边界

### 1.1 建设目标

- 支持 MP4 源文件上传、转码、切片、加密、CDN 分发和多端播放。
- 支持 HLS/DASH 自适应码率、Seek、多音轨、字幕、倍速和断点续播。
- 媒体在对象存储、CDN 和公网中保持密文，密钥与媒体分离。
- 通过用户权益、设备、并发数、地域和有效期控制密钥发放。
- 首期低成本上线，后续无需重建业务系统即可升级商业 DRM。
- 建立转码、授权、播放质量和安全审计的完整可观测体系。

### 1.2 不在首期范围

- 自研编解码器、MP4 容器或密码算法。
- 首期建设直播 DRM；直播可在点播稳定后复用授权体系。
- 承诺绝对防录屏、摄像头翻拍或已越狱设备的内存攻击。
- 将修改扩展名、破坏文件头或代码混淆当作加密。

### 1.3 威胁模型

需要防护：

- 复制 CDN 地址后直接下载和播放。
- 越权调用播放、Key 或 License 接口。
- 播放票据、签名 URL、License Challenge 被重放。
- 对象存储或 CDN 缓存泄漏。
- 内容密钥进入数据库明文、日志或客户端持久化存储。
- 单个内容密钥泄漏后影响全部视频。
- 账号共享、超设备数、超并发和批量爬取。

无法完全防护：

- 合法播放终端的系统录屏和外部摄像机翻拍。
- Root、越狱或被注入设备上的内存读取。
- 自定义 Web AES 方案被调试后提取明文或密钥。

商业 DRM、硬件解密和安全视频路径只能提高攻击成本。高价值内容还需要动态水印、风控和追责。

---

## 2. 方案与格式选型

### 2.1 方案对比

| 方案 | 优点 | 局限 | 场景 |
| --- | --- | --- | --- |
| 整文件 AES | 简单，原文件不可直接打开 | Seek、边下边播和 ABR 差 | 内部小文件、离线客户端 |
| AES 分片 | 成本低，支持 CDN、Seek 和 ABR | Web 密钥可被调试提取 | 企业培训、一般付费内容、MVP |
| CENC + DRM | 标准化、设备绑定、硬件安全链路 | 接入、证书和测试成本高 | 影视版权、高价值内容 |

### 2.2 推荐的双轨路线

始终复用：

- 媒资、转码任务、ABR 梯度和 GOP 对齐。
- HLS/DASH 清单与 fMP4/CMAF 分片。
- 权益、播放会话、设备和并发控制。
- 对象存储、CDN、播放器 UI、ABR 和缓冲模块。

逐步替换：

```text
第一阶段：AES 分片加密 → 自建 Key API → 应用层解密
第二阶段：CENC/cbcs   → DRM License → CDM/系统安全解密
```

业务接口统一返回 `protection` 配置，播放器按平台能力选择保护适配器。

### 2.3 MP4 与流媒体格式

MP4 是容器，不代表内容是否加密：

- 普通 MP4 的媒体 Sample 是明文，标准播放器可直接打开。
- 整文件 AES 后虽然可以保留 `.mp4` 后缀，但已不是标准 MP4。
- fragmented MP4 由 `init.mp4` 和 `.m4s` 组成，适合分片调度。
- CENC MP4 符合标准，但其中 Sample 被加密，需要密钥或 DRM CDM。

推荐：

```text
输入：MP4/MOV/MKV
基础视频编码：H.264；可增加 H.265/AV1
基础音频编码：AAC；可增加 Opus
封装：CMAF/fMP4
协议：HLS + MPEG-DASH
MVP 加密：每个自定义分片独立 AES-256-GCM
DRM 加密：CENC(cenc/AES-CTR) 或 cbcs
```

注意：HLS AES-128 通常使用 AES-CBC 和 `EXT-X-KEY`。AES-GCM 属于自定义保护协议，通用 HLS 播放器不会自动支持。

### 2.4 分片与转码参数

- 点播分片通常为 4～6 秒。
- 关键帧间隔与分片边界对齐。
- 所有码率梯度的分片时长、关键帧和时间轴必须对齐。
- 每个分片必须可独立下载、鉴权和解密。
- 码率应通过 VMAF/SSIM 和真实内容测试确定，不应只按分辨率硬编码。

---

## 3. 总体系统架构

```text
┌────────── 媒体生产域 ──────────┐
│ 上传网关 → 原始文件存储         │
│               ↓                │
│      探测 → 转码 → 切片 → 加密  │
└───────────────────────┬────────┘
                        ↓
               私有对象存储 → CDN
                        │ 清单、init、加密分片
                        ↓
┌────────── 播放业务域 ──────────┐     ┌──── 安全域 ────┐
│ 用户/权益 → 播放会话 → URL签名 │────▶│ KMS/HSM        │
│              ↓                 │     │ Key/License服务│
│         设备/并发/风控          │◀────│ 策略与密钥审计 │
└──────────────┬─────────────────┘     └──────┬────────┘
               │ 播放票据/DRM配置             │ License
               ↓                             ↓
┌──────────────────────────────────────────────────────┐
│ 播放终端                                             │
│ UI → 控制器 → 清单/ABR → 网络/缓冲 → 解封装          │
│                               → 解密/CDM → 解码       │
│                               → 音画同步 → 渲染       │
└──────────────────────────────────────────────────────┘
               ↓
         QoE、错误和安全审计
```

核心原则：

1. 密钥与媒体分离，CDN 和对象存储永不接触明文密钥。
2. 控制面与数据面分离，业务 API 不代理大流量媒体。
3. 不信任客户端，权益判断必须在服务端完成。
4. 播放票据、签名 URL、密钥和 License 均短期有效。
5. AES 与 DRM 通过统一保护层接口替换。
6. 明文只存在于受控转码环境和播放内存。

---

## 4. 核心服务设计

### 4.1 媒资服务

- 管理上传、标题、时长、轨道、字幕、版权和安全等级。
- 管理上传中、探测中、转码中、可播放、失败、下线等状态。
- 创建签名上传 URL，源文件直接进入私有对象存储。
- 对接审核、封面、动态水印和生命周期策略。

### 4.2 探测、转码与打包

FFprobe 读取容器、编码、分辨率、帧率、色彩空间、音频参数、时长和关键帧。FFmpeg 生成 GOP 对齐的多码率音视频轨。

MVP 打包：

- KMS 生成 Key ID 和内容密钥 CEK。
- 每个分片使用独立、不可复用的 96-bit GCM Nonce。
- 保存密文和 128-bit Authentication Tag。
- 清单仅携带 Key ID 和保护元数据，不携带明文 CEK。

DRM 打包：

- 使用 Shaka Packager、Bento4、GPAC 或云转码服务。
- 生成 CENC/cbcs fMP4 和 HLS/DASH 清单。
- 写入 `tenc`、`senc`、PSSH 和 Key ID 等标准信息。

### 4.3 KMS/HSM

```text
KMS/HSM 主密钥 KEK
       │ 包装/解包
       ▼
内容密钥 CEK（按内容或密钥周期）
       │ 加密
       ▼
音视频媒体分片
```

- 业务数据库只保存包装后的 CEK。
- KMS 权限与业务服务身份绑定，生产环境禁止人工导出明文 CEK。
- 支持轮换、吊销、版本和全量审计。

### 4.4 播放会话服务

- 验证登录、购买/订阅、地域、内容状态、设备和并发数。
- 创建短期、设备绑定的播放会话。
- 返回签名清单 URL、保护模式、License URL 和水印载荷。
- 处理心跳、续期、主动踢出和异常会话审计。

### 4.5 Key/License 服务

MVP Key 服务校验播放票据、内容、Key ID、设备和随机数，返回经会话密钥或设备公钥包装的 CEK。

DRM License 服务接收 CDM Challenge，根据权益和设备安全等级，从 KMS 获取 CEK，生成 Widevine、FairPlay 或 PlayReady License。

### 4.6 对象存储与 CDN

- Bucket 私有，CDN 通过源站访问身份回源。
- 版本化媒体分片可长缓存，清单短缓存。
- Key/License 响应设置 `Cache-Control: no-store`。
- 使用签名 Cookie/URL，监控命中率、回源率、状态码和流量。

---

## 5. 播放器内部架构

```text
UI：播放、进度、音量、倍速、字幕、清晰度
                       ↓
Playback Controller：状态机、命令、生命周期
          ┌────────────┴────────────┐
      Manifest                  ABR Controller
          └────────────┬────────────┘
            Scheduler / Buffer Manager
          ┌────────────┴────────────┐
       Network              Session/Auth
          └────────────┬────────────┘
       Demuxer + Protection Adapter
           Custom AES / EME / Native DRM
                       ↓
          Video Decoder + Audio Decoder
                       ↓
              A/V Clock 与同步器
                       ↓
          Video Renderer / Audio Renderer
```

统一保护层：

```typescript
interface ProtectionAdapter {
  initialize(config: ProtectionConfig): Promise<void>;
  acquire(initData: ArrayBuffer): Promise<void>;
  decrypt?(segment: EncryptedSegment): Promise<ArrayBuffer>;
  renew(): Promise<void>;
  release(): Promise<void>;
}
```

- `CustomAesAdapter`：应用层解密，用于 MVP。
- `EmeDrmAdapter`：浏览器 EME/CDM，不向 JavaScript 暴露密钥。
- `NativeDrmAdapter`：封装 Android MediaDrm、iOS AVContentKeySession。

状态机：

```text
IDLE → AUTHORIZING → LOADING_MANIFEST
     → ACQUIRING_KEY_OR_LICENSE → BUFFERING
     → PLAYING ↔ PAUSED
     → SEEKING → BUFFERING → PLAYING
     → ENDED

任意状态 → RECOVERABLE_ERROR → RETRYING
任意状态 → FATAL_ERROR → STOPPED
```

状态迁移必须串行化，防止多次播放、Seek、清晰度切换和令牌续期产生竞态。

---

## 6. 音视频数据完整流转

### 6.1 上传、转码与加密

```text
1. 管理端向媒资服务申请上传，获得 assetId 和分片上传 URL。
2. 客户端将源 MP4 直接上传到私有对象存储。
3. 存储事件触发探测任务，FFprobe 读取媒体信息。
4. 工作流根据源质量选择转码模板。
5. FFmpeg 输出 GOP 对齐的多码率视频轨和音频轨。
6. Packager 将轨道切成 init.mp4 和 .m4s。
7. KMS 为内容生成 Key ID 和 CEK。
8. Packager 使用 AES 或 CENC 加密媒体。
9. 生成 master.m3u8、媒体 m3u8 和 manifest.mpd。
10. 产物写入对象存储，按需预热 CDN。
11. 自动质检验证音画、清单、分片和解密。
12. 媒资状态变为 READY，源文件按策略归档或删除。
```

媒体生产路径：

```text
源 MP4
  ├→ Demux → 视频解码 → 缩放 → 多码率编码 ┐
  └→ Demux → 音频解码 → 重采样 → AAC编码  ├→ GOP对齐
                                             → CMAF切片
KMS → Key ID + CEK ─────────────────────────→ 加密
                                             → HLS/DASH清单
                                             → 对象存储/CDN
```

### 6.2 播放授权与清单加载

```text
1. 客户端请求 POST /v1/playback/sessions。
2. 服务端检查登录、权益、内容状态、设备、并发、地域和风控。
3. 创建 sessionId，签发 5～15 分钟播放票据。
4. 返回签名清单 URL、保护模式、License URL 和水印信息。
5. 播放器从 CDN 下载 MPD/M3U8 和初始化分片。
6. ABR 根据网络吞吐、设备能力和首帧目标选择初始档位。
7. 调度器按优先级下载音频、视频和字幕分片。
```

数据面只经过 CDN，业务服务不代理媒体，避免带宽和连接数成为瓶颈。

### 6.3 AES 模式播放

```text
1. 清单声明分片 Key ID、算法和保护元数据。
2. Key Client 携票据向 Key 服务请求对应密钥。
3. 服务端校验 sessionId、contentId、keyId、deviceId 和 nonce。
4. KMS 解包 CEK，服务端用会话密钥或设备公钥再次包装。
5. 客户端只在内存中获得短期 CEK。
6. Network 从 CDN 下载密文分片。
7. Worker/Native 模块校验 GCM Tag 后解密。
8. 明文 fMP4 进入 MSE、系统播放器或解封装器。
9. 解码器输出音视频帧，同步器按时间戳渲染。
10. 使用后的明文缓冲和过期密钥尽快释放。
```

Web Worker/WASM 只能隔离主线程和提高逆向成本，不是可信安全边界。

### 6.4 DRM 模式播放

```text
加密清单/PSSH
      ↓
播放器调用 EME/Native DRM 创建 MediaKeySession
      ↓
CDM 生成 Challenge
      ↓
License Server 验证票据、权益、设备安全等级
      ↓
KMS 提供 CEK，License Server 生成设备绑定 License
      ↓
CDM 安装 License
      ↓
CDN 密文分片 → Demux → CDM/安全模块解密
      ↓
硬件/系统解码器 → 安全视频路径 → 屏幕
```

JavaScript 只转发 Challenge 和 License，不应得到明文内容密钥。

### 6.5 Seek、码率切换与密钥轮换

Seek：

1. 暂停旧分片调度并取消无用请求。
2. 根据清单定位目标时间之前最近的关键帧分片。
3. 若目标分片使用新 Key ID，提前获取 Key/License。
4. 清理不可复用缓冲，下载目标音视频分片。
5. 从关键帧解码，丢弃目标时间之前的帧。
6. 重置音画时钟，达到最小缓冲后恢复播放。

ABR 切换：

- 只在对齐的分片边界切换轨道。
- 码率选择同时考虑吞吐、缓冲水位、视口和解码能力。
- 连续卡顿时快速降级，网络恢复后保守升级，避免码率振荡。

密钥轮换：

```text
分片 1～10  → Key A
分片 11～20 → Key B
分片 21～30 → Key C
```

播放器在边界到来前预取下一 Key/License。轮换周期应按内容价值、License 压力和可接受泄漏范围配置。

### 6.6 离线播放

```text
用户申请下载 → 服务端检查离线权限 → 签发持久 License
→ 下载加密分片 → License 存入系统安全存储
→ 断网播放时校验有效期、设备绑定和输出限制
```

离线需要额外处理到期、撤销、退款、系统时间篡改和设备解绑。优先使用平台 DRM 的持久 License；自定义 AES 不应将明文 CEK 写入普通文件。

---

## 7. 密钥与 License 设计

### 7.1 密钥生命周期

```text
GENERATED → ACTIVE → ROTATING → RETIRED → REVOKED/DESTROYED
```

- 每个内容至少一个 CEK，高价值内容按时间或分片组轮换。
- CEK 仅在 Packager、KMS 安全边界和终端解密模块短暂出现。
- 数据库保存 `wrapped_key`，不保存 `plain_key`。
- 删除内容时先下架播放，再吊销授权，最后按合规策略销毁密钥和媒体。

### 7.2 票据与重放防护

播放票据至少绑定：

- `sessionId`、`userId`、`contentId`、`deviceId`。
- `issuedAt`、`expiresAt`、`jti`。
- 允许的保护模式、清晰度上限和离线权限。

Key/License 请求增加一次性 nonce、时间窗口、频率限制和服务端会话状态校验。JWT 只提供签名完整性，不负责隐藏载荷，不能在其中放明文密钥。

### 7.3 License 策略

- 临时 License：关闭或超时后失效。
- 可续期 License：长视频播放中按策略续期。
- 持久 License：仅用于明确授权的离线播放。
- 输出策略：按设备安全等级限制最大分辨率、HDCP 或外接屏幕。
- 吊销策略：账号风险、退款、设备解绑或版权下架后停止续期。

---

## 8. 接口与数据模型

### 8.1 创建播放会话

```http
POST /v1/playback/sessions
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "contentId": "movie_123",
  "deviceId": "device_abc",
  "capabilities": {
    "drm": ["widevine"],
    "codecs": ["avc1", "hvc1"],
    "maxHeight": 1080
  }
}
```

响应：

```json
{
  "sessionId": "ps_01",
  "manifestUrl": "https://cdn.example.com/movie_123/manifest.mpd?...",
  "expiresAt": "2026-09-11T10:15:00Z",
  "protection": {
    "mode": "widevine",
    "licenseUrl": "https://license.example.com/v1/widevine",
    "token": "<short-lived-playback-token>"
  },
  "watermark": {
    "payload": "user-2381",
    "refreshSeconds": 30
  }
}
```

### 8.2 Key 与 License 接口

```text
POST /v1/keys/acquire           # 自定义 AES
POST /v1/licenses/widevine      # Widevine Challenge
POST /v1/licenses/fairplay      # FairPlay SPC
POST /v1/licenses/playready     # PlayReady Challenge
POST /v1/playback/sessions/{id}/heartbeat
DELETE /v1/playback/sessions/{id}
```

Key 响应必须 `no-store`，且返回包装后的密钥。License Challenge 使用二进制请求/响应时，不应强制 JSON 和 Base64，以免增加体积和复制。

### 8.3 核心数据实体

```text
media_asset
  id, source_uri, duration_ms, status, security_level, created_at

media_rendition
  id, asset_id, codec, width, height, bitrate, manifest_uri

content_key
  key_id, asset_id, wrapped_key, algorithm, version, status

playback_session
  id, user_id, asset_id, device_id, expires_at, status, risk_level

device
  id, user_id, platform, drm_level, last_seen_at, revoked_at

license_audit
  request_id, session_id, key_id, result, reason, latency_ms, created_at
```

---

## 9. 多端技术方案

### 9.1 Web

- 播放层：Shaka Player 优先；也可使用 dash.js、hls.js。
- 标准 DRM：MSE + EME，按浏览器支持 Widevine、PlayReady、FairPlay。
- 自定义 AES：Fetch/Streams 下载，Web Worker + Web Crypto 解密，再送入 MSE。
- 不将 CEK 放入 localStorage、IndexedDB、Source Map、日志和错误上报。
- Safari 的 HLS/FairPlay 与其他浏览器 EME 流程存在差异，必须单独适配。

### 9.2 Android

- AndroidX Media3/ExoPlayer + MediaDrm + Widevine。
- 通过 `DataSource`/`DrmSessionManager` 扩展授权和网络层。
- 高价值内容要求 Widevine L1；L3 设备限制清晰度。
- 离线使用 OfflineLicenseHelper 或对应 Media3 能力。

### 9.3 iOS/macOS

- AVPlayer + HLS + FairPlay Streaming。
- 使用 AVContentKeySession 处理 SPC/CKC。
- 离线采用持久内容密钥和系统安全存储。
- 根据 HDCP、AirPlay 和屏幕捕获状态执行业务策略。

### 9.4 Windows/桌面

- Windows 商店/系统生态优先 PlayReady。
- Electron 可复用 Chromium EME，但 DRM 能力受发行、签名和平台限制。
- 原生跨平台可用 FFmpeg/GStreamer 负责解封装，平台解码器负责硬件解码。
- VLC、mpv 适合内部和自定义 AES，不应假设支持商业 DRM。

### 9.5 开源组件边界

- Shaka Player、dash.js、hls.js、Media3、FFmpeg、GStreamer、Bento4 可作为基础组件。
- Widevine CDM、FairPlay、PlayReady 客户端模块和证书体系不是完整开源 DRM。
- 生产前必须核对组件许可证、专利、编解码器分发权和 DRM 服务商合同。

---

## 10. 部署、容错与可观测性

### 10.1 部署拓扑

```text
公网：
  API Gateway/WAF → 播放会话服务、License 服务
  CDN → 私有媒体对象存储

私网：
  媒资/任务服务 → Queue → 转码/Packager Worker
  Key/License 服务 → KMS/HSM
  业务服务 → PostgreSQL/Redis
  全部服务 → 日志、指标、链路追踪和审计存储
```

License 服务和 KMS 访问放在独立安全网段，使用服务身份和 mTLS。转码 Worker 使用临时凭证，任务完成后销毁本地明文工作目录。

### 10.2 容错和降级

- CDN 分片失败：指数退避、备用 CDN、同档位重试。
- 清单失败：短重试并切备用域名，禁止使用过期到不可控的旧清单。
- Key/License 超时：有限次数重试；已有 License 未到期时继续播放。
- KMS 故障：禁止降级为明文密钥；通过多可用区和限流保护恢复。
- 高码率卡顿：ABR 降档，不降低加密安全等级。
- DRM 不支持：仅在内容策略允许时回退 AES，否则明确提示设备不支持。
- 转码失败：任务幂等、可重试、保留失败阶段和输入指纹。

错误码应区分权限、设备、License、网络、清单、解密、解码和渲染，避免全部表现为“播放失败”。

### 10.3 核心指标

播放 QoE：

- 首帧时间、播放成功率、卡顿率、卡顿时长。
- Seek 成功率和耗时、码率切换次数、平均播放码率。
- 清单/分片下载耗时、CDN 命中率、解码和 DRM 错误率。

服务端：

- 转码排队与处理耗时、失败率、单位分钟成本。
- 播放会话 QPS、License P50/P95/P99、KMS 调用延迟。
- Key/License 拒绝原因、重放命中、设备和并发拦截数。

日志中只记录 Key ID、License 请求 ID 和结果，禁止记录 CEK、完整票据或用户敏感信息。

---

## 11. 安全、测试与验收

### 11.1 安全基线

- 使用成熟算法和库；禁止 AES-ECB、固定 IV/Nonce 和自研密码算法。
- AES-GCM 在同一密钥下严禁复用 Nonce。
- 全链路 TLS；服务间敏感接口使用 mTLS。
- 管理、Packager、Key、License 和 KMS 权限最小化。
- 密钥操作、策略修改和人工运维操作进入不可篡改审计。
- 签名 URL 短期有效并绑定资源范围，不能把永久 Token 放入 URL。
- Web 配置 CSP、CORS、SRI 和生产 Source Map 访问控制。
- 动态可见水印携带用户/会话标识，高价值内容可叠加隐形水印。

### 11.2 测试矩阵

功能：

- 上传、转码、加密、播放、暂停、Seek、倍速、字幕、音轨和清晰度切换。
- Key/License 获取、续期、轮换、过期、吊销和离线。
- 设备解绑、并发踢出、权益到期和内容下架。

兼容：

- Chrome、Edge、Safari、Firefox 的支持范围。
- Android 不同系统版本及 Widevine L1/L3。
- iOS/iPadOS/macOS 与 FairPlay。
- 弱网、代理、跨地域 CDN 和外接屏幕。

安全：

- 越权、重放、伪造设备、票据篡改和暴力请求。
- 存储/CDN 泄漏后能否直接播放。
- 日志、崩溃报告、缓存中是否出现明文密钥。
- GCM Tag、分片内容、清单和 PSSH 被篡改后的处理。

性能：

- 首帧、Seek、卡顿和 License 延迟压测。
- 热门内容 CDN 命中和源站保护。
- 转码峰值、队列积压、KMS 限额和 License 并发。

### 11.3 上线验收线

具体阈值应基于业务 SLO 确认，建议至少满足：

- 正常网络播放成功率 ≥ 99.9%。
- License 服务可用性 ≥ 99.95%，P95 延迟有明确预算。
- AES/DRM 密钥不会出现在日志、数据库明文和公共缓存中。
- 任意对象存储或 CDN 密文文件不能被普通播放器直接播放。
- Seek、ABR、密钥轮换和 License 续期无可感知长时间中断。
- 权益撤销、设备吊销和并发踢出在约定时间内生效。

---

## 12. 分阶段实施计划

### 阶段 0：验证与基线（1～2 周）

- 确认版权、安全、终端、清晰度和离线要求。
- 用一组真实视频验证 ABR、GOP、分片和质量参数。
- 完成 Shaka Player/Media3/AVPlayer 技术样例。
- 验证 KMS、对象存储和 CDN 的权限边界。

交付：技术验证报告、威胁模型、格式规范和 SLO。

### 阶段 1：AES MVP（3～6 周）

- 媒资上传、探测、转码、CMAF 切片和 AES-GCM 加密。
- 播放会话、Key 服务、签名 URL、设备和并发控制。
- Web 或首个目标客户端播放器。
- 基础 QoE、服务指标、安全审计和动态水印。

交付：可上线的加密点播闭环。此阶段不能宣称达到商业 DRM 安全等级。

### 阶段 2：生产增强（2～4 周）

- 多码率 ABR、密钥轮换、License/Key 预取和容错。
- 多 CDN、转码任务幂等、容量与故障演练。
- 多端适配、自动化兼容测试和风控策略。
- 完善告警、运营后台和安全审计。

### 阶段 3：商业 DRM（4～10 周）

- CENC/cbcs 打包和 PSSH。
- 接入 Widevine、FairPlay、PlayReady License。
- EME、MediaDrm、AVContentKeySession 多端适配。
- 安全等级、输出限制、离线 License 和吊销。
- 按内容/用户/设备灰度，从 AES 迁移至 DRM。

工期取决于团队经验、DRM 服务商、证书申请和目标设备矩阵，不能只按编码工作量估算。

---

## 13. 风险与最终决策

### 13.1 主要风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| Web AES 密钥可提取 | 内容被二次分发 | 高价值内容使用 DRM + 水印 |
| DRM 平台碎片化 | 多端成本上升 | 统一保护适配器和业务接口 |
| Nonce/密钥误用 | 严重密码学漏洞 | KMS 生成、唯一约束、自动测试 |
| GOP 未对齐 | ABR 切换卡顿 | 转码模板和质检强制验证 |
| License/KMS 成为单点 | 全站无法播放 | 多可用区、容量保护、故障演练 |
| 过度短期 Token | 播放中频繁失败 | 票据续期与 License 生命周期分离 |
| 日志泄漏密钥 | 安全体系失效 | 字段白名单、脱敏和审计扫描 |

### 13.2 最终技术决策

1. 不采用整文件加密作为主播放方案。
2. 统一使用 HLS/DASH + CMAF/fMP4，源文件可以是 MP4。
3. 首期采用独立分片 AES-256-GCM，但明确它是自定义协议。
4. 高价值内容采用 CENC/cbcs + Widevine/FairPlay/PlayReady。
5. 媒体、密钥和授权三域分离，CEK 由 KMS/HSM 管理。
6. 播放器通过 Protection Adapter 支持 AES 与 DRM 双轨。
7. 服务端负责权益和策略，CDN 只分发密文。
8. 安全目标是降低批量盗取和越权风险，不承诺绝对防录屏。

该架构允许团队先完成可用、可运营、可观测的点播系统，再按内容价值升级安全等级，避免首期承担全部多 DRM 成本，也避免未来推倒重来。
