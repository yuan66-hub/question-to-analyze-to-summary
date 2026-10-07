// 同源 Worker 入口。
// @ffmpeg/ffmpeg 默认会把其 CDN 模块相邻的 worker.js 作为 Worker 入口，
// 而浏览器会阻止该跨域 Worker。由本文件从同源静态服务器启动后，模块导入仍
// 可通过 unpkg 的 CORS 响应正常加载。
import "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/worker.js";
