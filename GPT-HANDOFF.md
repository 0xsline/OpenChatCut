# GPT 交接文档 —— AI 生成套件 + 导出增强

> 分工日期 2026-07-14。Claude 认领共享脊柱 + manage_timelines 工具 + 复杂 GLSL 转场 + 着色器/沙箱 + 护城河③；**你（GPT）主攻本文档列的活**。看板（含 owner 色标）：`feature-coverage.html` / 已发布 Artifact。

---

## 0. 一句话
你只写**新文件**（+ 一个已经给你留好的注册文件 `src/agent/generate-tools.ts`）。**不要碰共享脊柱**。接线口子已就绪：在 `generate-tools.ts` 里加工具 = 自动进模型、自动路由、自动进系统提示。

## 1. 你的任务（用源站真名，先 recon 再写）
| 工具 | 源站真名 | 后端候选 | 逆向依据 |
|---|---|---|---|
| AI 图片生成 | `submit_image` | gpt-image / nano-banana / 开源 FLUX.1 | `复刻规格-Agent工具与后端.md` + `harness/mcp-tools-schema.md` |
| AI 视频生成 | `submit_video` | Seedance2 / Kling / 开源 Wan2.1（文/图生视） | 同上 |
| AI 配音 TTS | `submit_voice` | Doubao BigTTS + ElevenLabs（逆向有 35 试听样本，先试听选音） | 同上 |
| AI 音乐生成 | `submit_music` | Mureka / Suno / 开源 MusicGen | 同上 |
| AI 音效生成 | `submit_sound` | ElevenLabs SFX（先查库再生成） | 同上 |
| 导出字幕文件 | `format=subtitles` | SubRip/txt 序列化（纯前端，无外部 API） | 同上，caption cues → srt/txt |

**SPEC 硬规则（全项目通用，见 `CLAUDE.md`）**：动手前先去 `~/Desktop/project/chatcut-reverse/` 找源站——`复刻规格-Agent工具与后端.md`（52 工具权威语义，取真名真参数）、`harness/mcp-tools-schema.md`（精确 input_schema）。**能用原名/原参数枚举就用，别自造。** 找不到依据就在提交说明注明「源站无据，自定」。

## 2. 接线口子（已给你留好，你只改左边）
| 你改 | 自动生效到（**别碰**） |
|---|---|
| `src/agent/generate-tools.ts` 里 `GENERATE_TOOL_SCHEMAS` push 一个 schema | 自动汇入 `TOOL_SCHEMAS`（模型可见） |
| 同文件 `execGenerateTool` 加一个 `case` | `executeTool` 自动路由到它 |
| 同文件 `GENERATE_WORKFLOW` 填说明段 | 自动拼进 `SYSTEM_PROMPT` |
| 新建 `vite-plugin-<x>.ts`（服务端代理，注入 key） | 在 `vite.config.ts` 注册（**唯一需小改的脊柱文件——只 append 一行 plugin，若冲突找 Claude**） |
| 新建 `src/generate/<x>.ts`（库模块）、`GeneratePanel.tsx`（面板） | 面板挂到 LibraryPanel 的「生成」Tab 由 **Claude 合并时接线**，你别改 `LibraryPanel.tsx` |

**产物落时间线**：生成完拿到同源 URL → 造 `MediaAsset{id,name,kind:'video'|'image'|'audio',src,durationInFrames,width?,height?}` → `ctx.commands.addMediaItem(asset)`（落轨）或 `ctx.commands.addAsset(asset)`（进素材池）。`ctx` = `{commands,getState,templates,audio}`，够用，**不用改 `context.ts`**。

## 3. Key 与代理（安全关键，照抄现成模式）
- Key 一律进 **gitignored `.env.local`**（`.env*` 已在 `.gitignore`），**永不进浏览器、永不硬编码、永不提交**。
- 外部 AI API 走**服务端代理**注入 key：抄 `vite-plugin-upload.ts`（写文件到 `public/media/uploads/`）和 `vite.config.ts` 里 `/llm`、`/assemblyai` 的 proxy（`proxyReq` 注入 auth header + 强制响应 `content-type`）。
- 生成的媒体要**服务端下载落到 `public/media/uploads/`** 再返回同源路径（预览和导出都同源才能读；抄 `/upload` 流程 + `src/media/upload.ts` 探时长/尺寸）。别让浏览器直连第三方拿字节。

## 4. 编码约束（`CLAUDE.md` 硬约束，会被审）
- **单文件 ≤ 500 行**（逼近 400 就拆）；函数 < 50 行；嵌套 < 4 层。
- **不可变**：返回新对象，不原地改。
- **边界校验**：API 响应/LLM 输出/用户输入都不可信，先校验再用（可用 zod）。
- 错误显式处理，给 UI 友好信息；**无 `console.log` 入库**；无硬编码魔数。
- 非平凡逻辑留一个可跑的自检（抄 `transcript/edit.ts` 旁的 `*.check.ts` / esbuild→node 跑法，项目无 vitest）。

## 5. 验证 playbook
- **agent 工具**：起 dev（`npm run dev -- --port 5199 --strictPort`），在左侧 AI 聊天里让 agent 调你的工具端到端验证（不必先有面板）。落轨的看预览；要进导出的，构造 state `POST /export`（`curl --noproxy '*'`）→ ffmpeg 抽帧。
- **导出 bundle 每进程缓存**：只有改了**合成/模板代码**才需重启 dev（你基本不碰合成，忽略即可）。
- `npx tsc --noEmit` 必须过（`noUnusedLocals`/`noUnusedParameters` 都开着）。

## 6. 分支 / 合并协议
- 你在分支 **`gpt/generation-suite`** 上开发（已建，从当前 main 拉出，已含接线口子）。建议用独立 worktree 或副本，避免和 Claude 抢工作目录 / 5199 端口。
- 小步提交（`feat: submit_image ...`）。**Claude 负责 merge 回 main 并解决共享文件冲突。**
- **红线**：若你发现必须改脊柱文件（`editor/types.ts`·`reduce.ts`·`store.ts`·`TimelineComposition.tsx`·`Editor.tsx`·`agent/tools.ts`·`agent/context.ts`·`components/LibraryPanel.tsx`），**停手，在提交说明或 issue 里写明你需要的改动，交给 Claude 做**——别自己改，否则合并必冲突。
- `.env.local`、`.claude/worktrees/`、`node_modules`、`public/media/uploads/*` 别提交。

## 7. 起步顺序建议
1. 先做 `submit_image`（最简单：文生图 → 落一张 image item），把「recon→代理→落轨→agent 实测」整条链路跑通，作为其余四个的模板。
2. 再 `submit_voice`（TTS，可复用音频轨/文字稿链路）→ `submit_sound` → `submit_music` → `submit_video`（最重，异步任务轮询）。
3. 最后 `format=subtitles`（纯前端序列化，最轻）。
