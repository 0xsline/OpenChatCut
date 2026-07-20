# Product assets (内置静态资源)

产品自带、随版本发布的静态文件。**不是**用户上传或 AI 生成的工程素材。

| 目录 / 文件 | URL 前缀 | 用途 |
|---|---|---|
| `fonts/` | `/fonts/` | 内置 CJK / 展示字体 woff2 |
| `thumbnails/` | `/thumbnails/` | MG 模板库缩略图 |
| `voice-samples/` | `/voice-samples/` | TTS 试听 |
| `sound-effects/` | `/sound-effects/` | 音效库 |
| `audio/` | `/audio/` | 内置音频轨样例 |
| `media/` | `/media/` | 产品样例媒体（如 speech-sample；**不含** uploads） |
| `luts/` | `/luts/` | .cube LUT |
| `library-previews/` | `/library-previews/` | 资源库预览图 |
| `plugins/` | `/plugins/` | 内置插件索引/示例 |
| `templates/` | `/templates/` | MG / 口播模板 JSON（源码编译期 import） |
| `vendor-icons/` | `/vendor-icons/` | 设置页使用的厂商 SVG（源码编译期 import） |
| `favicon.svg` / `icons.svg` | `/` | 站点图标 |

## 与 `public/` 的分工

- **`assets/`**（本目录）→ 产品内置，进 git。
- **`public/media/uploads/`** → 仅用户上传 / AI 生成 / 导出中间产物；默认 gitignore。

开发与构建由 `server/product-assets.ts`（Vite 插件）把本目录挂到站点根路径；Remotion 导出同样 overlay 本目录。URL 与迁出 `public/` 之前保持一致。
