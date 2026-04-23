# AI 生成 VMD：真人舞蹈视频复刻到 MMD 模型的技术可行性方案

> 日期：2026-04-23

## 一句话结论

把真人舞蹈视频自动转换成 `VMD`，再导入 `MMD / PMX / Three.js MMD 播放链路` 中进行播放，**技术上完全可行**，而且已经有多条可验证路线；但如果目标是“接近专业动作捕捉质量”的稳定产出，仍然需要在 `3D 姿态估计`、`骨骼重定向`、`平滑滤波`、`脚底锁定`、`手指/表情补全` 这些环节做额外工程化处理。

更实际的判断是：

- **PoC 可行性：高**
- **可演示产品可行性：中高**
- **完全自动化、稳定商用品质：中**

---

## 目标定义

本文讨论的目标不是“让 AI 直接生成一个随机舞蹈”，而是：

1. 输入一段真人舞蹈视频
2. 提取人体时序动作
3. 将动作重建为适合 MMD 骨骼体系的动画数据
4. 导出为 `VMD`
5. 将 `VMD` 导入 `PMD/PMX` 模型，或在 `Three.js` 中通过 `MMDLoader` / `MMDAnimationHelper` 播放

也就是说，本质问题是：

`视频动作理解 -> 3D 动作重建 -> MMD 骨骼映射 -> VMD 导出`

---

## 技术架构总览

```text
┌──────────────┐
│ 真人舞蹈视频 │
└──────┬───────┘
       │
       ▼
┌──────────────────────┐
│ 视频预处理           │
│ 裁剪 / 稳像 / 抽帧   │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ 2D / 3D 姿态估计     │
│ MediaPipe / MMPose   │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────────────┐
│ 时序优化与动作补全           │
│ 滤波 / 插值 / 脚底锁定 / IK  │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────┐
│ MMD 骨骼重定向       │
│ 骨名映射 / 坐标转换  │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ VMD 导出             │
│ 位移 / 旋转 / Morph  │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────────────┐
│ MMD / Blender / Three.js     │
│ 模型加载、预览、微调、播放   │
└──────────────────────────────┘
```

---

## 三条可落地路线

## 路线 A：复用现成开源链路，快速验证

### 核心思路

直接复用已有的 “视频 -> 姿态 -> VMD” 项目，尽快跑出第一版结果。

### 可参考项目

- `OpenMMD`
- `VMD-Lifting`
- `VMD-3d-pose-baseline-multi`

这些项目的共同特征是：

- 用 `OpenPose` 或类似方案提取人体关键点
- 用 `2D -> 3D` 提升模型恢复 3D 骨骼
- 最终输出 `VMD`

### 优点

- 上手最快，适合证明“这件事能做”
- 方便快速形成 Demo
- 很适合先打通视频到 MMD 的端到端流程

### 缺点

- 多数项目较老，依赖链陈旧
- Windows + Python/TensorFlow/OpenPose 环境复杂
- 模型效果和维护性一般
- 对现代人体姿态估计、复杂遮挡、镜头变化的适应性有限

### 适用场景

- 需要一周内做一个能演示的 PoC
- 团队还不想先投入完整工程研发
- 目标是“先证明可行”，不是“直接做产品级上线”

### 可行性判断

**很适合做第一阶段验证，但不建议作为长期主架构。**

---

## 路线 B：自研离线处理管线

### 核心思路

基于现代姿态估计框架，自建一条更稳定的离线管线：

1. 视频预处理
2. 2D 姿态估计
3. 3D 姿态恢复
4. 时序平滑与物理约束
5. MMD 骨骼重定向
6. VMD 导出

### 推荐技术栈

- `Python`
- `PyTorch`
- `MMPose`：适合 2D/3D 人体姿态估计
- `MediaPipe Pose / Holistic`：适合轻量级、实时预览、Web 端实验
- `OpenCV`：视频预处理、抽帧、可视化
- `SciPy / NumPy`：平滑滤波、插值、坐标处理
- `Blender + mmd_tools`：用于中间验证和导出校验

### 推荐处理链路

#### 阶段 1：视频预处理

- 统一帧率，例如 `30 FPS`
- 尽量裁出单人全身区域
- 可选稳像，减少镜头抖动带来的假动作
- 过滤掉检测质量很差的片段

#### 阶段 2：姿态提取

有两种主选择：

- **轻量方案**：`MediaPipe Pose`
  - 优点：快、可上 Web、部署简单
  - 缺点：精度和稳定性不如重型方案
- **高质量方案**：`MMPose`
  - 优点：2D/3D 模型丰富，视频推理能力成熟
  - 缺点：更依赖 Python / CUDA 环境

如果只是做浏览器端预览或轻量原型，`MediaPipe` 已经够用；如果要认真做高质量 `VMD` 生成，`MMPose` 更合适。

#### 阶段 3：2D -> 3D 动作恢复

这是整条链路的核心难点。

因为单目视频先天缺少真实深度，系统只能“估计”人物的 3D 骨骼结构，所以会遇到：

- 手脚前后遮挡
- 转身动作深度不稳定
- 脚步漂移
- 躯干朝向抖动

工程上通常需要结合：

- 视频级时序模型
- 多帧平滑
- 关节角度约束
- 脚底接触检测
- IK 修正

如果不做这一步的后处理，最终生成的 `VMD` 往往会“能动，但不自然”。

#### 阶段 4：MMD 骨骼重定向

人体姿态模型输出的骨骼点，与 MMD 里的骨骼系统不是一回事，必须做一层映射。

典型处理包括：

- 将通用人体骨骼映射到 MMD 骨名
- 坐标系转换
- 根骨、中心骨、上半身、下半身的分解
- 旋转格式转换
- 特定模型的骨长和比例修正

如果模型骨架不标准，还需要做“模型级适配模板”。

#### 阶段 5：VMD 导出

导出阶段本身不是最大难点，重点是确保：

- 每一帧的骨骼旋转正确
- 中心骨位移合理
- 帧率和时间戳一致
- 可选支持表情、眼球、镜头数据

通常建议先输出“仅身体骨骼”的 `VMD`，再逐步补手指、表情和面部。

### 优点

- 架构可控，适合长期演进
- 能逐步替换模型和算法
- 更容易做质量提升和工程优化
- 更适合形成产品化能力

### 缺点

- 研发门槛高于现成工具
- 对姿态估计、动画、骨骼系统都要有一定理解
- 训练/推理环境、模型管理、骨骼映射需要投入

### 适用场景

- 你希望做成持续可迭代的功能
- 后续要接入 Web、桌面端或批处理服务
- 你需要更稳定的输出质量和更高可控性

### 可行性判断

**这是最推荐的主路线。**

---

## 路线 C：浏览器/端侧优先方案

### 核心思路

在 Web 端直接做视频姿态提取，先生成骨骼预览或中间动作数据，再决定是否在本地或服务端转为 `VMD`。

### 典型组合

- 前端：`Three.js + MediaPipe + WebAssembly/WebGPU`
- 输出：JSON 骨骼序列 / 中间动作格式
- 后处理：本地 Python 服务或后端导出 `VMD`

### 优点

- 交互好，适合在线预览
- 适合“上传视频 -> 看到骨骼预览 -> 一键生成动作”
- 与前端 3D 预览天然结合

### 缺点

- 浏览器端做高质量 3D 动作恢复仍受限
- 多帧优化、IK、复杂平滑不如 Python 离线链路方便
- 直接在前端生成高质量 `VMD` 的工程复杂度较高

### 适用场景

- 你要做在线产品或创作工具
- 需要即时反馈，而不是只做离线批处理
- 可以接受“浏览器端预览 + 服务端精修导出”的混合架构

### 可行性判断

**适合作为产品交互层，不适合作为第一版高质量核心引擎。**

---

## 推荐路线

推荐采用：

### `路线 B（自研离线主链路） + 路线 C（Web 预览层）`

也就是：

- 用 `Python + MMPose` 负责主动作提取和 `VMD` 生成
- 用 `Three.js + MediaPipe` 做前端预览、交互和轻量体验
- 最终输出的 `VMD` 既能导入 `MMD`，也能在 `Three.js` 中播放

这是一个兼顾质量、可控性和产品体验的组合。

---

## 可行性拆解

## 1. 视频动作提取是否成熟？

**成熟。**

`MediaPipe Pose` 已能在图像/视频中输出 2D landmark 以及 3D world landmarks；`MMPose` 则提供更完整的 2D/3D 人体姿态推理能力，适合离线视频处理。

结论：

- **提取人体动作关键点**：成熟
- **提取高质量 3D 动作序列**：可行，但需要更强模型和后处理

---

## 2. 从人体骨骼到 MMD 骨骼是否可行？

**可行，但需要自定义映射层。**

因为通用姿态估计骨骼通常只关心人体关键点，不关心 MMD 的具体骨骼命名、父子层级、中心骨、IK 骨、扭转骨、表情骨等。

所以必须构建：

- 关节映射表
- 坐标系转换规则
- 骨长缩放策略
- 特定 PMX 模型的适配配置

如果只做“标准 MMD 人形模型”，难度可控；如果要兼容大量非标准模型，难度会明显提升。

---

## 3. 自动生成的 VMD 质量能否直接商用？

**通常不能一步到位。**

自动生成的动作往往会出现：

- 脚底打滑
- 手腕翻转不自然
- 转身时身体朝向漂移
- 遮挡场景下关节乱跳
- 手指和表情缺失

因此更现实的产品定位是：

- 第一阶段：自动生成基础动作
- 第二阶段：提供自动修正和轻量编辑
- 第三阶段：在 Blender / MMD 中进行人工微调

换句话说，AI 更适合做“动作草稿生成器”或“半自动动捕”，而不是完全替代专业动捕系统。

---

## 关键技术难点

## 1. 单目视频的深度歧义

只靠单个 RGB 视频，很难稳定判断肢体前后关系。

影响：

- 深蹲、转身、旋转、交叉手臂时误差明显
- 人物面向变化时骨盆和胸腔朝向容易抖

缓解方式：

- 多帧时序建模
- 身体朝向约束
- 基于脚底接触的全局位移修正

## 2. 遮挡与出画

如果手臂挡住躯干、人物侧身、腿部被遮挡，关键点会丢失或漂移。

缓解方式：

- 提升输入视频质量
- 使用视频级跟踪
- 使用时间窗口插值和置信度驱动的平滑策略

## 3. MMD 骨骼不是通用人体骨骼

MMD 模型往往有：

- 中心骨
- 上半身/上半身2
- 扭转骨
- IK 骨
- 衣服、裙摆、头发等附加骨

这些在通用姿态估计中通常没有直接对应项。

缓解方式：

- 先只支持核心人形骨骼
- 将复杂附加骨交给物理系统或后期手工调整

## 4. 手指、面部、眼球数据缺失

基础人体姿态估计通常只输出身体主骨骼，不足以生成完整的偶像舞蹈级表演。

缓解方式：

- 后续接入 `Holistic` 或专门的手部/面部模型
- 表情先使用规则生成或预设模板

---

## 质量分层建议

建议把输出质量定义成 3 档：

| 档位 | 说明 | 技术要求 |
|------|------|----------|
| L1 基础复刻 | 人体主动作大体一致，可导出 VMD 播放 | 2D/3D 姿态 + 基础映射 |
| L2 可用动画 | 明显更稳，脚滑和抖动降低 | 时序平滑 + IK + 接触修正 |
| L3 演出级动作 | 更自然，接近可发布作品 | 高质量姿态模型 + 手脸补全 + 人工微调 |

如果做产品，建议先把目标定在 `L1 -> L2`，不要一开始追求完全自动化的 `L3`。

---

## 研发投入预估

## 方案 1：只做 PoC

目标：

- 输入单人舞蹈视频
- 输出基础 `VMD`
- 可在 `MMD / Three.js` 中播放

预估投入：

- **1 名工程师，2~4 周**

前提：

- 直接复用现有模型
- 先忽略手指、表情和复杂 IK
- 只适配 1~2 个标准 MMD 模型

## 方案 2：做成稳定功能

目标：

- 更稳定的人体动作恢复
- 更好的骨骼映射和修正
- 支持基础批处理或交互式产品

预估投入：

- **2~3 名工程师，6~12 周**

角色通常包括：

- 算法 / Python 工程
- 动画 / 3D 工程
- 前端 / 预览工具工程

---

## 最小可行产品（PoC）建议

## 阶段 1：先打通端到端

链路建议：

1. 上传单人舞蹈视频
2. 用 `MMPose` 或 `MediaPipe` 提取关键点
3. 恢复 3D 骨骼
4. 做基础平滑
5. 映射到标准 MMD 骨架
6. 导出 `VMD`
7. 在 `MMD` 或 `Three.js` 中验证播放

验收标准：

- 模型整体动作与原视频基本一致
- 没有大面积骨骼翻转
- 可稳定导出并导入 `VMD`

## 阶段 2：做“好看”

补强方向：

- 脚底锁定
- 躯干朝向稳定
- 关节抖动去噪
- 中心骨位移优化
- 关键帧抽稀和曲线平滑

## 阶段 3：做“可用”

产品层补充：

- 视频上传和预览
- 动作质量评分
- 自动识别失败片段
- 允许用户手动调节骨骼参数
- 导出 VMD / FBX / 中间 JSON

---

## 产品形态建议

可以考虑三种产品形态：

### 1. 离线工具

- 用户上传视频，本地或桌面端生成 `VMD`
- 实现最简单
- 最适合第一版

### 2. Web 创作工具

- 浏览器上传视频
- 前端展示骨骼预览和模型预览
- 服务端生成 `VMD`

### 3. 创作工作流插件

- 与 `Blender / MMD / Three.js` 结合
- AI 负责粗生成，创作者负责微调

最推荐的是：

**先做离线工具或半离线服务，再逐步演进为 Web 创作工具。**

---

## 风险与限制

## 技术风险

- 复杂舞蹈动作中深度恢复不稳
- 快速旋转、遮挡、裙摆、长发会干扰识别
- 非标准 MMD 模型兼容成本高

## 工程风险

- 老旧开源项目依赖过时
- 不同骨架格式的兼容层容易膨胀
- VMD 导出后仍可能需要人工调试

## 产品风险

- 用户期望容易过高，以为“视频一键直出专业动捕”
- 实际上更适合定位成“AI 动作复刻 + 半自动修正”

---

## 最终建议

如果你的目标是：

### 1. 快速证明能不能做

选：

- `OpenMMD / VMD-Lifting` 一类现成方案

### 2. 做成自己的核心能力

选：

- `Python + MMPose + 自定义骨骼映射 + VMD 导出`

### 3. 做成在线产品

选：

- `前端预览（Three.js + MediaPipe） + 后端离线生成 VMD`

综合推荐结论：

> **最合理的路线是：用现代姿态估计框架自建离线主链路，把 Web 端作为预览和交互层。**
>
> 这样既能保证生成质量，又能兼顾后续产品化。

---

## 推荐的首版技术方案

```text
前端：
视频上传 + Three.js 模型预览 + 生成状态展示

算法后端：
视频预处理
-> MMPose 2D/3D 推理
-> 时序平滑
-> MMD 骨骼映射
-> VMD 导出

验证工具：
MMD / Blender / Three.js
```

首版范围建议控制在：

- 单人
- 固定镜头
- 全身可见
- 标准站姿开场
- 只输出身体主骨骼动作

这样成功率最高，也最容易快速出效果。

---

## 可执行的 PoC 实施方案

下面给出一份更适合直接开工的实施版本。目标不是一步做到演出级质量，而是用最短路径做出一个可验证的系统：

1. 上传单人舞蹈视频
2. 跑完姿态提取和基础后处理
3. 输出可播放的 `VMD`
4. 在 `MMD / Blender / Three.js` 中确认动作基本可用

PoC 的核心原则是：

- **先离线，后在线**
- **先身体主骨骼，后手指表情**
- **先可播放，后追求高质量**
- **先统一模型，后扩大兼容范围**

---

## PoC 范围定义

### 输入范围

- 单人舞蹈视频
- 固定机位或轻微移动镜头
- 人体全身尽量完整入镜
- 30~60 秒以内
- 720p 或 1080p

### 输出范围

- 一个 `VMD`
- 一个骨骼可视化视频
- 一份中间骨骼 JSON
- 一份质量日志（成功率、缺帧率、异常帧）

### 暂不纳入首版

- 多人视频
- 手指级精细动作
- 面部表情和眼球联动
- 非标准 MMD 模型的通用适配
- 浏览器端直接完成高质量 `VMD` 导出

---

## 模块拆分

建议把 PoC 拆成 8 个模块，每个模块职责单一，便于独立调试。

### 模块 1：视频接入层

职责：

- 接收用户上传的视频
- 校验格式、分辨率、时长
- 存储到任务目录
- 生成任务 ID

输入：

- `mp4 / mov / avi`

输出：

- `job_id`
- `input.mp4`
- `meta.json`

### 模块 2：视频预处理

职责：

- 统一帧率
- 统一分辨率
- 抽帧或转码
- 可选做人像裁剪和稳像

输入：

- 原始视频

输出：

- 标准化视频
- 帧图像序列

### 模块 3：姿态提取

职责：

- 生成 2D 关键点
- 生成 3D 关键点或 world landmarks
- 输出每帧置信度

输入：

- 标准化视频或帧序列

输出：

- `pose2d.json`
- `pose3d.json`
- 可视化视频

### 模块 4：时序平滑与动作修正

职责：

- 抖动去噪
- 缺失帧插值
- 身体朝向平滑
- 脚底接触修正
- 减少明显骨骼翻转

输入：

- 原始姿态序列

输出：

- `pose3d_smoothed.json`

### 模块 5：MMD 骨骼映射

职责：

- 将通用人体关键点映射到 MMD 骨骼
- 处理骨长比例
- 计算中心骨位移
- 生成骨骼旋转四元数或欧拉角

输入：

- 平滑后的 3D 骨骼
- 模型骨架配置

输出：

- `mmd_motion.json`

### 模块 6：VMD 导出

职责：

- 将中间动作格式编码为 `VMD`
- 写入骨骼关键帧
- 可选做关键帧抽稀

输入：

- `mmd_motion.json`

输出：

- `output.vmd`

### 模块 7：预览与验证

职责：

- 在 `Three.js` 或 `MMD` 中加载模型和动作
- 导出预览视频或页面
- 验证动作是否可播放

输入：

- `PMX/PMD`
- `VMD`

输出：

- 预览页面或预览视频

### 模块 8：评估与日志

职责：

- 记录每一阶段耗时
- 记录关键点缺失率
- 标记失败片段
- 生成 PoC 评估报告

输入：

- 各阶段中间结果

输出：

- `report.json`
- `artifacts/`

---

## 推荐目录结构

```text
video-to-vmd-poc/
├─ apps/
│  ├─ api/                       # FastAPI 服务
│  └─ web-preview/               # Three.js 预览页
├─ pipeline/
│  ├─ ingest/
│  ├─ preprocess/
│  ├─ pose/
│  ├─ smoothing/
│  ├─ retarget/
│  ├─ export_vmd/
│  └─ evaluation/
├─ configs/
│  ├─ pipeline.dev.yaml
│  ├─ mediapipe.yaml
│  ├─ mmpose.yaml
│  └─ mmd_rig.default.yaml
├─ jobs/
│  └─ <job_id>/
│     ├─ input.mp4
│     ├─ frames/
│     ├─ pose2d.json
│     ├─ pose3d.json
│     ├─ pose3d_smoothed.json
│     ├─ mmd_motion.json
│     ├─ output.vmd
│     └─ report.json
├─ scripts/
│  ├─ run_local_poc.py
│  └─ validate_vmd.py
└─ docs/
   └─ pipeline-notes.md
```

---

## 技术选型建议

## 1. 后端主语言

### 主选：`Python`

原因：

- 姿态估计生态最成熟
- 视频处理、数值处理、CV 工具链丰富
- 方便接入 `MMPose`

### 备选：`Node.js`

只建议用于：

- Web API 层
- 任务编排层

不建议把姿态估计主链路放在 Node 里。

## 2. 姿态估计方案

### 方案 A：`MMPose`

适合作为主引擎，原因：

- 视频推理能力成熟
- 有 2D 与 3D 模型链路
- 可保存 prediction JSON，利于做中间结果分析

### 方案 B：`MediaPipe Pose`

适合作为轻量预览方案，原因：

- 简单、快、易跑
- Web 端也能用
- 可以输出 3D world landmarks

### 推荐结论

- **主链路**：`MMPose`
- **浏览器预览 / 轻量实验**：`MediaPipe Pose`

## 3. API 层

### 主选：`FastAPI`

原因：

- 文件上传简单
- 适合快速起 API
- 能方便挂接后台任务

## 4. 前端预览

### 主选：`Three.js`

原因：

- 后续本来就要接 `PMX/PMD + VMD`
- 可以统一到同一套预览工作流
- 便于可视化骨骼、模型和播放结果

## 5. 中间动作格式

建议不要直接让每个阶段都写 `VMD`，而是先统一一个内部格式，例如：

```json
{
  "fps": 30,
  "frames": [
    {
      "frame": 0,
      "bones": {
        "センター": { "position": [0, 0, 0] },
        "上半身": { "rotation": [0, 0, 0, 1] },
        "左腕": { "rotation": [0, 0, 0, 1] }
      }
    }
  ]
}
```

这样做的好处是：

- 更方便调试
- 更方便在 `Blender / Three.js` 中回放
- 后续除了 `VMD`，还可以扩展到 `FBX / BVH / GLTF`

---

## 分阶段里程碑

下面是一份适合 4 周 PoC 的里程碑安排。

## 里程碑 1：打通离线单机链路（第 1 周）

目标：

- 本地输入一段视频
- 提取姿态并输出中间 JSON

交付物：

- `run_local_poc.py`
- `pose2d.json`
- `pose3d.json`
- 可视化骨骼视频

验收标准：

- 单人视频可稳定跑完
- 每帧都有姿态输出
- 中间结果可人工检查

## 里程碑 2：输出第一版 VMD（第 2 周）

目标：

- 基于中间骨骼数据生成第一版 `VMD`

交付物：

- `mmd_motion.json`
- `output.vmd`
- `MMD` 或 `Three.js` 可播放演示

验收标准：

- 模型能动起来
- 主体动作方向基本正确
- 没有系统性崩坏

## 里程碑 3：动作质量修正（第 3 周）

目标：

- 降低抖动、脚滑和骨骼翻转

交付物：

- 平滑模块
- 脚底锁定规则
- 对比视频（修正前 / 修正后）

验收标准：

- 动作明显更稳
- 脚部漂移显著下降
- 大幅减少瞬时翻转

## 里程碑 4：封装成最小产品流程（第 4 周）

目标：

- 提供最简单的上传、处理、下载、预览闭环

交付物：

- `FastAPI` 上传接口
- 任务状态查询接口
- Three.js 预览页面

验收标准：

- 用户可以上传视频并拿到 `VMD`
- 可以在线查看骨骼预览或模型预览
- 整条链路从输入到输出闭环完成

---

## 任务拆解建议

如果按工程任务拆分，建议顺序如下：

1. 建立统一任务目录结构和中间结果格式
2. 实现视频预处理脚本
3. 打通 `MMPose` 视频推理并保存预测结果
4. 做第一版平滑与插值
5. 完成 MMD 骨骼映射
6. 写 `VMD` 导出器
7. 在 `MMD / Three.js` 中验证播放
8. 增加 `FastAPI` 上传与任务查询
9. 增加 Three.js 预览页
10. 增加评估报告和失败定位日志

---

## PoC 成功标准

PoC 是否成功，不建议只看“能不能出一个 VMD”，而建议看以下 5 项：

1. **端到端成功率**：10 个视频中至少 7 个能跑通
2. **播放可用性**：导出的 `VMD` 能被目标模型稳定加载
3. **动作一致性**：人体大动作与原视频基本一致
4. **可诊断性**：失败时能定位是姿态问题、映射问题还是导出问题
5. **可扩展性**：能继续补手指、表情、多模型适配

---

## 示例代码

下面的代码以“PoC 骨架”为目标，重点是说明怎么组织，而不是直接覆盖全部细节。

## 示例 1：MMPose 3D 推理脚本

这个例子说明如何基于 `MMPoseInferencer` 读取视频并输出预测结果目录。文档显示 `MMPoseInferencer` 支持视频输入，并可通过 `pred_out_dir` / `out_dir` 保存预测和可视化结果。

```python
from pathlib import Path

from mmpose.apis import MMPoseInferencer


def run_pose_inference(video_path: str, output_dir: str) -> None:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    inferencer = MMPoseInferencer(
        pose2d="human",
        pose3d="human3d",
    )

    result_generator = inferencer(
        video_path,
        out_dir=str(out_dir),
        draw_bbox=False,
        show=False,
    )

    # 对视频输入，生成器会持续产出结果直到处理结束
    for _ in result_generator:
        pass


if __name__ == "__main__":
    run_pose_inference(
        video_path="jobs/demo/input.mp4",
        output_dir="jobs/demo/mmpose_output",
    )
```

建议产出：

- `jobs/demo/mmpose_output/predictions/`
- `jobs/demo/mmpose_output/visualizations/`

## 示例 2：统一中间动作格式

这段代码展示一个建议的中间动作结构，后面的平滑、骨骼映射、VMD 导出都围绕它工作。

```python
from dataclasses import dataclass, field


@dataclass
class BoneTransform:
    position: list[float] | None = None
    rotation: list[float] | None = None  # quaternion [x, y, z, w]


@dataclass
class MotionFrame:
    frame: int
    bones: dict[str, BoneTransform] = field(default_factory=dict)


@dataclass
class MotionClip:
    fps: int
    frames: list[MotionFrame]


clip = MotionClip(
    fps=30,
    frames=[
        MotionFrame(
            frame=0,
            bones={
                "センター": BoneTransform(position=[0.0, 0.0, 0.0]),
                "上半身": BoneTransform(rotation=[0.0, 0.0, 0.0, 1.0]),
            },
        )
    ],
)
```

首版建议：

- 先只生成这些骨骼：`センター`、`下半身`、`上半身`、`首`、`頭`、双臂、双腿
- 暂不处理表情骨和手指骨

## 示例 3：FastAPI 上传与后台处理入口

这个例子对应 PoC 的最小服务化版本。`FastAPI` 文档支持 `UploadFile` 文件上传，并支持后台任务模式。

```python
from pathlib import Path
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, UploadFile

app = FastAPI()
JOBS_DIR = Path("jobs")
JOBS_DIR.mkdir(exist_ok=True)


def run_pipeline(job_id: str) -> None:
    # 这里按顺序执行：预处理 -> 姿态 -> 平滑 -> 映射 -> 导出
    print(f"start pipeline for {job_id}")


@app.post("/jobs")
async def create_job(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
):
    job_id = str(uuid4())
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    target = job_dir / "input.mp4"
    with target.open("wb") as f:
        f.write(await file.read())

    background_tasks.add_task(run_pipeline, job_id)

    return {
        "job_id": job_id,
        "status": "queued",
        "input_file": str(target),
    }
```

PoC 阶段这样就够了：

- `POST /jobs`：上传视频并启动后台任务
- `GET /jobs/{job_id}`：查状态
- `GET /jobs/{job_id}/artifacts`：拿结果文件

## 示例 4：浏览器端骨骼预览

如果你希望用户在网页里先看到姿态提取是否正常，可以先用 `MediaPipe Pose` 做轻量预览。官方方案支持视频模式和 world landmarks 输出。

```html
<script type="module">
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const vision = await FilesetResolver.forVisionTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
);

const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath: "/models/pose_landmarker_lite.task",
  },
  runningMode: "VIDEO",
  numPoses: 1,
});

const video = document.querySelector("video");
let lastVideoTime = -1;

function loop() {
  if (video.currentTime !== lastVideoTime) {
    const result = poseLandmarker.detectForVideo(video, performance.now());
    console.log(result.landmarks, result.worldLandmarks);
    lastVideoTime = video.currentTime;
  }

  requestAnimationFrame(loop);
}

loop();
</script>
```

这个预览层的价值是：

- 提前发现视频质量问题
- 让用户在生成 `VMD` 前就看到骨骼结果
- 为后续的 Three.js 模型预览提供输入

---

## 首版建议的实现顺序

最推荐的落地顺序不是“先做完整 Web 产品”，而是：

### 第一步：本地脚本版

- 一个脚本输入视频
- 输出 JSON、预览视频和 `VMD`

### 第二步：本地 API 版

- 把脚本封成 `FastAPI`
- 增加任务目录和状态管理

### 第三步：前端预览版

- 增加上传页
- 增加骨骼预览
- 增加 Three.js 模型回放

### 第四步：质量增强版

- 脚底锁定
- 关键帧抽稀
- 手脸补全
- 多模型适配

---

## 这份 PoC 方案的最终推荐

如果今天就开始做，我建议按下面这个组合开工：

- `Python + MMPose + NumPy/SciPy`：动作主链路
- `FastAPI`：上传、任务调度、结果查询
- `Three.js`：动作预览和模型回放
- `MediaPipe`：可选的浏览器端轻量骨骼预览
- `Blender + mmd_tools`：人工校验与调试辅助

一句话落地方案：

> **先做“离线视频 -> 姿态 JSON -> MMD 动作 JSON -> VMD”的稳定流水线，再把它封装成 API 和 Web 预览。**

---

## 参考工具与资料

- `OpenMMD`：可将真人视频转换为 MMD 动作文件的开源项目
- `VMD-Lifting`：从图像/视频估计 3D 姿态并输出 `VMD`
- `MMPose`：支持视频级 2D/3D 人体姿态推理
- `MediaPipe Pose / Holistic`：支持视频姿态跟踪，可输出 3D world landmarks
- `blender_mmd_tools`：支持 `PMD/PMX/VMD` 的导入导出

参考链接：

- OpenMMD: `https://github.com/peterljq/OpenMMD`
- VMD-Lifting: `https://github.com/errno-mmd/VMD-Lifting`
- VMD-3d-pose-baseline-multi: `https://github.com/miu200521358/VMD-3d-pose-baseline-multi`
- MMPose Docs: `https://mmpose.readthedocs.io/`
- MediaPipe Pose Landmarker: `https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker`
- blender_mmd_tools: `https://github.com/MMD-Blender/blender_mmd_tools`

---

## 结论复述

这件事不是“有没有可能”，而是“做到什么质量、投入多少工程成本”。

结论可以概括为三句话：

1. **真人视频转 VMD 在技术上可行，已有开源先例。**
2. **真正的难点不是导出 VMD，而是高质量 3D 动作恢复和 MMD 骨骼重定向。**
3. **最靠谱的落地方式是：离线高质量生成 + 前端交互预览 + 人工轻量修正。**
