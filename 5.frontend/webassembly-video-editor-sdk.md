# WebAssembly 视频编辑器 SDK 架构设计

> 涵盖整体架构、JSON Schema 数据模型、内存管理、自适应加载策略、Canvas 渲染与交互全链路。

---

## 目录

1. [整体架构分层](#1-整体架构分层)
2. [项目 JSON Schema 设计](#2-项目-json-schema-设计)
   - 2.1 [核心 Project Manifest](#21-核心-project-manifest)
   - 2.2 [复合文本（Rich Text）](#22-复合文本rich-text)
   - 2.3 [精灵图（Sprite Sheet）](#23-精灵图sprite-sheet)
   - 2.4 [字幕（Subtitle）](#24-字幕subtitle)
   - 2.5 [转场（Transition）](#25-转场transition)
   - 2.6 [数据模型关系总览](#26-数据模型关系总览)
3. [核心模块设计](#3-核心模块设计)
   - 3.1 [Command 系统（Undo/Redo）](#31-command-系统undoredo)
   - 3.2 [预览管线](#32-预览管线)
   - 3.3 [多轨合成器](#33-多轨合成器compositor)
   - 3.4 [导出管线](#34-导出管线)
   - 3.5 [Bridge 层设计](#35-bridge-层设计)
   - 3.6 [插件 / 特效扩展机制](#36-插件--特效扩展机制)
   - 3.7 [文件存储策略](#37-文件存储策略)
4. [WebAssembly 内存管理](#4-webassembly-内存管理)
   - 4.1 [Wasm 内存模型基础](#41-wasm-内存模型基础)
   - 4.2 [视频编辑器内存压力分析](#42-视频编辑器内存压力分析)
   - 4.3 [分区内存架构（Arena Allocator）](#43-分区内存架构arena-allocator)
   - 4.4 [帧缓存池（Frame Pool）](#44-帧缓存池frame-pool)
   - 4.5 [JS ↔ Wasm 零拷贝通信](#45-js--wasm-零拷贝通信)
   - 4.6 [内存增长与收缩策略](#46-内存增长与收缩策略)
   - 4.7 [多实例内存隔离架构](#47-多实例内存隔离架构)
   - 4.8 [内存泄漏防御](#48-内存泄漏防御)
5. [运行时能力探测与自适应加载](#5-运行时能力探测与自适应加载)
   - 5.1 [能力探测层（Capability Probe）](#51-能力探测层capability-probe)
   - 5.2 [设备画像与档位决策](#52-设备画像与档位决策)
   - 5.3 [档位对应的运行策略](#53-档位对应的运行策略)
   - 5.4 [条件化 Wasm 包加载](#54-条件化-wasm-包加载)
   - 5.5 [运行时动态降级](#55-运行时动态降级)
   - 5.6 [完整启动流程](#56-完整启动流程)
6. [Wasm → Canvas 渲染与交互](#6-wasm--canvas-渲染与交互)
   - 6.1 [三条渲染路径](#61-三条渲染路径)
   - 6.2 [路径 A：CPU 合成 → Canvas2D](#62-路径-acpu-合成--canvas2d)
   - 6.3 [路径 B：Wasm + WebGL2](#63-路径-bwasm--webgl2)
   - 6.4 [路径 C：WebCodecs + VideoFrame](#64-路径-cwebcodecs--videoframe)
   - 6.5 [交互事件处理](#65-交互事件处理)
   - 6.6 [Worker 架构下的渲染循环](#66-worker-架构下的渲染循环)
   - 6.7 [渲染方案选择决策树](#67-渲染方案选择决策树)

---

## 1. 整体架构分层

```
┌─────────────────────────────────────────────────┐
│  Host Layer (JS/TS)                             │
│  Timeline UI · Preview Player · Plugin API      │
├─────────────────────────────────────────────────┤
│  Bridge Layer (wasm-bindgen / Emscripten)       │
│  Command Queue · SharedArrayBuffer Ring Buffer  │
├─────────────────────────────────────────────────┤
│  Core Layer (Rust/C++ → Wasm)                   │
│  Decoder · Encoder · Compositor · Effect Pipeline│
│  Audio Mixer · Frame Cache (LRU)                │
├─────────────────────────────────────────────────┤
│  Storage Layer                                  │
│  OPFS · IndexedDB · HTTP Range (remote assets)  │
└─────────────────────────────────────────────────┘
```

**关键技术决策：Rust → Wasm**

- 用 Rust 编写 Core Layer，通过 `wasm-bindgen` 暴露接口
- FFmpeg 的解码/编码部分通过 Emscripten 编译为 Wasm 子模块，Rust 侧通过 FFI 调用
- 预览走 WebCodecs API（硬件加速），导出走 Wasm 内 FFmpeg 软编码

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Core 语言 | Rust | 内存安全 + Wasm 生态成熟 |
| 解码 | WebCodecs 优先，Wasm FFmpeg 回退 | 硬件加速 vs 兼容性 |
| 合成渲染 | WebGL (OffscreenCanvas) | GPU 加速，不阻塞主线程 |
| 帧传输 | SharedArrayBuffer | 零拷贝，避免序列化开销 |
| 数据模型 | 单一 JSON + Command 变换 | 可序列化、可撤销、可协同 |
| 存储 | OPFS + IndexedDB | 大文件性能 + 元数据查询 |
| 线程模型 | Main + Worker(预览) + Worker(导出) | UI 不卡顿 |
| 音频 | AudioWorklet + SharedArrayBuffer | 低延迟实时混音 |

---

## 2. 项目 JSON Schema 设计

### 2.1 核心 Project Manifest

整个编辑器的核心数据模型，所有操作都是对这个 JSON 的变换：

```
Project
├── meta            # 项目元信息
├── assets[]        # 素材库（视频/音频/图片/字幕文件）
├── timeline        # 时间线
│   ├── tracks[]    # 多轨道（视频轨、音频轨、字幕轨、特效轨）
│   │   └── clips[] # 每轨上的片段
│   │       ├── source      → asset ref
│   │       ├── in/out      → 素材裁剪范围
│   │       ├── offset/duration → 时间线上的位置
│   │       ├── effects[]   → 特效链
│   │       └── transitions → 转场
│   └── markers[]   # 标记点
└── output          # 导出配置
```

完整结构：

```jsonc
{
  "$schema": "https://sdk.example.com/v1/project.schema.json",
  "meta": {
    "id": "uuid-v4",
    "name": "My Project",
    "version": "1.0.0",
    "createdAt": "ISO-8601",
    "resolution": { "w": 1920, "h": 1080 },
    "fps": 30,
    "duration": 120.5
  },

  "assets": [
    {
      "id": "asset-001",
      "type": "video | audio | image | subtitle | lottie",
      "name": "interview.mp4",
      "source": {
        "type": "opfs | indexeddb | url",
        "uri": "opfs:///raw/interview.mp4",
        "byteSize": 52428800,
        "checksum": "sha256:abcdef..."
      },
      "probe": {
        "duration": 65.3,
        "videoStreams": [{ "codec": "h264", "w": 1920, "h": 1080, "fps": 29.97 }],
        "audioStreams": [{ "codec": "aac", "sampleRate": 48000, "channels": 2 }],
        "thumbnailStrip": "opfs:///cache/asset-001-thumbs.bin"
      }
    }
  ],

  "timeline": {
    "tracks": [
      {
        "id": "track-v0",
        "type": "video",
        "name": "主视频轨",
        "locked": false,
        "visible": true,
        "volume": 1.0,
        "clips": [
          {
            "id": "clip-001",
            "assetId": "asset-001",
            "in": 5.0,
            "out": 30.0,
            "offset": 0.0,
            "duration": 25.0,
            "speed": 1.0,
            "opacity": 1.0,
            "transform": {
              "x": 0, "y": 0,
              "scaleX": 1.0, "scaleY": 1.0,
              "rotation": 0,
              "anchor": [0.5, 0.5]
            },
            "crop": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
            "effects": [
              {
                "id": "fx-001",
                "type": "builtin:color-correction",
                "enabled": true,
                "params": {
                  "brightness": 0.1,
                  "contrast": 1.2,
                  "saturation": 0.9
                },
                "keyframes": [
                  { "time": 0.0, "params": { "brightness": 0.0 } },
                  { "time": 2.0, "params": { "brightness": 0.1 } }
                ]
              }
            ],
            "transition": {
              "type": "crossfade",
              "duration": 0.5,
              "params": {}
            }
          }
        ]
      },
      {
        "id": "track-a0",
        "type": "audio",
        "name": "BGM",
        "clips": [/* 同结构，无 transform/opacity/crop */]
      }
    ],

    "markers": [
      { "time": 15.0, "label": "重点片段", "color": "#ff0000" }
    ]
  },

  "styles": {
    "style-001": {
      "fontFamily": "Noto Sans SC",
      "fontSize": 48,
      "color": "#ffffff",
      "stroke": { "color": "#000000", "width": 2 },
      "position": "bottom-center"
    }
  },

  "output": {
    "format": "mp4",
    "codec": { "video": "h264", "audio": "aac" },
    "resolution": { "w": 1920, "h": 1080 },
    "fps": 30,
    "bitrate": { "video": "8M", "audio": "192k" },
    "preset": "medium"
  }
}
```

---

### 2.2 复合文本（Rich Text）

核心难点：文本不是单一元素，是一棵**排版树**——段落、行内样式、图文混排、动画都要描述。

```jsonc
{
  "id": "clip-text-001",
  "type": "text",
  "offset": 10.0,
  "duration": 5.0,
  "transform": { "x": 960, "y": 540, "scaleX": 1, "scaleY": 1, "rotation": 0 },

  "textBody": {
    "layout": {
      "width": 800,
      "height": null,
      "overflow": "visible | clip | scroll",
      "alignment": "center",
      "verticalAlign": "middle",
      "direction": "ltr | rtl",
      "writingMode": "horizontal-tb | vertical-rl"
    },

    // 核心：paragraphs → fragments 两级树结构
    "paragraphs": [
      {
        "align": "center",
        "lineHeight": 1.4,
        "spacing": { "before": 0, "after": 10 },
        "fragments": [
          {
            "type": "text",
            "content": "2024 年度",
            "style": {
              "fontFamily": "Noto Sans SC",
              "fontSize": 72,
              "fontWeight": 700,
              "color": "#FFFFFF",
              "letterSpacing": 4,
              "italic": false
            },
            "decoration": {
              "stroke": { "color": "#000000", "width": 3, "join": "round" },
              "shadow": [
                { "offsetX": 2, "offsetY": 2, "blur": 6, "color": "rgba(0,0,0,0.8)" }
              ],
              "gradient": null
            }
          },
          {
            "type": "text",
            "content": "最佳影片",
            "style": {
              "fontFamily": "Noto Serif SC",
              "fontSize": 96,
              "fontWeight": 900,
              "color": "transparent"
            },
            "decoration": {
              "gradient": {
                "type": "linear",
                "angle": 135,
                "stops": [
                  { "offset": 0, "color": "#FFD700" },
                  { "offset": 1, "color": "#FF6B00" }
                ]
              },
              "stroke": { "color": "#8B4513", "width": 2, "join": "round" }
            }
          },
          {
            "type": "image",        // 行内图片（emoji / icon 混排）
            "assetId": "asset-icon-star",
            "inlineSize": { "w": 64, "h": 64 },
            "verticalAlign": "middle"
          },
          {
            "type": "break"         // 强制换行
          },
          {
            "type": "text",
            "content": "提名作品",
            "style": { "fontSize": 48, "fontFamily": "Noto Sans SC", "color": "#CCCCCC" }
          }
        ]
      }
    ],

    // 背景板
    "background": {
      "enabled": true,
      "color": "rgba(0,0,0,0.6)",
      "borderRadius": 12,
      "padding": { "top": 20, "right": 30, "bottom": 20, "left": 30 }
    }
  },

  // 文本级动画
  "animations": {
    "in": {
      "type": "typewriter | fadeUp | scaleIn | custom",
      "duration": 0.8,
      "easing": "cubicBezier(0.25, 0.1, 0.25, 1)",
      "perChar": true,
      "charDelay": 0.03
    },
    "out": {
      "type": "fadeOut",
      "duration": 0.5,
      "easing": "easeIn"
    },
    "loop": null
  }
}
```

**设计要点：**

- `paragraphs → fragments` 两级结构，对齐 HTML 的 `<p> → <span>` 模型，渲染侧可直接映射到 Canvas Text API 或 SDF 字体渲染
- `fragment.type` 支持 `text | image | break`，实现图文混排
- `decoration` 和 `style` 分离——style 控制字体排版，decoration 控制视觉装饰（描边/阴影/渐变），避免属性爆炸
- 动画用 `perChar + charDelay` 描述逐字动画，引擎侧按公式 `charStartTime = in.startTime + index * charDelay` 展开

---

### 2.3 精灵图（Sprite Sheet）

精灵图在视频编辑器里有两个场景：**序列帧动画素材**和**贴纸/表情包**。

**Asset 定义：**

```jsonc
{
  "id": "asset-sprite-001",
  "type": "sprite",
  "name": "fire-explosion",
  "source": {
    "type": "opfs",
    "uri": "opfs:///raw/fire-explosion.png"
  },

  "spriteSheet": {
    // 方式一：均匀网格切割（最常见）
    "mode": "grid",
    "grid": {
      "cols": 8,
      "rows": 4,
      "frameWidth": 256,
      "frameHeight": 256,
      "totalFrames": 30,
      "padding": 0
    },

    // 方式二：不规则切割（TexturePacker 导出格式兼容）
    // "mode": "atlas",
    // "atlas": {
    //   "frames": [
    //     { "id": "frame_00", "x": 0, "y": 0, "w": 200, "h": 180, "anchor": [0.5, 0.8] },
    //     { "id": "frame_01", "x": 200, "y": 0, "w": 210, "h": 185, "anchor": [0.5, 0.8] }
    //   ]
    // },

    "animation": {
      "fps": 24,
      "loop": true,
      "pingPong": false,
      "direction": "forward | reverse | pingPong"
    }
  }
}
```

**Clip 引用精灵图：**

```jsonc
{
  "id": "clip-sprite-001",
  "type": "sprite",
  "assetId": "asset-sprite-001",
  "offset": 5.0,
  "duration": 3.0,
  "transform": { "x": 200, "y": 300, "scaleX": 0.5, "scaleY": 0.5, "rotation": 0 },

  "playback": {
    "startFrame": 0,
    "endFrame": 29,
    "speed": 1.0,
    "fillMode": "loop | clamp | hide"
  },

  "blendMode": "normal | screen | additive | multiply",
  "opacity": 1.0,
  "effects": []
}
```

**引擎侧帧映射公式：**

```
spriteFrameIndex = floor((clipLocalTime * speed * sprite.fps) % totalFrames)
sourceRect = grid 模式下按 (index % cols, index / cols) 计算
```

---

### 2.4 字幕（Subtitle）

字幕比复合文本更侧重**时间同步**和**批量管理**，Schema 需要兼容 SRT/ASS 导入导出。

```jsonc
{
  "id": "track-subtitle-main",
  "type": "subtitle",
  "name": "中文字幕",
  "locked": false,
  "visible": true,

  // 轨道级默认样式（clip 级可覆盖）
  "defaultStyle": {
    "fontFamily": "Noto Sans SC",
    "fontSize": 42,
    "color": "#FFFFFF",
    "stroke": { "color": "#000000", "width": 2 },
    "shadow": { "offsetX": 1, "offsetY": 1, "blur": 3, "color": "rgba(0,0,0,0.7)" },
    "background": { "color": "rgba(0,0,0,0.4)", "padding": 6, "borderRadius": 4 },
    "position": {
      "anchor": "bottom-center",
      "offsetX": 0,
      "offsetY": -60
    },
    "maxWidth": "80%",
    "lineCount": 2
  },

  "clips": [
    {
      "id": "sub-001",
      "offset": 2.500,
      "duration": 3.200,

      // 简单模式：纯文本
      "content": "大家好，欢迎来到今天的节目",

      // 进阶模式：逐词时间戳（卡拉OK效果）
      "words": [
        { "text": "大家好，", "start": 0.0, "end": 0.8 },
        { "text": "欢迎",    "start": 0.8, "end": 1.3 },
        { "text": "来到",    "start": 1.3, "end": 1.7 },
        { "text": "今天的",  "start": 1.7, "end": 2.3 },
        { "text": "节目",    "start": 2.3, "end": 3.0 }
      ],

      // 卡拉OK高亮样式
      "karaoke": {
        "enabled": true,
        "activeColor": "#FFD700",
        "activeScale": 1.1,
        "inactiveColor": "#FFFFFF80"
      },

      // 样式覆盖（仅覆盖与 defaultStyle 不同的部分）
      "styleOverride": {
        "fontSize": 52,
        "color": "#FFD700"
      },

      // 字幕入出动画
      "animation": {
        "in": { "type": "fadeIn", "duration": 0.2 },
        "out": { "type": "fadeOut", "duration": 0.2 }
      },

      // 翻译对照（多语言字幕）
      "translations": {
        "en": "Hello everyone, welcome to today's show",
        "ja": "皆さん、こんにちは。今日の番組へようこそ"
      }
    }
  ]
}
```

**与 SRT/ASS 的映射关系：**

| 字段 | SRT | ASS |
|------|-----|-----|
| `offset` / `duration` | 时间码 `00:00:02,500 --> 00:00:05,700` | `Dialogue: 0,0:00:02.50,0:00:05.70` |
| `content` | 文本行 | `Text` 字段 |
| `defaultStyle` | 无（播放器决定） | `[V4+ Styles]` 段 |
| `styleOverride` | 无 | `{\b1\fs52}` 行内覆盖 |
| `words` | 无 | `\k` / `\kf` 标签（卡拉OK） |
| `translations` | 无（单语） | 无（多轨） |

---

### 2.5 转场（Transition）

转场发生在**同一轨道相邻两个 clip 的重叠区间**。

**转场注册表（全局定义）：**

```jsonc
{
  "transitionRegistry": {
    "builtin:crossfade": {
      "name": "交叉淡化",
      "category": "基础",
      "params": [
        { "key": "curve", "type": "enum", "values": ["linear", "easeIn", "easeOut", "easeInOut"], "default": "easeInOut" }
      ],
      "implementation": "wasm-core"
    },
    "builtin:wipe": {
      "name": "擦除",
      "category": "基础",
      "params": [
        { "key": "direction", "type": "enum", "values": ["left", "right", "up", "down", "radial"], "default": "left" },
        { "key": "softness", "type": "float", "min": 0, "max": 1, "default": 0.1 },
        { "key": "curve", "type": "enum", "values": ["linear", "easeIn", "easeOut", "easeInOut"], "default": "linear" }
      ],
      "implementation": "wasm-core"
    },
    "builtin:slide": {
      "name": "推移",
      "category": "运动",
      "params": [
        { "key": "direction", "type": "enum", "values": ["left", "right", "up", "down"], "default": "left" },
        { "key": "pushMode", "type": "boolean", "default": true }
      ]
    },
    "builtin:zoom": {
      "name": "缩放",
      "category": "运动",
      "params": [
        { "key": "mode", "type": "enum", "values": ["zoomIn", "zoomOut", "zoomRotate"], "default": "zoomIn" },
        { "key": "center", "type": "vec2", "default": [0.5, 0.5] }
      ]
    },
    "shader:glitch-transition": {
      "name": "故障转场",
      "category": "特效",
      "params": [
        { "key": "intensity", "type": "float", "min": 0, "max": 1, "default": 0.7 },
        { "key": "blockSize", "type": "int", "min": 2, "max": 64, "default": 16 },
        { "key": "colorShift", "type": "boolean", "default": true }
      ],
      "implementation": {
        "type": "glsl",
        "uri": "opfs:///plugins/transitions/glitch.frag"
      }
    },
    "luma:custom-mask": {
      "name": "自定义遮罩转场",
      "category": "遮罩",
      "params": [
        { "key": "maskAssetId", "type": "assetRef", "default": null },
        { "key": "softness", "type": "float", "min": 0, "max": 1, "default": 0.05 },
        { "key": "invert", "type": "boolean", "default": false }
      ]
    }
  }
}
```

**Clip 上的转场引用：**

```jsonc
// track.clips 数组中，clip B 与前一个 clip A 有重叠
{
  "id": "clip-A",
  "offset": 0.0,
  "duration": 10.0
},
{
  "id": "clip-B",
  "offset": 8.5,           // 与 clip-A 重叠 1.5 秒
  "duration": 12.0,

  "transition": {
    "id": "trans-001",
    "type": "builtin:wipe",
    "duration": 1.5,        // 必须 ≤ 两个 clip 的重叠时长
    "params": {
      "direction": "left",
      "softness": 0.15,
      "curve": "easeInOut"
    },
    "alignment": "center"   // center | clipB-start | clipA-end
  }
}
```

**引擎合成逻辑（伪码）：**

```rust
fn composite_transition(t: f64, clipA: Frame, clipB: Frame, transition: Transition) -> Frame {
    let progress = (t - transition.start) / transition.duration;  // 0.0 → 1.0
    let eased = apply_easing(progress, transition.params.curve);

    match transition.type {
        "crossfade" => mix(clipA, clipB, eased),
        "wipe"      => wipe(clipA, clipB, eased, direction, softness),
        "luma"      => luma_key(clipA, clipB, eased, mask_texture, softness),
        "glsl"      => run_shader(clipA, clipB, eased, shader_program, params),
    }
}
```

**Shader 转场统一接口约定：**

所有 GLSL 转场 shader 遵循统一接口，引擎注入标准 uniform：

```glsl
uniform sampler2D u_texA;          // 前一个 clip 帧
uniform sampler2D u_texB;          // 后一个 clip 帧
uniform float     u_progress;      // 0.0 → 1.0 (已经过 easing)
uniform vec2      u_resolution;    // 画面尺寸
// + 自定义 params 按 key 映射为 uniform
```

---

### 2.6 数据模型关系总览

```
Timeline
├── Track (video)
│   ├── Clip A ─────── transition ──── Clip B
│   │   └── effects[]                  └── effects[]
│   └── ...
├── Track (subtitle)
│   ├── SubClip { content, words[], karaoke }
│   └── SubClip { content, translations }
├── Track (overlay)
│   ├── TextClip { textBody: { paragraphs: [fragments[]] }, animations }
│   └── SpriteClip { assetId → SpriteSheet, playback }
└── Track (audio)
    └── ...
```

**统一设计原则：**

| 原则 | 体现 |
|------|------|
| 分层覆盖 | 轨道级 `defaultStyle` → clip 级 `styleOverride`，减少冗余 |
| 声明式 | 只描述"是什么"，不描述"怎么渲染"，引擎自行选择最优路径 |
| 可序列化 | 全部 JSON，无函数/回调，支持存储/传输/版本迁移 |
| 可扩展 | `type` 字段区分种类，`params` 字典承载参数，新增类型不破坏旧结构 |
| 时间为王 | 所有元素最终都映射到 `offset + duration` 的时间轴坐标，合成器统一按时间查询 |

---

## 3. 核心模块设计

### 3.1 Command 系统（Undo/Redo）

不直接修改 JSON，所有变更走 **Command Pattern**：

```
Command {
  type: "clip.move" | "clip.trim" | "track.add" | "effect.update" | ...
  payload: { ... }
  inverse: { ... }    // 自动生成的逆操作
}
```

- JS 侧维护 `CommandHistory` 栈（undo/redo）
- 每个 Command 生成后，**同时**更新 JS 侧的 JSON 模型和通过 Bridge 通知 Wasm Core
- 可选：Command 序列化后支持协同编辑（OT/CRDT）

### 3.2 预览管线

```
Seek(t) →
  Wasm Core 根据 t 算出各轨道需要的帧 →
  Decoder 解码（WebCodecs 硬解 or Wasm 软解回退）→
  Compositor 合成（Wasm 内 CPU 或 OffscreenCanvas + WebGL）→
  输出到 <canvas> / VideoFrame
```

**两级预览策略：**

| 场景 | 方案 | 帧率 |
|------|------|------|
| 拖动 Scrub | 低分辨率缩略图条带（预生成） | 即时 |
| 播放预览 | WebCodecs 硬解 + WebGL 合成 | 30fps |
| 精确帧预览 | Wasm 软解 + CPU 合成 | 按需 |

### 3.3 多轨合成器（Compositor）

Wasm Core 内的合成逻辑：

1. 按 `track` 顺序从下到上堆叠（z-order = 数组索引）
2. 每个 clip 应用 `transform → crop → effects chain`
3. 相邻 clip 应用 `transition` 混合
4. 音频轨并行走 Audio Mixer（混音 + 音量包络）
5. 最终帧写入 SharedArrayBuffer，JS 侧零拷贝渲染

### 3.4 导出管线

```
Timeline JSON →
  Wasm Core 逐帧合成 →
  FFmpeg(Wasm) 编码 →
  写入 OPFS 流式文件 →
  触发下载 / 上传
```

- 用 Web Worker 隔离导出，不阻塞 UI
- 支持分段导出 + 断点续传
- 进度通过 `postMessage` 回报

### 3.5 Bridge 层设计

JS ↔ Wasm 通信是性能瓶颈，设计要点：

| 数据类型 | 传输方式 |
|----------|----------|
| 命令/事件 | `wasm-bindgen` 函数调用，JSON 序列化 |
| 视频帧 | `SharedArrayBuffer` 环形缓冲区，零拷贝 |
| 缩略图 | Wasm 直接写入 `Uint8Array`，JS 侧创建 `ImageBitmap` |
| 音频 PCM | `AudioWorklet` 共享内存 |

关键 API 接口（Wasm 暴露给 JS）：

```
// 项目管理
engine.load_project(json: string) → Result
engine.get_project_snapshot() → string

// 预览
engine.seek(time_sec: f64) → FrameHandle
engine.decode_range(start: f64, end: f64) → StreamHandle
engine.get_audio_waveform(asset_id, start, end) → Float32Array

// 合成
engine.composite_frame(time_sec: f64) → FrameBuffer
engine.render_to_canvas(canvas: OffscreenCanvas, time_sec: f64)

// 导出
engine.start_export(config_json: string) → ExportHandle
engine.poll_export_progress(handle) → { percent, eta_sec }
engine.cancel_export(handle)

// 素材
engine.probe_asset(data: &[u8]) → ProbeResult
engine.generate_thumbnails(asset_id, interval_sec) → ThumbnailStrip
engine.generate_waveform(asset_id) → WaveformData
```

### 3.6 插件 / 特效扩展机制

```jsonc
{
  "id": "plugin:glitch-v1",
  "type": "webgl-shader | wasm-module | js-function",
  "manifest": {
    "name": "Glitch Effect",
    "params": [
      { "key": "intensity", "type": "float", "min": 0, "max": 1, "default": 0.5 },
      { "key": "blockSize", "type": "int", "min": 1, "max": 64, "default": 8 }
    ],
    "supports": ["video"],
    "keyframeable": true
  }
}
```

- **内置特效**：Wasm 内实现（色彩校正、模糊、裁剪、变速）
- **WebGL Shader 特效**：用户提供 GLSL fragment shader，引擎注入 uniform
- **第三方 Wasm 模块**：独立 `.wasm` 文件，通过标准接口接入

### 3.7 文件存储策略

```
OPFS (Origin Private File System)
├── /raw/           # 原始素材（大文件）
├── /cache/
│   ├── thumbs/     # 缩略图条带
│   ├── waveforms/  # 音频波形
│   └── decoded/    # 解码缓存（LRU 淘汰）
├── /projects/
│   └── {id}.json   # 项目文件
└── /exports/       # 导出产物
```

- 大文件用 OPFS（高性能随机读写）
- 项目 JSON 同时存 IndexedDB（便于列表查询）
- 远程素材支持 HTTP Range 按需拉取，配合本地缓存

---

## 4. WebAssembly 内存管理

### 4.1 Wasm 内存模型基础

Wasm 的内存是一块**连续的线性字节数组**（`WebAssembly.Memory`），JS 侧看到的是 `ArrayBuffer`。

```
┌──────────────────────────────────────────────────────┐
│                 Wasm Linear Memory                   │
│  ┌──────┐ ┌──────────┐ ┌───────────┐ ┌───────────┐  │
│  │ Stack │ │  Static   │ │   Heap    │ │  Growth → │  │
│  │ (固定)│ │  (全局量) │ │ (allocator)│ │ (可扩展)  │  │
│  └──────┘ └──────────┘ └───────────┘ └───────────┘  │
│  0                                          max 4GB  │
└──────────────────────────────────────────────────────┘
```

**核心约束：**

- 初始大小 + 按 64KB page 增长，**只能增不能缩**
- 单个 Memory 上限 4GB（32-bit Wasm），Memory64 提案可达更大
- `memory.grow()` 会导致 JS 侧 `ArrayBuffer` **失效重建**，所有 TypedArray 视图必须重新获取

### 4.2 视频编辑器内存压力分析

一个 1080p@30fps 的编辑项目，典型内存占用：

| 数据类型 | 单帧/单项大小 | 并发数量 | 峰值 |
|----------|-------------|---------|------|
| 解码帧 RGBA | 1920×1080×4 = **8MB** | 缓存 30 帧 | **240MB** |
| 缩略图条带 | 160×90×4 = 56KB/帧 | 1000 帧 | **56MB** |
| 音频 PCM | 48000×2×4 = 375KB/s | 30s 缓冲 | **11MB** |
| 合成中间帧 | 8MB | 2-3 层叠加 | **24MB** |
| FFmpeg 内部缓冲 | 可变 | — | **50-100MB** |

**总计峰值：400-500MB**，必须精细管理。

### 4.3 分区内存架构（Arena Allocator）

不用通用 `malloc/free`，按用途划分 Arena：

```
Wasm Linear Memory
├── Arena 0: Persistent (项目数据、查找表)      [固定，不释放]
├── Arena 1: Frame Pool (解码帧环形缓冲)        [预分配，复用]
├── Arena 2: Composite Buffer (合成临时帧)      [每帧重置]
├── Arena 3: Thumbnail Cache (缩略图)           [LRU 淘汰]
├── Arena 4: Audio Ring Buffer                 [环形覆写]
├── Arena 5: Encoder Output Buffer             [流式刷出]
└── Free Region → memory.grow() 扩展方向
```

Rust 侧实现思路：

```rust
struct Arena {
    base: *mut u8,
    capacity: usize,
    offset: usize,
}

impl Arena {
    // 线性分配，O(1)
    fn alloc(&mut self, size: usize, align: usize) -> *mut u8 {
        let aligned = (self.offset + align - 1) & !(align - 1);
        if aligned + size > self.capacity {
            return null_mut(); // 触发扩容或淘汰策略
        }
        let ptr = unsafe { self.base.add(aligned) };
        self.offset = aligned + size;
        ptr
    }

    // 整个 Arena 一次性重置，零成本
    fn reset(&mut self) {
        self.offset = 0;
    }
}
```

**为什么用 Arena 而不是通用堆分配器：**

- 视频帧大小固定（8MB/帧），碎片化是致命问题
- Arena reset 是 O(1)，不需要逐帧 free
- 合成缓冲区每帧都整体重写，reset 后直接复用

### 4.4 帧缓存池（Frame Pool）

解码帧是最大的内存消耗者，用**预分配环形池**管理：

```
Frame Pool (Ring Buffer of Fixed-Size Slots)
┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐
│ F0  │ F1  │ F2  │ F3  │ F4  │ F5  │ F6  │ F7  │  每槽 8MB
│ pts │ pts │ pts │ pts │ pts │ pts │ pts │ pts  │
│ =2  │ =3  │ =4  │ =5  │FREE │FREE │ =0  │ =1  │
└─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┘
  ↑ write_head                          ↑ read_head
```

```rust
struct FramePool {
    slots: Vec<FrameSlot>,
    slot_size: usize,       // 每槽字节数 (1920*1080*4)
    base_ptr: *mut u8,
}

struct FrameSlot {
    state: SlotState,       // Free | Decoding | Ready | Locked
    pts: f64,
    ref_count: u32,
    asset_id: u32,
}

enum EvictionPolicy {
    LRU,
    DistanceFromPlayhead,   // 离当前播放头最远的先淘汰
    PriorityBased,          // 当前轨道的帧优先保留
}
```

**淘汰策略 — Distance-from-Playhead：**

```
播放头在 t=10s：
  帧 t=9.8  → 距离 0.2  → 保留（可能回退）
  帧 t=10.3 → 距离 0.3  → 保留（即将播放）
  帧 t=3.0  → 距离 7.0  → 优先淘汰
  帧 t=25.0 → 距离 15.0 → 最先淘汰
```

### 4.5 JS ↔ Wasm 零拷贝通信

**方案一：SharedArrayBuffer（多线程）**

```
Main Thread                    Worker (Wasm Core)
    │   SharedArrayBuffer           │
    │  ┌─────────────────────┐      │
    │  │ Ring Buffer          │      │
    │  │ ┌───┬───┬───┬───┐  │      │
    │  │ │ F0│ F1│ F2│ F3│  │      │
    │  │ └───┴───┴───┴───┘  │      │
    │  │ write_idx (Atomics) │      │
    │  │ read_idx  (Atomics) │      │
    │  └─────────────────────┘      │
    │◄─── Atomics.notify() ────────│  Worker 写完一帧后通知
    │──── Atomics.wait()  ─────────►│  Main 消费完后通知可覆写
```

```javascript
// JS 侧：从共享内存读取帧，零拷贝创建 VideoFrame
const sharedMem = new SharedArrayBuffer(FRAME_SIZE * POOL_COUNT + HEADER_SIZE);
const header = new Int32Array(sharedMem, 0, 4);
const frameData = new Uint8Array(sharedMem, HEADER_SIZE);

function consumeFrame() {
    const readIdx = Atomics.load(header, 1);
    const writeIdx = Atomics.load(header, 0);
    if (readIdx === writeIdx) return null;

    const slot = readIdx % POOL_COUNT;
    const offset = slot * FRAME_SIZE;
    const frame = new VideoFrame(
        frameData.subarray(offset, offset + FRAME_SIZE),
        { format: 'RGBA', codedWidth: 1920, codedHeight: 1080, timestamp: 0 }
    );

    Atomics.store(header, 1, readIdx + 1);
    Atomics.notify(header, 1);
    return frame;
}
```

**方案二：无 SharedArrayBuffer 的降级方案**

Safari 等环境可能不支持 SAB，用 `Transferable` 对象转移所有权：

```
Worker (Wasm)                    Main Thread
    │── postMessage(transfer: [ab])──►│   零拷贝所有权转移
    │◄── postMessage(transfer: [ab])──│   用完还回来
```

### 4.6 内存增长与收缩策略

Wasm Memory 只能 grow 不能 shrink，需要**逻辑收缩**：

```
物理内存: ████████████████████████████████  (已 grow 到 512MB)
逻辑使用: ████████░░░░░░░░░░░░░░░░░░░░░░  (实际只用 200MB)
                  ↑
          空闲区域无法还给 OS，但可以逻辑复用
```

**Watermark 机制：**

```rust
struct MemoryManager {
    total_grown: usize,
    high_watermark: usize,
    current_usage: usize,
    budgets: BudgetConfig,
}

struct BudgetConfig {
    frame_pool: usize,        // 帧缓存上限 (例: 240MB)
    thumbnail_cache: usize,   // 缩略图上限 (例: 60MB)
    audio_buffer: usize,      // 音频缓冲上限 (例: 20MB)
    encoder_buffer: usize,    // 编码缓冲上限 (例: 50MB)
    general_heap: usize,      // 通用堆上限 (例: 50MB)
}
```

**极端情况处理：**

- **方案 A：重建 Wasm 实例** — 序列化引擎状态 → 销毁旧实例 → 创建新实例 → 恢复状态。适合用户切换项目时触发。
- **方案 B：多 Wasm 实例隔离** — 解码器/合成器/编码器各用独立 Memory，互不影响。

### 4.7 多实例内存隔离架构

```
┌─────────────────────────────────────────────────────┐
│  Main Thread                                        │
│  UI · Timeline · 调度器                              │
│  SharedArrayBuffer (控制信号 + 帧数据)               │
├──────────┬──────────┬──────────┬────────────────────┤
│ Worker 1 │ Worker 2 │ Worker 3 │ Worker 4           │
│ Decoder  │ Decoder  │Compositor│ Encoder            │
│ Wasm A   │ Wasm A'  │ Wasm B   │ Wasm C             │
│ Mem 128MB│ Mem 128MB│ Mem 64MB │ Mem 100MB           │
└──────────┴──────────┴──────────┴────────────────────┘
       ↓ decoded frames    ↓ composited frame
       └──→ SAB Ring ──→──┘──→ SAB Ring ──→──┘
```

**好处：**

- 每个 Worker 的 Wasm Memory 独立，互不影响
- Decoder Worker 可以销毁重建而不影响 Compositor
- 天然并行：多轨解码并行、解码与编码流水线化

### 4.8 内存泄漏防御

**引用计数 + 泄漏检测（Rust 侧）：**

```rust
struct TrackedAlloc {
    ptr: *mut u8,
    size: usize,
    arena: ArenaId,
    tag: &'static str,       // "decoded_frame" | "thumbnail" | ...
    allocated_at: u64,
}
```

**JS 侧 FinalizationRegistry 防线：**

```javascript
const registry = new FinalizationRegistry((handle) => {
    wasmEngine.release_handle(handle);
});

class FrameHandle {
    constructor(wasmPtr, size) {
        this._ptr = wasmPtr;
        registry.register(this, wasmPtr);
    }
    dispose() {
        if (this._ptr) {
            wasmEngine.release_frame(this._ptr);
            registry.unregister(this);
            this._ptr = null;
        }
    }
}
```

**使用量报告接口：**

```rust
#[wasm_bindgen]
pub fn memory_report() -> String {
    // 返回 JSON:
    // {
    //   "total_grown_mb": 512,
    //   "current_usage_mb": 340,
    //   "arenas": { ... },
    //   "leak_suspects": []
    // }
}
```

---

## 5. 运行时能力探测与自适应加载

### 5.1 能力探测层（Capability Probe）

启动时在主线程跑一次全量探测，生成设备画像：

```
┌────────────────────────────────────────────────┐
│              Capability Probe                  │
├────────┬────────┬─────────┬─────────┬─────────┤
│  CPU   │  GPU   │ Memory  │ Browser │ Network │
│ Probe  │ Probe  │ Probe   │ Feature │ Probe   │
└────────┴────────┴─────────┴─────────┴─────────┘
                       ↓
              DeviceProfile JSON
                       ↓
           Strategy Resolver → Tier
```

**CPU 探测：**

```javascript
async function probeCPU() {
  const cores = navigator.hardwareConcurrency || 2;
  // 微基准跑分
  const start = performance.now();
  let sum = 0;
  for (let i = 0; i < 5_000_000; i++) sum += Math.sqrt(i);
  const singleCoreScore = (performance.now() - start) / 5;

  return {
    logicalCores: cores,
    singleCoreScore,  // 越小越快，通常 0.5-3ms
    estimatedTier: cores >= 8 && singleCoreScore < 1.0 ? 'high'
                 : cores >= 4 ? 'mid' : 'low'
  };
}
```

**GPU 探测：**

```javascript
function probeGPU() {
  const result = { webgpu: false, webgl2: false, renderer: '', tier: 'none' };

  // WebGPU
  if (navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) {
      result.webgpu = true;
      const info = await adapter.requestAdapterInfo();
      result.gpuVendor = info.vendor;
      result.maxBufferSize = adapter.limits.maxBufferSize;
    }
  }

  // WebGL2 回退
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl2');
  if (gl) {
    result.webgl2 = true;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) result.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    result.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  }

  result.tier = result.webgpu ? 'high'
              : result.renderer.includes('SwiftShader') ? 'low'
              : result.webgl2 ? 'mid' : 'low';
  return result;
}
```

**内存探测：**

```javascript
function probeMemory() {
  const deviceGB = navigator.deviceMemory || 2;
  // 实测可用内存：尝试分配 ArrayBuffer 探测上限
  let maxMB = 0;
  const buffers = [];
  try {
    while (maxMB < 2048) {
      buffers.push(new ArrayBuffer(64 * 1024 * 1024));
      maxMB += 64;
    }
  } catch (e) {}
  buffers.length = 0;

  return {
    deviceMemoryGB: deviceGB,
    allocatableEstimateMB: maxMB,
    wasmMemoryBudgetMB: Math.min(maxMB * 0.6, 1024),
  };
}
```

**浏览器特性探测：**

```javascript
function probeFeatures() {
  return {
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: self.crossOriginIsolated === true,
    webCodecs: typeof VideoDecoder !== 'undefined',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    audioWorklet: typeof AudioWorkletNode !== 'undefined',
    wasmThreads: /* SAB + Atomics + Wasm atomic 指令验证 */,
    wasmSIMD: /* Wasm SIMD 指令验证 */,
    webgpu: !!navigator.gpu,
    opfs: !!navigator.storage?.getDirectory,
  };
}
```

### 5.2 设备画像与档位决策

所有探测结果汇聚成 `DeviceProfile`：

```jsonc
{
  "cpu": { "logicalCores": 12, "singleCoreScore": 0.7, "tier": "high" },
  "gpu": { "webgpu": true, "webgl2": true, "renderer": "RTX 4090", "tier": "high" },
  "memory": { "deviceGB": 16, "allocatableMB": 1800, "budgetMB": 1024 },
  "features": {
    "sharedArrayBuffer": true,
    "crossOriginIsolated": true,
    "webCodecs": true,
    "wasmThreads": true,
    "wasmSIMD": true,
    "offscreenCanvas": true,
    "audioWorklet": true,
    "webgpu": true,
    "opfs": true
  },
  "network": { "downlinkMbps": 50, "rtt": 20, "saveData": false }
}
```

**综合评分决策：**

```javascript
function resolveRuntimeTier(profile) {
  const { cpu, gpu, memory, features } = profile;
  if (!features.offscreenCanvas) return 'minimal';
  if (memory.budgetMB < 256) return 'low';

  let score = 0;
  score += cpu.logicalCores >= 8 ? 3 : cpu.logicalCores >= 4 ? 2 : 1;
  score += gpu.tier === 'high'   ? 3 : gpu.tier === 'mid'    ? 2 : 1;
  score += memory.budgetMB >= 768 ? 3 : memory.budgetMB >= 384 ? 2 : 1;
  score += features.wasmThreads  ? 2 : 0;
  score += features.wasmSIMD     ? 1 : 0;
  score += features.webCodecs    ? 1 : 0;

  if (score >= 11) return 'high';
  if (score >= 7)  return 'mid';
  return 'low';
}
```

### 5.3 档位对应的运行策略

| | HIGH | MID | LOW |
|--|------|-----|-----|
| 线程模型 | 多 Worker（解码×N + 合成 + 编码） | 2 Worker（解码+合成共用 1 个） | 单线程（全部在主 Worker） |
| Wasm 构建 | wasm-mt-simd（多线程+SIMD） | wasm-mt（多线程） | wasm-st（单线程） |
| 渲染管线 | WebGPU Compute Shader | WebGL2 Fragment Shader | Canvas2D CPU 合成 |
| 解码器 | WebCodecs 硬解 | WebCodecs 硬解 | Wasm FFmpeg 软解 |
| 帧缓存池 | 30 帧（240MB） | 15 帧（120MB） | 5 帧（40MB） |
| 预览分辨率 | 原始分辨率 | 720p | 480p |
| 音频 | AudioWorklet + SAB | AudioWorklet + postMessage | ScriptProcessor |
| 缩略图生成 | 并行 4 Worker | 并行 2 Worker | 逐个生成 |
| 导出 | 独立 Worker + 硬件编码 | 共享 Worker + 软件编码 | 阻塞式（显示进度条） |

### 5.4 条件化 Wasm 包加载

**构建时产出多个变体：**

```
dist/
├── engine-mt-simd.wasm     # 多线程 + SIMD      (~3.2MB)
├── engine-mt.wasm          # 多线程，无 SIMD     (~2.8MB)
├── engine-st.wasm          # 单线程             (~2.0MB)
├── codecs-h264.wasm        # 按需加载的编解码器
├── codecs-h265.wasm
├── codecs-av1.wasm
├── effects-blur.wasm       # 按需加载的特效模块
└── effects-color.wasm
```

**加载器核心逻辑：**

```javascript
class WasmLoader {
  resolveEngineVariant() {
    const { wasmThreads, wasmSIMD } = this.profile.features;
    if (wasmThreads && wasmSIMD) return 'mt-simd';
    if (wasmThreads)             return 'mt';
    return 'st';
  }

  // 编解码器：按需加载
  async loadCodec(codecName) {
    // 先检查 WebCodecs 是否原生支持该格式
    if (this.profile.features.webCodecs) {
      const supported = await VideoDecoder.isConfigSupported({ codec: ..., codedWidth: 1920, codedHeight: 1080 });
      if (supported.supported) return { type: 'native' };  // 不需要加载 Wasm
    }
    // 原生不支持，回退到 Wasm 软解码器
    return WebAssembly.instantiateStreaming(fetch(`codecs-${codecName}.wasm`), imports);
  }
}
```

**Service Worker 缓存策略：**

Wasm 文件带 content-hash，长期缓存。首次加载后编译结果存入 Cache Storage，二次打开跳过编译。

### 5.5 运行时动态降级

启动时的探测是静态的，运行中还需要动态监控：

```javascript
class AdaptiveController {
  onFrameRendered(metrics) {
    this.fpsHistory.push(metrics.fps);
    const dropRate = this.fpsHistory.filter(f => f < 24).length / this.fpsHistory.length;

    // 掉帧率 > 20%，触发降级
    if (dropRate > 0.2) this.downgrade();
    // 连续 5 秒满帧且不在最高档，尝试升级
    if (avgFps >= 29 && this.tier !== 'high') this.tryUpgrade();
  }

  downgrade() {
    // 按优先级逐级降级：
    // 1. 降预览分辨率
    // 2. 砍帧缓存
    // 3. 预览时关特效
    // 4. 回退单线程
  }
}
```

### 5.6 完整启动流程

```
页面加载
  │
  ├─ 1. 并行探测（CPU / GPU / Memory / Features）
  │
  ├─ 2. 生成 DeviceProfile + 决定 Tier
  │
  ├─ 3. 根据 Tier 决定加载清单
  │     engine-{variant}.wasm (必须)
  │     codecs-h264.wasm      (预加载)
  │     其他                   (懒加载)
  │
  ├─ 4. instantiateStreaming 加载核心引擎（同时渲染 UI Shell）
  │
  ├─ 5. 引擎就绪 → 初始化 Worker 池 + 渲染管线
  │
  ├─ 6. 加载项目 JSON → probe 素材 → 按需拉编解码器
  │
  └─ 7. 就绪，启动 AdaptiveController 动态监控
```

| 探测维度 | 影响什么 | 怎么探测 |
|----------|---------|---------|
| CPU 核心数 + 跑分 | Worker 数量、是否多线程 Wasm | `hardwareConcurrency` + 微基准 |
| GPU 型号 + API 支持 | 渲染管线选择 | `WebGPU adapter` → `WebGL2 renderer` → 降级 |
| 可用内存 | 帧缓存池大小、预览分辨率 | `deviceMemory` + 实际分配试探 |
| SAB + Atomics | 是否启用 Wasm 多线程 | `crossOriginIsolated` + Wasm validate |
| SIMD | 加载哪个 Wasm 变体 | Wasm validate SIMD 指令 |
| WebCodecs | 解码走硬件还是 Wasm 软解 | `VideoDecoder.isConfigSupported()` |
| 网络带宽 | 预加载策略、远程素材码率 | `navigator.connection` |
| 运行时帧率 | 动态降级/升级 | 持续监控 FPS + 掉帧率 |

---

## 6. Wasm → Canvas 渲染与交互

### 6.1 三条渲染路径

```
用户交互 (鼠标/键盘/触摸)
    │
    ▼
JS 事件层 (坐标变换、命中测试)
    │
    ▼
Wasm Core (状态更新 → 帧合成)
    │
    ▼
帧数据输出 (三条路径)
    ├─ A: Wasm 写入线性内存 → JS 读取 → Canvas2D 绘制
    ├─ B: Wasm 解码 → JS 上传纹理 → WebGL2 GPU 合成
    └─ C: WebCodecs 硬解 → VideoFrame → Canvas 零拷贝
```

### 6.2 路径 A：CPU 合成 → Canvas2D

Wasm 在线性内存中合成 RGBA 像素，JS 侧取出贴到 Canvas：

```rust
// Rust (Wasm Core)
#[wasm_bindgen]
pub fn get_frame_ptr() -> *const u8 { ... }
#[wasm_bindgen]
pub fn render_frame(time_sec: f64) { ... }
```

```javascript
// JS 侧
const imageData = new ImageData(1920, 1080);

function renderLoop() {
  wasm.render_frame(currentTime);
  const pixels = new Uint8ClampedArray(wasm.memory.buffer, wasm.get_frame_ptr(), len);
  imageData.data.set(pixels);      // 每帧拷贝 8MB
  ctx.putImageData(imageData, 0, 0);
  requestAnimationFrame(renderLoop);
}
```

**瓶颈：** `imageData.data.set(pixels)` 每帧拷贝 8MB（1080p RGBA），约耗时 2-4ms。
**适用：** 低端设备、不支持 WebGL 的环境。

### 6.3 路径 B：Wasm + WebGL2

Wasm 解码出帧数据，作为纹理上传到 GPU，合成/特效全部在 GPU 完成：

```javascript
class WebGLRenderer {
  constructor(canvas) {
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      desynchronized: true,        // 脱离 DOM 渲染流水线，减少延迟
      powerPreference: 'high-performance'
    });
  }

  uploadTrackFrame(trackIndex, wasmMemory, ptr, width, height) {
    const gl = this.gl;
    const pixels = new Uint8Array(wasmMemory.buffer, ptr, width * height * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTextures[trackIndex]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height,
                     gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  }

  compositeFrame(tracks) {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // 从下到上逐层绘制，用 blending 叠加
    for (const track of tracks) {
      gl.bindTexture(gl.TEXTURE_2D, this.layerTextures[track.index]);
      gl.uniformMatrix3fv(this.u_transform, false, track.transformMatrix);
      gl.uniform1f(this.u_opacity, track.opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
}
```

**PBO 双缓冲优化：** 用 Pixel Buffer Object 异步上传，避免 CPU 等待 GPU。

### 6.4 路径 C：WebCodecs + VideoFrame

解码完全走浏览器硬件，输出 `VideoFrame` 对象，零拷贝上屏：

```javascript
class WebCodecsRenderer {
  onFrameDecoded(frame) {
    // VideoFrame 在 GPU 内存中，drawImage 直接 blit
    this.ctx.drawImage(frame, 0, 0);
    frame.close();  // 必须手动释放

    // 或 WebGL 路径：VideoFrame 作为纹理源（GPU→GPU 零拷贝）
    // gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  }
}
```

**三条路径对比：**

| | Canvas2D (路径A) | WebGL2 (路径B) | WebCodecs (路径C) |
|--|--|--|--|
| 合成位置 | Wasm CPU | GPU Shader | GPU Shader |
| 帧传输 | 内存拷贝 8MB/帧 | texSubImage2D | GPU→GPU 零拷贝 |
| 特效 | Wasm CPU | GLSL Shader | GLSL Shader |
| 1080p 帧率 | ~15fps | ~60fps | ~60fps |
| 兼容性 | 所有浏览器 | 95%+ | Chrome/Edge |

### 6.5 交互事件处理

**坐标系统（四层转换）：**

```
屏幕坐标 (clientX/Y)
    │  ← canvas.getBoundingClientRect()
    ▼
Canvas 坐标 (canvas 像素)
    │  ← viewport zoom/pan 变换
    ▼
时间线坐标 (合成画面内的世界坐标)
    │  ← clip.transform 的逆变换
    ▼
Clip 本地坐标 (某个素材内部的坐标)
```

```javascript
screenToWorld(clientX, clientY) {
  const rect = this.canvas.getBoundingClientRect();
  const canvasX = (clientX - rect.left) * (this.canvas.width / rect.width);
  const canvasY = (clientY - rect.top) * (this.canvas.height / rect.height);
  const worldX = (canvasX - this.viewport.panX) / this.viewport.zoom;
  const worldY = (canvasY - this.viewport.panY) / this.viewport.zoom;
  return { x: worldX, y: worldY };
}
```

**命中测试（两种方案）：**

- **JS 侧几何命中测试** — 从上层到下层遍历，逆变换坐标后做 AABB 包围盒测试 + 可选 alpha 采样
- **GPU Color Picking** — 每个 clip 分配唯一颜色 ID，渲染到隐藏 pick buffer，读取点击位置颜色值得到 clip ID

**拖拽变换交互：**

```javascript
onPointerDown(e) → 命中测试 → 记录原始 transform
onPointerMove(e) → 计算 delta → 根据 handle 类型（body/corner/rotation）更新 transform → 立即重渲染
onPointerUp(e)   → 生成 Command 写入历史栈（支持 Undo）
```

**选中态绘制：**

使用**双 Canvas 叠加**：底层 Canvas 渲染 Wasm 视频帧，顶层 overlay Canvas 用 JS 绘制选框、控制手柄、辅助线。手柄大小做视觉恒定处理（除以 zoom * scale）。

### 6.6 Worker 架构下的渲染循环

```
Main Thread                          Worker
┌─────────────┐                  ┌──────────────────┐
│  DOM Canvas  │ transferControl │  OffscreenCanvas  │
│  (事件监听)   │───────────────►│  (Wasm 直接渲染)   │
│              │                 │                    │
│  pointerdown │── postMessage ─►│  hit_test()        │
│              │◄── postMessage ──│  { clipId: 3 }    │
│              │                 │                    │
│  pointermove │── postMessage ─►│  update_transform  │
│              │                 │  render_frame()    │
│              │                 │  ↓ gl.drawArrays   │
└─────────────┘                  └──────────────────┘
```

核心思路：通过 `canvas.transferControlToOffscreen()` 让 Wasm 和 Canvas 在同一个 Worker 线程，避免帧数据跨线程传输。交互事件体积小（几十字节），跨线程代价可忽略。

### 6.7 渲染方案选择决策树

```
启动探测
    │
    ├─ 支持 OffscreenCanvas + WebGL2?
    │   ├─ YES → Worker + OffscreenCanvas + WebGL2     ← 推荐主力方案
    │   │
    │   └─ 支持 WebGPU?
    │       └─ YES → Worker + OffscreenCanvas + WebGPU ← 最高性能
    │
    ├─ 不支持 OffscreenCanvas，支持 WebGL2?
    │   └─ 主线程 WebGL2 渲染，Wasm 解码在 Worker，帧数据 postMessage 传回
    │
    └─ 都不支持?
        └─ 主线程 Canvas2D + Wasm CPU 合成             ← 兜底
```
