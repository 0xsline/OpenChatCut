# ChatCut 复刻 · 源码对标 TODO（重新审计版）

> 快照 2026-07-14（合并 GPT generation-suite 之后）。本文取代那份已过时的
> `chatcut-reverse/reports/live-editor-audit-2026-07-14/feature-gap-matrix.md`（旧记 42.8%）。
> 由 5 个并行 agent 逐项对照 **当前 `src/` 真代码** vs **逆向源码规格** 重新核实。
>
> **口径**：✅ 已完成 · 🟡 部分/桩 · ❌ 未做。共约 132 项。
> **2026-07-15 三 agent 逐域重审「真代码」**（非照旧表抄，注册≠实现，桩记 🟡）。
> 总覆盖 ≈ **88 ✅ / 12 🟡 / 33 ❌**，加权 ≈ **70%**。
> 但**产品核心域**（编辑器·时间线·音频·转写·字幕·MG·设计·生成·导出·Agent·技能·长转短，域 1–12+16，约 107 项）
> 覆盖 ≈ **89%**（约 91✅ / 8🟡 / 8❌）。
> **7-15 补漏 7 项**（本轮）：域2 `manage_markers`、域5 字幕 enum 3→21、域16 9:16 安全框、域10 字体载全 32 款(修静默回退)、域C `ripple`/`fade` 暴露给 agent、域6 MG→视频 `convert`/`register`(烘焙入池)、域B `view_asset_frames`(agent 看源资产帧)。
> **更早升级为 ✅**：域3 人声隔离（DeepFilterNet3 真装 spawn `deep-filter`）、域1 版本历史（命名快照/回滚）、
> 域12 `manage_skill` 自定义技能 CRUD、域4 多语言翻译变体（词级共享时间轴，护城河③）、域11 @引用结构化 + 导出历史/水印 + `edit_gap` 气口。
> **生成域（域8）6 个 submit_\* 全真接后端**（OpenAI/Gemini/Seedance/Kling/ElevenLabs/Doubao/Mureka；`track_progress` 真轮询），
> 非占位——唯**积分门 G4 缺**（TopBar `credits=18.5` 是硬编码装饰）。
> 拖低总数的**几乎全是**域 I/13/14/15/17/18 的后端基建（协作/账号计费/多端同步/遥测，基本 0%）——
> 单机克隆无对象可服务，**结构性 out-of-scope**。去掉这堆后剩余「纯前端可补」缺口很短（见 §二）。
>
> **开发纪律（本文存在的意义）**：做任何一项前，先读它在"源码依据"列指向的
> `chatcut-reverse/复刻规格-Agent工具与后端.md`（52 工具权威语义）/ `PRD.md` /
> 反编译 bundle，能用原命名/原算法/原数据就用，别凭空发明。
> **UI/像素对齐**另有专库 `chatcut-pixel-clone/`（DOM/CSS/字体 + 控件级 rect/styles JSON +
> 20k 截图）：任何布局/视觉/控件复刻先查它（入口 `INDEX.md`→`index/LABEL_INDEX.json`→
> `supplement/elements-full/` + `tokens/theme.slim.css`）。详见本仓 `CLAUDE.md` 的 UI 像素对齐节。

---

## 一、域覆盖总览

| # | 域 | 总 | ✅ | 🟡 | ❌ | 核心度 | 说明 |
|---|---|---:|---:|---:|---:|---|---|
| 1 | 项目 / 会话生命周期 | 6 | 4 | 0 | 2 | 核心 | ✅ 版本历史/followup 卡;会话/项目 CRUD 在 Dashboard+persist(非 agent 工具,忠实内嵌 agent 子集);缺 get_editor_url、restore(软删) |
| 2 | 编辑器核心 / 时间线 | 19 | 19 | 0 | 0 | 核心 | **全绿**；色度键✅ + `manage_markers`(标记已画上标尺:pin/备注编辑/8色/跳转[]/吸附) + ✅ ripple 插入/删除 + fade(秒) 已暴露给 agent;时间线工具栏图标对齐源站(CC徽标/↔适配/画幅框/纯间距);gif/svg/solid 类型待扩 |
| 3 | 音频处理 | 6 | 6 | 0 | 0 | 核心 | **全绿**：ducking + 响度归一(-14 LUFS) + ✅ 人声隔离(DeepFilterNet3 真装 spawn deep-filter) |
| 4 | 转写 / 文字稿 | 10 | 10 | 0 | 0 | 核心 | **全绿**：改错字 + 说话人重命名/合并 + ✅ 多语言翻译变体(词级共享时间轴,护城河③) + ✅ `edit_gap` 词间气口(list/delete/cap/restore) |
| 5 | 字幕 | 8 | 8 | 0 | 0 | 核心 | **全绿**：21 样式(agent enum 已全开) + 逐词覆盖 + 多源合并 + 双语/变体 |
| 6 | Motion Graphics | 8 | 6 | 2 | 0 | 核心 | ✅ 211 模板/manage_template/browse_library/edit_item/沙箱(211过5拦) + ✅ `convert_motion_graphic_to_video`/`register_converted_video`(烘焙入池,不透明 h264——alpha env-blocked,透明走 ProRes);🟡 create_from_code 契约缩水、propSchema 控件 |
| 7 | 设计风格 / 品牌 | 2 | 1 | 1 | 0 | 核心 | ✅ manage_design_style:24 真 catalog+owned+自由 role+注入;brand-kit logo 上传 🟡 |
| 8 | AI 生成（花钱域） | 7 | 6 | 1 | 0 | 核心 | ✅ **6 submit_\* 全真接后端**(image/video/voice/music/sound/shader)+track_progress 真轮询;⚠ 积分门 G4 缺(credits 硬编码) |
| 9 | 素材 / 媒体 | 12 | 7 | 2 | 3 | 核心 | ✅ manage_media_pool + import_url_asset + search_stock_media;🟡 download_media(只登记不落字节);❌ edit_asset、request_upload/presign、web_browser、手机上传 |
| 10 | 导出 / 交付 | 12 | 10 | 0 | 2 | 核心 | ✅ mp4/webm/mp3/wav/srt/xml + 帧范围 + 异步 job + 导出历史 + 水印烧录 + ✅ **字体载全 32 款(预览+导出同步)**;❌ 评分、WebCodecs(低优) |
| 11 | Agent / 对话平台 | 10 | 7 | 2 | 1 | 核心 | ✅ 持久化 + propose→apply + ✅@引用结构化 + Ask/Agent 模式 + creative-mode + stop/enhance;🟡 agent 设置;❌ thinking UI(受阻中转模型) |
| 16 | 长转短（专项） | 4 | 4 | 0 | 0 | 核心 | **全绿**：智能切片 + auto-reframe + 色度键 + ✅ 9:16 安全区 overlay(预览「安全框」双框+十字) |
| 12 | 技能 Skills | 3 | 2 | 1 | 0 | 可搬 | ✅ 创作模式(8 真 agent-skills)+ ✅ `manage_skill` 自定义技能 CRUD;skill_guard 🟡(propose→apply 已覆盖意图) |
| 18 | 遥测 / 增长 | 7 | 0 | 2 | 5 | 混合 | 快捷键/i18n/dockview 可做；遥测需 SaaS |
| 17 | 引导 / 场景 | 2 | 1 | 0 | 1 | 混合 | ✅ 创作模式/场景技能(域12);roadmap 需后端 |
| 13 | 协作 / 分享 | 5 | 0 | 0 | 5 | 需后端 | 多人同步/分享/邀请 |
| 14 | 账号 / 计费 / 积分 | 6 | 0 | 0 | 6 | 需后端 | 鉴权/Stripe/门控 |
| 15 | 多端 / MCP / 集成 | 5 | 0 | 0 | 5 | 需后端 | 唯本地 stdio MCP 可做 |

---

## 一·B、剩余真缺口（2026-07-15 审计，去掉已完成）

> 只列还没做的。分四类：① 近一行/极低成本 ② 纯前端正经活 ③ 受阻于中转模型 ④ 需真后端(out-of-scope)。

**① 极低成本快赢（管道已铺，唯缺入口）**　✅ 已完成 2026-07-15
- ✅ `manage_markers` agent 工具（域2）—— `agent/markers-tools.ts`(list/create/update/delete,点/段、scope project/item、8 色、批量 markers[]/updates[]),包 store 现成 addMarker/updateMarker/removeMarker,已注册。check 绿。
- ✅ `edit_captions` template enum 3→21（域5）—— `transcript-tools.ts` enum 改为 `CAPTION_STYLES.map(id)`,21 个样式 agent 全可选。
- ✅ 9:16 垂直安全区 overlay（域16）—— `PreviewPanel.tsx` 加「安全框」切换:标题/动作安全区双框+中心十字,内联样式(避开脏 index.css),仅预览不烧录。浏览器实测切换正常。

**② 纯前端正经活（有价值、需真写）**
- ✅ **字体加载修复（域10）** —— 实测预设+字幕引用 **32 款 Google 字体但只载 4 款**→静默回退(最明显视觉 bug)。修法:`googleFonts.ts` 静态载全 32 款(7 款中文厂字非 Google,只能回退待自托管);`main.tsx`+`remotion/Root.tsx` 都已调 `loadProjectFonts()` 故预览+导出同步修好。浏览器 `document.fonts` 实测 Anton/Playfair/Montserrat/Noto Sans SC… 10/10 已注册。(`search_fonts`/confirmFontFallback 门留后续。)
- ✅ `ripple`/`fade` 暴露给 agent（域C 护城河①）—— `set_item_timing` 加 `fadeInSeconds`/`fadeOutSeconds`(秒→帧,reducer 按 clip 长封顶);`remove_item` 加 `ripple`(→ rippleDeleteItem 合缝);`add_motion_graphic`/`add_audio` 加 `ripple`(插入挤位,store 命令透传)。reducer 帧数学有 `ripple-fade.check.ts` 绿。
- ✅ MG→视频 `convert_motion_graphic_to_video`+`register_converted_video`（域6）—— 新 `agent/mg-video-tools.ts`:convert 经现成 `/render-clip`(bakeClipToVideo)烘焙 clip→`addAsset` 入媒体池(可 replace 就地);register 导入已渲产物 URL。已注册。⚠ 本环境 ffmpeg 不能编码 alpha webm/vp9(clipExport.ts 自陈),故时间线视频是**不透明 h264**;透明 alpha 只能走 ProRes .mov 导出(域H `export_motion_graphic_prores`,待做)。
- ✅ `view_asset_frames`（域B 唯一❌ → 补齐）—— `frames-tool.ts` 加此工具:构造单资产时间线(MediaAsset→TimelineItem,MG 带 code、视频/图带 src,画布取资产尺寸)走现成 `/render-still`,把源资产帧作图像回给模型(B-roll/多机位选片)。FRAMES 模块已注册故零接线。实测 /render-still 渲单项构造态返 200+真 PNG。(`read_timeline` view=assets 与 manage_media_pool 重叠,略。)
- `edit_asset`（域9）改/删已生成 MG/effect 资产并重渲缩略图（与 create_from_code 真契约一对）。
- i18n /zh /en · 自定义快捷键(keymap 存 localStorage) · dockview 可拖拽面板 · 导出历史评分 · agent 设置面板扩展 · brand-kit logo 上传（域7）。

**③ 受阻于中转模型（前端就绪，换真 Claude 才生效）**
- thinking block UI（域11）—— grok/中转无 thinking 通道。

**④ 需真后端 / 结构性 out-of-scope（单机克隆无对象可服务）**
- 积分门 G4（域8，无 plan/计费）· 免费档水印门控（域10）· 遥测 report_user_friction/PostHog/Axiom（域I）
- 协作/分享/邀请/实时同步（域13）· 账号/Stripe/积分门控（域14）· 多端同步/公开 API（域15，**唯本地 stdio MCP 理论可做**）· 公开 roadmap 投票（域17）

---

## 二、优先级路线（纯前端可做，按价值/成本排序）

### P0 — 补齐产品核心的显眼缺口
1. ✅ **对话历史持久化**（域11）—— 已落地：`persist/projectStore.ts` 加 `loadChat/saveChat/clearChat`(复用 kv store,存 `{messages, llm}`);`useAgent(ctx,projectId)` 挂载 hydrate + 回合边界持久化 + `clearHistory`;ChatPanel 头部「清空对话」。附带修 `migrateProjectDoc` 丢 `designStyle` 的回归。检查 `chat-persist.check.ts` + 浏览器整页刷新实测双双恢复。源：`chat_block`。
2. ✅ **设计风格 `manage_design_style`**（域7）—— 已落地：`ProjectDoc.designStyle{colors[role,value],fonts[family,role],styleGuide}`(对齐源 `Ey/Ay/bM` 规范)+`editor/design-presets.ts`(4 内置预设=源 `/api/design-styles/owned` 类比)+`agent/design-tools.ts`(`manage_design_style` list/get/apply/update/clear，含旧式对象→数组规整)+注入(`systemPrompt.designStylePrompt` 进 agent loop、`designStyleHint` 进 MG 代码生成)+UI(`DesignStylePanel` 弹窗，TopBar 调色板入口，即时预览)。检查 `design-tools.check.ts` 绿。源：`复刻规格 §9 manage_design_style`。
3. ✅ **导出音频 mp3/wav + 帧范围**（域10）—— `/export` 与 `submit_export` 已支持源站 `format+codec` 契约（音频 MP3 + 本地 WAV 扩展）；MP4/WebM/MP3/WAV 共用半开帧范围并转换为 Remotion inclusive `frameRange`。源：`submit_export format=audio`。

### P1 — 高价值增量
4. ✅ **创作模式技能预设 = 域12 + 域17**（纯前端）—— 已落地:从公开端点 `/public-api/agent-skills/catalog` **全搬 8 个真实 agent-skills**(`agent/skills-catalog.ts`,名字/zh名/摘要/scenarios/bodyMarkdown verbatim);`ChatComposer` 底栏「创作模式」下拉;选中→`creativeModePrompt` 把技能 body 注入 `runtime.ts` 的 system;每工程存 IDB(`creative-mode:<pid>`)。源:`agent_skill`。(未做工具过滤:源站技能不改可用工具集,只导流程。)
5. **在线素材搜索 + URL→资产**（域9 ❌，成套）—— `agent/stock-tools.ts`（`search_stock_media` 归一 Pexels/Pixabay）+ `push_asset`/`download_media`（vite fetch→uploads→asset）。用户可见价值高。源：`复刻规格 §6`。
6. ✅ **submit_shader 着色器生成**（域8）—— 已落地：`agent/shader-tools.ts` 用 `createMessage` 让 LLM 按 `renderFx` 真 uniform 契约(`u_input`/`u_resolution`/`u_aspect`/`u_time`+每 property 一个 `u_<key>`,`#version 300 es`)写 GLSL;静态校验(拒空/超长/`#include`/缺 `u_input`/缺 `main`/缺颜色输出/多余 sampler)+浏览器内真编译(WebGL2 抛弃上下文)双门;过关经 `gl/fx/effects.ts` 新增的 `registerCustomFx()` 原地并入 `ALL_FX`,`manage_effects add assetId=<effectId>` 立即可查可用。只做源 `type=effect` 分支(暂略 transition/referenceAssetIds)。检查 `shader-tools.check.ts` 绿。源：`复刻规格 §8 submit_shader`。
7. ✅ **异步渲染 job + `track_export`**（域10）+ **fcpxml 导出** —— 异步:`POST /export/job` 复用 `createGenerationJob` 返 renderId + `track_export`(status/wait);fcpxml:`src/export/fcpxml.ts` + `submit_export format=xml`。详见域10 明细。commit 待提交。
8. ✅ **manage_transcript 说话人重命名/合并**（域4）—— 已落地：`manage_transcript action=renameSpeaker(from,to)`,reducer 新 `renameSpeaker` 动作只把 `transcript[].speaker===from` 改成 `to`(text/start/end/词数/时长零改动,含无操作守卫,并入 `MUTATING` 单步可撤销);rename('A'→'主持人')与 merge('B'→'A')同一机制。此前 `fix` 改错字已做。剩多语变体未做。源：`manage_transcript`。
9. ✅ **逐词字幕覆盖 `read_captions`+`edit_caption_words`**（域5）—— 已落地：`CaptionsData.wordOverrides:Record<number,{hidden?,text?,forceBreak?}>`(按**源 transcript 词序号**键,删词不重排);`resolve.ts` 加 `resolveCaptionWordIndices`+`applyWordOverrides`(隐藏丢弃/换文保时/forceBreak 算 breakBefore),`paginate` 加可选 `breakBefore` 参(无覆盖字节等同);`CaptionsLayer`(预览+burn-in)与 `generate/subtitles.ts`(SRT/TXT 导出)同一管线,屏幕=导出。新 `agent/captions-tools.ts`:`read_captions`(回每页词+index+override)/`edit_caption_words`(经现成 `updateCaptions` 命令落 IDB,越界回 errors 不抛)。检查 `captions-tools.check.ts` 绿。源：`edit_captions display_text`。（🟡 双语 `translate.ts` 暂不套 override——译文是独立叠层,词级隐藏错配轻微,留待多源合并一并处理。）

### P2 — 锦上添花 / 收尾
10. ✅ **auto-reframe 自动检测**（域16）—— `reframe/detect.ts` 轻量启发式(亮度方差网格→质心焦点,无重 ML)+ `agent/reframe-tools.ts` `auto_reframe` 逐帧 `setReframeKeyframe`,复用现成 `ReframeCurveV1` 渲染链。详见域16 明细。
11. ✅ **智能切片**（域16）—— `agent/highlight-tool.ts` `find_highlights`:LLM 读词级 transcript 打分→`duplicateTimeline(9:16 cover)`→`deleteWords` 裁段(护城河③)。长转短成片交付口。详见域16 明细。
12. **MG→透明视频补 alpha + 工具化**（域6 🟡）—— `render.mjs` 加 vp8/webm-alpha 分支保透明；`convert_motion_graphic_to_video`/`register_converted_video` agent 工具。
13. ✅ **色度键绿幕**（域2）—— `gl/fx/chroma-key.frag`(YCbCr 键控+spill) + `FX_EFFECTS` `builtin:fx-chroma-key`,走现成 `ClipFx`/`manage_effects` 自动可用。详见域2 明细。
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
- ✅ **空工程轨道模型对标源站** — 空工程仅 1 视频轨起步（原 2V+2A）；音频轨可全删、仅末条视频轨受保护（`reduce` track.delete 守卫改为只护 video）；`createTimeline` 单轨起步、`pickTrack` 按需 dispatch `track.create` 建轨。对齐 `60_empty_project`。commit c984d9e。
- 🟡 **gif/svg/solid 媒体类型** — 源按类型拆表。→ `types.ts` `kind` 加三种；`TimelineComposition` `ItemLayer` 加渲染分支。
- ✅ **色度键 / 绿幕** — `gl/fx/chroma-key.frag`(YCbCr 键控 + spill 抑制) + `FX_EFFECTS` 一格 `builtin:fx-chroma-key`(keyColor/similarity/smoothness/spill),走现成 `ClipFx`/`manage_effects` 自动可用、无需改 agent。源 `chroma`(PRD:153)只列能力名→算法自定。commit 待提交。

### 域 3 · 音频处理
- ❌ **AI 降噪 / 人声隔离** — 源 `isolate_voice`（DeepFilterNet3，action apply/attach/clear，strength 0-100）。→ `src/audio/isolate-tools.ts` 注册工具 + `item.isolatedSrc`；纯前端先做 "attach 已传 wav"，apply 走后端占位。
- ✅ **响度归一化 (-14 LUFS)** — `audio/loudness.ts`：纯函数 `integratedLoudnessFromSamples`(BS.1770 简化:400ms 块+绝对门,ponytail 标了无 K-weighting 上限)+ `gainForTarget`;浏览器 `analyzeClipLoudness`(OfflineAudioContext 解码);`normalize_loudness` 工具逐 audio 片段量测→算增益→现成 `setItemVolume`。源站无独立工具→自定。检查 `loudness.check` 绿。commit 待提交。

### 域 4 · 转写 / 文字稿
- 🟡 **多语言转写变体** — 源 `manage_transcript translation_ensure/create`（变体挂 source 共享时间轴）。→ `transcript/types.ts` 加 `variants`；字幕改"选变体显示"而非现场翻译。
- ✅ **转写校正（改文本）** — `manage_transcript action=fix`：reduce 就地改 `transcript[wordIndex].text`，不动帧位/时长（护城河③）。commit f2e7467。
- ✅ **说话人重命名 / 合并** — `manage_transcript action=renameSpeaker(from,to)`：reduce 只改 `word.speaker`（rename 与 merge 同机制），text/timing 零改动、含无操作守卫、单步可撤销。commit 99a17c8。

### 域 5 · 字幕
- ✅ **字幕源路由（多轨合并）** — `CaptionsData.sources?: string[]` + `sourceMode?: 'item'|'timeline'`(向后兼容 `sourceItemId`,单源字节等同);`resolve.ts` `resolveCaptionWords` 按 sources/timeline 归并多轨转写、按 start 时间排序(护城河③ 词 text/timing 不动);新 `set_caption_sources` 工具(自动挂 captions 模块)。源 action 名无据→自定。检查 `captions-tools.check` 绿。commit 待提交。
- 🟡 **（子）edit_captions template enum 仅 3/21** — → `transcript-tools.ts` enum 改 `CAPTION_STYLES.map(id)` 全量。
- ✅ **逐词覆盖（隐藏/改字/强制换行）** — `CaptionsData.wordOverrides`（按源词序号键）+ `read_captions`/`edit_caption_words`；预览·burn-in·SRT 三处同一 `applyWordOverrides` 管线。commit 772398b。（遮罩/拆/并留待多源合并一并处理）

### 域 6 · Motion Graphics
- 🟡 **MG → 透明视频（convert_to_video）** — 现"转为视频"压平 alpha + 无 agent 工具。源 `convert_motion_graphic_to_video`+`register_converted_video`。→ `render.mjs` 加 vp8/webm-alpha；`generate-tools.ts` 加两工具入媒体池。
- 🟡 **（子）propSchema 补 select/font/image 控件** — 现 9 类型里 font/select/image/asset 退化成 text。→ InspectorPanel schema 映射加三种控件。
- ✅ **manage_template（工程模板打包/应用）** — `agent/template-tools.ts`(get/list_assets/apply 真名 + save 自定)+ `persist/templateStore.ts`(全局 kv `templates:all`,ProjectDoc 打包,`migrateProjectDoc` 校验)。apply 合成一份 ProjectDoc→单次 `applyDoc`(护城河① 原子可撤销);placement append/replace、`omitAssetIds` 连带跳过引用片段、item id 重生避免双击碰撞。检查 `template-tools.check` 绿。源 `manage_template`。commit 待提交。

### 域 7 · 设计风格 / 品牌
- ✅ **设计风格库 manage_design_style** — 源 `复刻规格 §9` + **活体抓包核对**(`/api/design-styles/owned` + `/public-api/design-styles/catalog`)。已实现 list(catalog+owned)/get/apply/update/clear/**save/delete**;**全搬 24 个真实 catalog 预设**(curl 公开端点 verbatim);**owned「我的风格」本地库**(存/应用/删)。**role 是自由文本**(真值 "accent copper"/"text secondary"/"Chinese heading"——之前照 bundle 的 Ey/Ay 限死枚举会丢真数据,已改 role:string)。规整器对齐 `bM/yM/xM`(旧式对象→数组仍按常用键)。注入 MG/字幕生成(枚举全部自由角色)。
- 🟡 **品牌套件 brand kit** — 源与 design-style 合一;`styleGuide`(真值是详细 spring/stagger 动效规格)已含。**logo/product-images 资产上传** 留待(源 designSpec.logos/images,本地需资产上传链路)。

### 域 8 · AI 生成
- ✅ **着色器生成 submit_shader** — `agent/shader-tools.ts`：LLM 按 renderFx uniform 契约写 GLSL → 静态校验 + 浏览器内真编译 → `registerCustomFx` 并入 `ALL_FX` 喂 `manage_effects`。只做 `type=effect`（暂略 transition/referenceAssetIds）。commit c9b5264。
- 🟡 **任务队列 + 积分计量** — image/voice/sound 仍同步未入队；积分=0。→ 统一走 `createGenerationJob`；持久化队列；credit 模型 + 服务端扣费门。

### 域 9 · 素材 / 媒体
- ❌ **在线素材搜索 search_stock_media** — 源 `复刻规格 §6`（Pexels/Pixabay 归一）。→ `agent/stock-tools.ts` 统一结果 + import URL。
- ❌ **URL→资产 push_asset/download_media** — 源 `复刻规格 §6`。→ `push_asset` 存 URL 元数据；`download_media` vite fetch→uploads→asset。与 stock 成套。
- ❌ **网页抓取 web_browser** — 源 Firecrawl（key 在 `~/.claude/secrets/search-apis.env`）。→ `agent/web-tools.ts`。锦上添花。
- ❌ **手机上传 /m/:token** — 源 phone-upload。→ 一次性 token + 二维码。低优先。
- 🟡 **字体搜索 search_fonts** — 现静态 4 字体。源 `复刻规格 §6`。→ `agent/font-tools.ts` 查 Google Fonts + 导出前 `confirmFontFallback` 门 + 按需 loadFont。

### 域 10 · 导出 / 交付
- ✅ **异步渲染 job + track_export** — `POST /export/job` 复用现成 `createGenerationJob` 入队返 renderId + `GET /export/job/:id` 快照；`agent/export-tools.ts`:`submit_render_job`(入队) + `track_export`(status/wait 轮询进度→ downloadUrl)。同步 `/export` 原样保留。renderId + 单渲染是对源多-render 的简化。live 实测:入队→running→succeeded→/media/uploads 文件。commit 待提交。
- ✅ **导出 XML（fcpxml）** — `src/export/fcpxml.ts` `timelineToFcpxml(state)` 纯序列化→FCPXML 1.10(resources/library/sequence/spine,帧→有理时间 `frames/fps s`,轨道→lane,MG 无媒体→命名 gap 占位);`submit_export format=xml` 客户端 blob 下载(秒出无需渲染)。Premiere/达芬奇/FCP 可导入。commit 待提交。
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
- ✅ **自动重构图 auto-reframe（检测）** — `src/reframe/detect.ts` 轻量启发式(亮度方差网格→能量质心焦点,可选 FaceDetector,无重 ML)；`agent/reframe-tools.ts` `auto_reframe` 逐帧 `setReframeKeyframe`(焦点 0..1、mag 0.05..16 对齐 `ReframeCurveV1`)。commit 待提交。源 `reframe` 无 detect 工具→自定。⚠ 两处 MVP 取舍:①mag 用满 contain→cover(片段已 cover 会二次放大);②重跑清全部 reframe 关键帧(无 auto/manual 标记)。
- ✅ **智能切片（找高光→多条短视频）** — `agent/highlight-tool.ts` `find_highlights`:LLM 按源 `talking-head-guide` 选高光准则读词级转写打分→`duplicateTimeline({retarget:9:16 cover})`→用现成 `deleteWords`/`setItemTiming` 裁段(护城河③ 词↔帧不变,切点落词边界)。**长转短成片口,最高价值**。源无单一工具→自定。commit 待提交。
- ❌ **垂直安全区** — → `PreviewPanel` 加 9:16 安全框 overlay。纯 CSS。（避开:PreviewPanel 属你在手调的 UI 文件，待你收尾或一行插入）

### 域 12 · 技能 Skills（纯前端，优先做）
- ✅ **内置技能预设（创作模式）** — 全搬 8 个真实 agent-skills(源 `agent_skill`),选中注入系统提示。见 §二 P1-4。
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
