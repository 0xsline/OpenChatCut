# ChatCut 复刻 · 源码对标 TODO（重新审计版）

> 快照 2026-07-14（合并 GPT generation-suite 之后）。本文取代那份已过时的
> `chatcut-reverse/reports/live-editor-audit-2026-07-14/feature-gap-matrix.md`（旧记 42.8%）。
> 由 5 个并行 agent 逐项对照 **当前 `src/` 真代码** vs **逆向源码规格** 重新核实。
>
> **口径**：✅ 已完成 · 🟡 部分 · ❌ 未做。共 132 项。
> **总覆盖**：约 **69 ✅ / 15 🟡 / 48 ❌**，加权 ≈ **58%**（旧 42.8%）。
> （2026-07-14 更新：域 7 设计风格、域 11 对话历史持久化、域 10 音频/范围导出落地）
> 但只看**产品核心域（编辑器·Agent·媒体·字幕·生成，域 1–11+16，共 104 项）**，
> 加权覆盖 ≈ **73%**（69✅/13🟡/22❌）。拖低总数的是花钱域与协作/账号/多端/遥测等
> "需真后端、单机克隆无对象可服务"的基建域（域 13/14/15 全 0%）。
>
> **开发纪律（本文存在的意义）**：做任何一项前，先读它在"源码依据"列指向的
> `chatcut-reverse/复刻规格-Agent工具与后端.md`（52 工具权威语义）/ `PRD.md` /
> 反编译 bundle，能用原命名/原算法/原数据就用，别凭空发明。

---

## 一、域覆盖总览

| # | 域 | 总 | ✅ | 🟡 | ❌ | 核心度 | 说明 |
|---|---|---:|---:|---:|---:|---|---|
| 1 | 项目 / 会话生命周期 | 6 | 3 | 0 | 3 | 核心 | 缺版本历史、followup 卡 |
| 2 | 编辑器核心 / 时间线 | 19 | 17 | 1 | 1 | 核心 | **几近完备**，缺色度键、gif/svg/solid |
| 3 | 音频处理 | 6 | 4 | 0 | 2 | 核心 | ducking 已做，缺降噪/响度归一 |
| 4 | 转写 / 文字稿 | 10 | 7 | 1 | 2 | 核心 | 缺改错字、说话人重命名 |
| 5 | 字幕 | 8 | 6 | 1 | 1 | 核心 | 21 样式已做，缺逐词覆盖、多源合并 |
| 6 | Motion Graphics | 8 | 6 | 1 | 1 | 核心 | 缺 manage_template、MG→透明视频补 alpha |
| 7 | 设计风格 / 品牌 | 2 | 1 | 1 | 0 | 核心 | ✅ manage_design_style:24 真 catalog 预设+owned 我的风格+自由 role+注入;brand-kit logo 🟡 |
| 8 | AI 生成（花钱域） | 7 | 5 | 1 | 1 | 核心 | 5 生成工具已接，缺 submit_shader、积分门 |
| 9 | 素材 / 媒体 | 12 | 7 | 1 | 4 | 核心 | 媒体池/库/LUT 已做，缺在线素材/URL 资产 |
| 10 | 导出 / 交付 | 12 | 6 | 1 | 5 | 核心 | MP4/字幕/音频/范围已做，缺 XML/异步/水印 |
| 11 | Agent / 对话平台 | 10 | 6 | 4 | 0 | 核心 | ✅ 对话持久化(chat_block);仅剩 thinking UI 等 🟡 |
| 16 | 长转短（专项） | 4 | 1 | 1 | 2 | 核心 | auto-reframe 渲染链就绪缺检测；缺智能切片 |
| 12 | 技能 Skills | 3 | 0 | 0 | 3 | 可搬 | **纯前端可做**，优先级高 |
| 18 | 遥测 / 增长 | 7 | 0 | 2 | 5 | 混合 | 快捷键/i18n/dockview 可做；遥测需 SaaS |
| 17 | 引导 / 场景 | 2 | 0 | 0 | 2 | 混合 | 创作模式=域12，roadmap 需后端 |
| 13 | 协作 / 分享 | 5 | 0 | 0 | 5 | 需后端 | 多人同步/分享/邀请 |
| 14 | 账号 / 计费 / 积分 | 6 | 0 | 0 | 6 | 需后端 | 鉴权/Stripe/门控 |
| 15 | 多端 / MCP / 集成 | 5 | 0 | 0 | 5 | 需后端 | 唯本地 stdio MCP 可做 |

---

## 二、优先级路线（纯前端可做，按价值/成本排序）

### P0 — 补齐产品核心的显眼缺口
1. ✅ **对话历史持久化**（域11）—— 已落地：`persist/projectStore.ts` 加 `loadChat/saveChat/clearChat`(复用 kv store,存 `{messages, llm}`);`useAgent(ctx,projectId)` 挂载 hydrate + 回合边界持久化 + `clearHistory`;ChatPanel 头部「清空对话」。附带修 `migrateProjectDoc` 丢 `designStyle` 的回归。检查 `chat-persist.check.ts` + 浏览器整页刷新实测双双恢复。源：`chat_block`。
2. ✅ **设计风格 `manage_design_style`**（域7）—— 已落地：`ProjectDoc.designStyle{colors[role,value],fonts[family,role],styleGuide}`(对齐源 `Ey/Ay/bM` 规范)+`editor/design-presets.ts`(4 内置预设=源 `/api/design-styles/owned` 类比)+`agent/design-tools.ts`(`manage_design_style` list/get/apply/update/clear，含旧式对象→数组规整)+注入(`systemPrompt.designStylePrompt` 进 agent loop、`designStyleHint` 进 MG 代码生成)+UI(`DesignStylePanel` 弹窗，TopBar 调色板入口，即时预览)。检查 `design-tools.check.ts` 绿。源：`复刻规格 §9 manage_design_style`。
3. ✅ **导出音频 mp3/wav + 帧范围**（域10）—— `/export` 与 `submit_export` 已支持源站 `format+codec` 契约（音频 MP3 + 本地 WAV 扩展）；MP4/WebM/MP3/WAV 共用半开帧范围并转换为 Remotion inclusive `frameRange`。源：`submit_export format=audio`。

### P1 — 高价值增量
4. **创作模式技能预设 = 域12 + 域17 合并做**（纯前端）—— `Record<mode,{systemPrompt,allowedTools,defaultParams}>` + ChatPanel/新建流程下拉；选中拼进 `SYSTEM_PROMPT` 并在 `runtime.ts` 过滤工具。逆向 §17 已存 19 条预设文案可直接取。源：`agent_skill/scenario_preset`。
5. **在线素材搜索 + URL→资产**（域9 ❌，成套）—— `agent/stock-tools.ts`（`search_stock_media` 归一 Pexels/Pixabay）+ `push_asset`/`download_media`（vite fetch→uploads→asset）。用户可见价值高。源：`复刻规格 §6`。
6. **submit_shader 着色器生成**（域8 ❌，护城河②沙箱现成）—— `agent/shader-tools.ts` + LLM codegen GLSL，编译校验走已有 `gl/runtime.ts`，产物喂 `manage_effects`/transitions。内置 6 effect+12 transition 即 few-shot 语料。源：`复刻规格 §8 submit_shader`。
7. **异步渲染 job + `track_export`**（域10 ❌）—— `/export` 改入队复用 `vite-generation-jobs.ts` 返 renderId；新 `track_export`（status/wait）。解锁统一交付路径（XML/音频/水印共用）。源：`submit_export`+`track_export`。
8. **manage_transcript（改错字 + 说话人重命名/合并 + 多语变体）**（域4 ❌/🟡）—— 三个缺口同一工具：`fix`（就地改 `item.transcript[gi].text` 不动帧位）+ `speakerNames/speakerMerge` 映射 + `variants` 数据模型。源：`manage_transcript`。
9. **逐词字幕覆盖 `read_captions`+`edit_captions display_text`**（域5 ❌）—— `CaptionsData.wordOverrides{hidden,text,forceBreak,keepPrev}`；`paginate` 尊重；`CaptionsLayer` 套用。源：`edit_captions display_text`。

### P2 — 锦上添花 / 收尾
10. **auto-reframe 自动检测**（域16 🟡）—— 渲染链（`ReframeCurveV1`→`zoomAt` 裁切窗）已完整，只缺 `reframe/detect.ts`（MediaPipe/TF.js 采样人脸/主体→逐帧 `setReframeKeyframe`）。源：`reframe`（×71 高频）。
11. **智能切片**（域16 ❌）—— `agent/highlight-tool.ts` 喂词级 `transcript` 给 LLM 打分→`duplicateTimeline`+`retargetTimeline('9:16')`+裁段。长转短成片交付口。
12. **MG→透明视频补 alpha + 工具化**（域6 🟡）—— `render.mjs` 加 vp8/webm-alpha 分支保透明；`convert_motion_graphic_to_video`/`register_converted_video` agent 工具。
13. **色度键绿幕**（域2 ❌）—— `gl/fx/chroma-key.frag` + `FX_EFFECTS` 补一格，走现成 `ClipFx` 管线。**成本最低**（fx 注册表补一条）。
14. **dockview 可拖拽面板**（域18 🟡）—— 换 MIT dockview 依赖，三面板入 dock，布局序列化 localStorage。
15. **i18n /zh /en**（域18 ❌）—— 抽字符串成字典 + toggle，逆向 `ui-strings.en.json` 有源站英文串。工作量偏大无需后端。
16. **自定义快捷键**（域18 ❌）—— keymap 存 localStorage + 设置 UI。
17. **skill_guard**（域12 ❌）—— 复用 propose→apply 审批 UI，对高成本工具插确认。
18. **版本历史**（域1 ❌）—— `persist/versionStore.ts` 命名快照 `ProjectDoc`，回滚走现成 `applyDoc`。
19. 其余收尾：字体搜索 `search_fonts`+导出字体门、gif/svg/solid 类型、`edit_captions` template enum 放全 21、字幕多源合并、propSchema 补 select/font/image 控件、`manage_template`、`ask_followup_questions` 卡、免费档水印、导出历史+评分、扩展思考 thinking UI（换真 Claude 后生效）、@引用结构化、agent 设置面板、web_browser、手机上传。

### ⛔ 需真后端 / 第三方 —— 单机克隆 out of scope
> 根因一致：都依赖 auth server（better-auth+Postgres）、Zero/zero-cache 多端同步、Stripe、
> 遥测 SaaS 这些"本地单用户无对象可服务"的基础设施。要做得先起后端。
- 域13 协作：实时同步、分享链接、邀请协作者、webhook/API key（本地批注可单独做）
- 域14 账号/计费：鉴权、组织、Stripe、功能门控、限流（本地积分估价可占位）
- 域15 多端：CLI/桌面授权、公开 API 网关、多宿主安装页、inline embed（**唯本地 stdio MCP server 可做**：包 `executeTool` 供本机 Codex/Claude Desktop）
- 域17：公开 roadmap 投票 ｜ 域18：遥测(Axiom+PostHog)、联盟归因、注册反滥用

---

## 三、各域缺口明细（含源码依据 + 搬运计划）

> 只列 🟡/❌（待办项）。✅ 项见 §一 总览。每项格式：`功能 — 源码依据（源站工具/PRD 位置）→ 搬运计划（clone 文件）`。

### 域 1 · 项目 / 会话生命周期
- ❌ **版本历史（快照/回滚）** — 源 `/api/versions`。→ 新 `src/persist/versionStore.ts`（IDB 存命名 `ProjectDoc` 快照），TopBar/Dashboard 加入口，回滚=现成 `commands.applyDoc`。
- ✅ **ask_followup_questions 交互卡** — 已实现 `<widget>` 内联问答卡:`components/chat/widget-parse.ts`(解析 form-single/multi/visual)+ `WidgetCard.tsx` 渲染 + 提交回填 "- 标签：显示" 续对话 + systemPrompt 教 agent 关键信息不足时发卡。真实语法抓自源站 chat-blocks。(源站 variant=visual 的媒体卡渲染就绪,但需托管媒体故 agent 只发 single/multi。)
- ❌ **get_editor_url / target_project** — 源 `复刻规格:23,66,68`。→ 低优先，等域15 外部 MCP，App 层加 `session.activeProjectId`。

### 域 2 · 编辑器核心 / 时间线
- 🟡 **gif/svg/solid 媒体类型** — 源按类型拆表。→ `types.ts` `kind` 加三种；`TimelineComposition` `ItemLayer` 加渲染分支。
- ❌ **色度键 / 绿幕** — 源 `chroma`（PRD:153）。→ `gl/fx/chroma-key.frag` + `FX_EFFECTS` 补一格，走现成 `ClipFx`/`manage_effects`。**成本最低**。

### 域 3 · 音频处理
- ❌ **AI 降噪 / 人声隔离** — 源 `isolate_voice`（DeepFilterNet3，action apply/attach/clear，strength 0-100）。→ `src/audio/isolate-tools.ts` 注册工具 + `item.isolatedSrc`；纯前端先做 "attach 已传 wav"，apply 走后端占位。
- ❌ **响度归一化 (-14 LUFS)** — 源站无独立工具（唯 duck 深度从响度 auto-init）；标"自定"。→ `audio/loudness.ts` WebAudio 离线分析 LUFS 套增益；MVP 先 per-clip target-gain。

### 域 4 · 转写 / 文字稿
- 🟡 **多语言转写变体** — 源 `manage_transcript translation_ensure/create`（变体挂 source 共享时间轴）。→ `transcript/types.ts` 加 `variants`；字幕改"选变体显示"而非现场翻译。
- ❌ **转写校正（改文本）** — 源 `manage_transcript action fix`（修 ASR 文本不剪音频）。→ 工具加 `fix` 分支 + reduce 就地改 `item.transcript[gi].text`；面板双击改词。
- ❌ **说话人重命名 / 合并** — 源 `manage_transcript fix` + speaker_id skill。→ `TimelineState` 加 `speakerNames/speakerMerge` 映射；`speakerLabel` 读映射。

### 域 5 · 字幕
- 🟡 **字幕源路由（多轨合并）** — 源 `edit_captions source_set/source_add` + sourceScope（first-on-top 堆叠）。→ `CaptionsData.sources: CaptionSource[]` 取代单 sourceItemId；`resolve.ts` 合并多源；默认 `mode:'timeline'` 扫全部含转写音频。
- 🟡 **（子）edit_captions template enum 仅 3/21** — → `transcript-tools.ts` enum 改 `CAPTION_STYLES.map(id)` 全量。
- ❌ **逐词覆盖（隐藏/遮罩/拆/并/改字）** — 源 `edit_captions display_text`（hidden/text/forcePageBreak/keepWithPrevious）+ `read_captions {words:true}`。→ `CaptionsData.wordOverrides`；`paginate` 尊重；新 `read_captions` 工具。

### 域 6 · Motion Graphics
- 🟡 **MG → 透明视频（convert_to_video）** — 现"转为视频"压平 alpha + 无 agent 工具。源 `convert_motion_graphic_to_video`+`register_converted_video`。→ `render.mjs` 加 vp8/webm-alpha；`generate-tools.ts` 加两工具入媒体池。
- 🟡 **（子）propSchema 补 select/font/image 控件** — 现 9 类型里 font/select/image/asset 退化成 text。→ InspectorPanel schema 映射加三种控件。
- ❌ **manage_template（工程模板打包/应用）** — 源 `manage_template`（get/list_assets/apply）。→ `agent/template-tools.ts`，依赖域7 design-style 先落。

### 域 7 · 设计风格 / 品牌
- ✅ **设计风格库 manage_design_style** — 源 `复刻规格 §9` + **活体抓包核对**(`/api/design-styles/owned` + `/public-api/design-styles/catalog`)。已实现 list(catalog+owned)/get/apply/update/clear/**save/delete**;**全搬 24 个真实 catalog 预设**(curl 公开端点 verbatim);**owned「我的风格」本地库**(存/应用/删)。**role 是自由文本**(真值 "accent copper"/"text secondary"/"Chinese heading"——之前照 bundle 的 Ey/Ay 限死枚举会丢真数据,已改 role:string)。规整器对齐 `bM/yM/xM`(旧式对象→数组仍按常用键)。注入 MG/字幕生成(枚举全部自由角色)。
- 🟡 **品牌套件 brand kit** — 源与 design-style 合一;`styleGuide`(真值是详细 spring/stagger 动效规格)已含。**logo/product-images 资产上传** 留待(源 designSpec.logos/images,本地需资产上传链路)。

### 域 8 · AI 生成
- ❌ **着色器生成 submit_shader** — 源 `复刻规格 §8`（Gemini→GLSL/TS，type=effect\|transition）。→ `agent/shader-tools.ts` + `vite-plugin-shader.ts` LLM codegen，编译校验走 `gl/runtime.ts`，产物喂 `manage_effects`/transitions。
- 🟡 **任务队列 + 积分计量** — image/voice/sound 仍同步未入队；积分=0。→ 统一走 `createGenerationJob`；持久化队列；credit 模型 + 服务端扣费门。

### 域 9 · 素材 / 媒体
- ❌ **在线素材搜索 search_stock_media** — 源 `复刻规格 §6`（Pexels/Pixabay 归一）。→ `agent/stock-tools.ts` 统一结果 + import URL。
- ❌ **URL→资产 push_asset/download_media** — 源 `复刻规格 §6`。→ `push_asset` 存 URL 元数据；`download_media` vite fetch→uploads→asset。与 stock 成套。
- ❌ **网页抓取 web_browser** — 源 Firecrawl（key 在 `~/.claude/secrets/search-apis.env`）。→ `agent/web-tools.ts`。锦上添花。
- ❌ **手机上传 /m/:token** — 源 phone-upload。→ 一次性 token + 二维码。低优先。
- 🟡 **字体搜索 search_fonts** — 现静态 4 字体。源 `复刻规格 §6`。→ `agent/font-tools.ts` 查 Google Fonts + 导出前 `confirmFontFallback` 门 + 按需 loadFont。

### 域 10 · 导出 / 交付
- ❌ **异步渲染 job + track_export** — 现同步流式。→ `/export` 入队复用 `vite-generation-jobs.ts` 返 renderId + `track_export`（status/wait）。
- ❌ **导出 XML（fcpxml）** — 源 `submit_export format=xml`（fcp_xml/resolve）。→ `src/export/fcpxml.ts`，MG 引用已渲 ProRes。
- ✅ **导出音频 mp3/wav** — `renderTimeline` 透传 `codec=mp3|wav`；`submit_export format=audio` 同步下载并返回 codec/文件名/字节数。
- ❌ **免费档水印** — 源 `updateWatermark`。→ `TimelineComposition` 加 plan 门控水印层。
- ❌ **导出历史 + 评分** — 源 `export_history`。→ 成功后写 IDB + 弹评分。
- ❌ **浏览器端 WebCodecs 快导** — 低优（服务端已覆盖）。
- ✅ **部分导出（帧范围）** — MP4/MP3/WAV/字幕均支持 `[startFrame,endFrameExclusive)`；媒体出口统一转为 Remotion inclusive `frameRange`。
- 🟡 **字体兜底确认 confirmFontFallback** — → 渲染前扫 fontFamily 对白名单，缺 confirm 返清单。

### 域 11 · Agent / 对话平台
- ✅ **对话历史持久化** — 源 `chat_block`。已按工程存 IDB(`loadChat/saveChat/clearChat`)+ 挂载恢复 + 清空。
- ❌ **扩展思考 thinking block UI** — 源 thinking block。→ `client.ts` 传 `thinking`，`runtime.ts` `on('thinking')`，`ChatMessage` 折叠块。（换真 Claude 后生效，grok 无 thinking 通道）
- 🟡 **多轮会话持久化（reset/max_turns）** — → 配 IDB 持久化 + reset。
- 🟡 **@引用素材（结构化）** — 现只插 `@name` 纯文本。源 `chat_context_entry`。→ `insertRef` 带 `{id,kind}` 结构化条目上送。
- 🟡 **Agent 设置（模型/速度/思考/MG 质量）** — 现只有自动应用+代理/问答。→ 扩设置 popover。
- 🟡 **Bash/Edit/Read/Write 宿主变体** — no-workspace 内联已做；SDK 沙箱宿主 v2。

### 域 16 · 长转短
- 🟡 **自动重构图 auto-reframe** — 渲染链就绪（`zoom.ts reframeAt`），缺检测。源 `reframe`（×71）。→ `src/reframe/detect.ts` MediaPipe/TF.js→逐帧 `setReframeKeyframe`。
- ❌ **智能切片（找高光→多条短视频）** — → `agent/highlight-tool.ts` LLM 读词级 transcript 打分→`duplicateTimeline`+`retargetTimeline('9:16')`+裁段。**长转短成片口，最高价值**。
- ❌ **垂直安全区** — → `PreviewPanel` 加 9:16 安全框 overlay。纯 CSS。

### 域 12 · 技能 Skills（纯前端，优先做）
- ❌ **内置技能预设（6 创作模式）** — 源 `agent_skill/scenario_preset`。→ 见 §二 P1-4（与域17 合并）。
- ❌ **自定义技能 manage_skill** — → 技能对象存 IDB，CRUD 走现成 store 模式。
- ❌ **skill_guard** — → 复用 propose→apply 审批 UI 插确认弹窗。

### 域 17 · 引导 / 场景
- ❌ **6 创作模式场景（prompt+guidance）** — 与域12 内置技能预设**同一实现**。逆向存 19 预设。
- ❌ **公开路线图（投票）** — 需后端。本地至多只读静态清单。

### 域 18 · 遥测 / 增长
- 🟡 **反馈组件** — UI 壳已在（`Timeline.tsx` bug 按钮+popover）；缺上报/评分管道（本地落 console/下载可做）。
- 🟡 **dockview 可拖拽布局** — 现固定分隔条。→ 换 MIT dockview，布局序列化 localStorage。
- ❌ **自定义快捷键** — → keymap 存 localStorage + 设置 UI。纯前端。
- ❌ **i18n (/zh /en)** — → 抽字典 + toggle，逆向 `ui-strings.en.json` 有英文串。纯前端。
- ❌ 遥测(Axiom+PostHog) / 联盟归因 / 注册反滥用 — **需真后端/SaaS，out of scope**（本地可放 no-op logger 占位）。

### 域 13 / 14 / 15 · 协作 / 账号计费 / 多端 —— 见 §二 ⛔ 需真后端
唯二本地可做：**域13 单用户本地批注**（挂 clip/时间点存 ProjectDoc，复用 markers）、**域15 本地 stdio MCP server**（包 `executeTool` 无 OAuth 供本机 Codex/Claude Desktop）。其余全部依赖 auth/Stripe/多端同步/托管，单机克隆无对象可服务。
</content>
