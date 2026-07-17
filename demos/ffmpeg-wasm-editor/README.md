# FFmpeg.wasm 客户端剪辑 · 最小可运行 Demo

演示 [`../../5.frontend/ffmpeg-wasm-client-video-editing.md`](../../5.frontend/ffmpeg-wasm-client-video-editing.md) 里的**预览 / 导出双引擎**架构：

- **实时预览引擎**：用两个 `<video>` + `Canvas 2D` 做时间轴合成与 crossfade，拖动进度条 / 播放**不卡**（不经过 FFmpeg）。
- **导出引擎**：点击导出时才调用 **FFmpeg.wasm**，用 `xfade` 转场 + `crop` 裁剪 + `concat`（通过 filter_complex）高质量渲染出 `output.mp4`。
- 预览与导出**共享同一份剪辑参数**（转场类型、时长、裁剪比例），体现"一份数据、两处消费"。

## 功能

| 功能 | 预览引擎 | 导出引擎（FFmpeg.wasm） |
|---|---|---|
| 两段视频拼接 | Canvas 时间轴切换 | filter_complex 归一化后 xfade |
| 转场 | 2D crossfade 近似 | 真实 `xfade`（fade/dissolve/wipe/slide/circle） |
| 裁剪 crop | `drawImage` 源矩形裁剪 | `crop` 滤镜 |
| 音频转场 | —（预览静音） | `acrossfade` |

## 运行方式

浏览器的 ES Module + 跨域内核加载**必须通过 http(s) 打开**，不能直接双击 `index.html`（`file://` 会报 CORS）。

在本目录下起一个静态服务器，任选其一：

```bash
# Python
python -m http.server 8080

# 或 Node
npx serve -l 8080

# 或 pnpm dlx
pnpm dlx serve -l 8080
```

然后浏览器打开 <http://localhost:8080>。

## 使用步骤

1. 选择 **片段 A** 和 **片段 B** 两段视频（建议先用短视频，如各 3~5 秒）。
2. 立即可在右侧预览：播放 / 拖动进度条看 A → 转场 → B 的效果。
3. 调整转场类型、转场时长、裁剪比例，预览实时更新。
4. 点 **① 加载 FFmpeg.wasm 内核**（首次约下载 25MB）。
5. 点 **② 导出成片**，等待渲染完成后在下方播放 / 下载 `output.mp4`。

## 说明与边界（与文档呼应）

- 本 Demo 用**单线程 core**，无需 `SharedArrayBuffer` / COOP-COEP 头，开箱即用；多线程版更快但需配响应头。
- 内核从 `unpkg` CDN 懒加载，**不打进页面**，体现按需加载。
- 预览的 crossfade 是 2D 近似，导出严格按所选 `xfade` 渲染——生产中应让预览 shader 与 xfade 参数一一对应以做到"所见即所得"。
- 长视频 / 高分辨率在 wasm 下可能 OOM 或很慢，属预期行为；生产应对长视频导出回落到后端原生 FFmpeg。
