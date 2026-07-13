# ChatCut 复刻 · 功能覆盖 TODO（对标源站全量清单）

> 逐项对照逆向资料（`~/Desktop/project/chatcut-reverse/`：52 工具规格 / PRD / architecture_findings / deep_mining / 页面清单 / 缺口清单）与本仓库（`chatcut-clone/`）当前实现。
>
> **图例**：✅ 已实现 · 🟡 部分实现 · ❌ 未实现
>
> 每个 🟡/❌ 项给：**怎么做 / 用什么技术 / 对应源站**。初始生成于 2026-07-13；状态于 2026-07-14 从 `feature-coverage.html` 同步。

当前共 **131** 项：✅ 已实现 **39** · 🟡 部分实现 **17** · ❌ 未实现 **75**。按“已实现=1、部分实现=0.5”计算，路线图覆盖率为 **36.3%**。

---

## 0. 总览打分

| 域 | 状态 |
|---|---|
| 编辑器核心 / 时间线 | 🟡 剪辑、变换、动画、标记已完成；特效/转场/轨道管理部分完成，多时间线/ripple 待补 |
| MG 模板 | ✅ 基本完整（211+生成+沙箱），缺属性面板/设计风格 |
| 转写 / 文字稿编辑 | 🟡 核心在（删词=删视频/静音压缩），缺 timeline.md/av_script/校正/变体 |
| 字幕 | 🟡 3 模板+卡拉OK+跟随+双语，缺预设扩充/逐词覆盖 |
| AI 生成（视频/图/配音/音乐/音效/着色器）| ❌ 全缺（本地无生成能力，仅占位素材）|
| 导出 | 🟡 仅 MP4（服务端渲染），缺 srt/xml/audio/ProRes/WebCodecs/异步job |
| 项目/持久化/多工程 | 🟡 IndexedDB 自动保存恢复、多工程和仪表盘已完成；版本历史/交互卡/工程绑定待补 |
| 协作 / 分享 / 实时同步 | ❌ 全缺 |
| 账号 / 计费 / 积分 | ❌ 全缺（TopBar 静态 18.5）|
| Agent 平台 | 🟡 原生 tool-use、流式输出、约 19 个工具、propose→apply 已完成；技能/会话持久化/多模态自检待补 |
| 多端 / MCP / 集成 | ❌ 全缺 |

---

## 1. 项目 / 会话生命周期

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| 单工程内存编辑 | ✅ | `useEditor` reducer，App 内存态 |
| **工程持久化（保存/加载）** | ✅ | IndexedDB 自动保存 + 启动恢复，见 `persist/projectStore.ts`；正式版对标 Zero + IndexedDB（local-first）|
| **多工程 + 仪表盘 `/projects`** | ✅ | hash 路由 + 工程列表页，支持新建/打开/重命名/复制/删除；每工程独立持久化，见 `Dashboard.tsx` |
| **版本历史（快照/回滚）** | ❌ | 每次保存打快照（已有 undo 快照机制可复用），列表+命名+diff+回滚。源站 `/api/versions` + 顶栏「版本」 |
| ask_followup_questions（交互卡）| ❌ | Agent 需要澄清时返回结构化表单卡（单选/多选/文本/voice/scenario 卡），前端渲染。源站 `ui://chatcut/followup-questions-v31` |
| get_editor_url / target_project | ❌ | 多工程后才有意义（会话绑定工程）。源站 G1 projectId 绑定 |

## 2. 编辑器核心 / 时间线

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| 增删改查片段（add/move/retime/duplicate/remove/split）| ✅ | `store.ts` reducer，1:1 映射 agent 工具 |
| 撤销/重做 | ✅ | 快照式 history |
| 拖拽移动 / 裁剪（trim 手柄）/ 跨轨约束 | ✅ | `Timeline.tsx` pointer 拖拽 |
| 时间轴横向缩放 🔍 / 竖向轨道缩放 Alt+滚轮 | ✅ | zoom/trackScale 状态 |
| 时间线上下拖高 + 加权轨道高度 | ✅ | `cc.timelineH` + WEIGHT |
| **多时间线/序列（每工程多条）** | ❌ | `TimelineState` 升成 `{timelines: Timeline[], activeId}`；tab 切换/新建/复制/删除/隐藏。源站 `manage_timelines`，`active_timeline` 表。**长转短的地基**（每比例一条序列）|
| **轨道管理（增删/改序/角色/锁/隐/静音/收紧）** | 🟡 | 现固定 V2/V1/A1/A2、👁🔊 是死图标。做：轨道数组化 + 每轨 `{visible,muted,locked,collapsed,role}`；role 驱动自动闪避。源站 `edit_track`（list/create/update/delete/**tighten**）|
| **刀片工具(B)/修剪工具(N)/吸附** | ✅ | 刀片按钮/B 键在播放头切分，切口 `srcInFrame` 递进；拖拽/裁剪可吸附到 0、播放头和邻近片段边 |
| **Ripple 编辑（插入/覆盖模式）** | ❌ | `edit_item` 的 `ripple` 语义：插入模式后续片段整体位移+合缝。做：reducer 加 ripple 参数，move/add 时顺延同轨后续 item。源站域 C 核心 |
| **片段变换（缩放/位置/旋转）** | ✅ | `ClipTransform {scale,x,y,rotation}` 通过 `ClipWrapper` 应用 CSS transform；属性面板提供缩放、位置、旋转滑块 |
| **动画/关键帧（源真相：无通用 K 帧）** | ✅ | MG 使用 `interpolate`/`spring`/bezier；`builtin:zoom` 提供参数化缩放动画；`ReframeCurveV1` 提供焦点与倍率稀疏关键帧 |
| **更多媒体类型：image / gif / svg / text / solid** | 🟡 | image、video、text 已完成；gif、svg、solid 待补。text 支持内容、字号、颜色、对齐和字重 |
| **视频素材片段（video item）** | ✅ | 导入真视频并通过 `<OffthreadVideo>` 预览和导出 |
| **特效（blur/zoom/mosaic/CRT/ASCII…）** | 🟡 | 亮度、对比度、饱和度、模糊已完成；mosaic、CRT、ASCII 等 WebGL 特效待补 |
| **转场（cross-dissolve/dip/whip-pan/zoom/slide/luma…）** | 🟡 | 已完成溶解、黑场、柔化擦除、甩镜、闪白、亮度混合；page-curl、rack-focus 等复杂 GLSL 转场待补 |
| **标记 markers（点/段批注）** | ✅ | 支持点/区间标记、批注、8 色、跳转和标记帧吸附；源站 `manage_markers` |
| **色度键 / 绿幕（chroma key）** | ❌ | 对 video item 做颜色抠像。做：WebGL shader 抠指定色。源站 `chroma` |
| **变速 / 重定时（variable speed）** | 🟡 | 有 set_item_timing 改时长，无保音调变速。做：item 加 `playbackRate`，`<Audio>/<Video>` 用 `playbackRate` + 时间线时长按 rate 换算（源站 caption 的 `dH` 已含 playbackRate 语义）|

## 3. 音频处理

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| 音频片段 + 音量 | ✅ | `<Audio volume>` |
| **淡入淡出（fadeIn/Out 秒）** | ✅ | `fadeInFrames`/`fadeOutFrames`：视觉通过 `ClipWrapper` opacity，音频通过 volume 函数处理；属性面板按秒调节 |
| **响度归一化（-14 LUFS）** | ❌ | 分析音频 RMS/LUFS → 增益。做：Web Audio `AnalyserNode` 离线算，或导出后 ffmpeg `loudnorm`。源站 `normalize`/`loudness` |
| **自动闪避 ducking（music 遇 voice 降）** | ❌ | 检测 voice 轨活动区间 → music 轨该区间降音量关键帧。源站 track role 驱动 `ducking` |
| **AI 降噪 / 人声隔离** | ❌ | `denoised_audio_asset`。做：接 **DeepFilterNet3**（开源 Rust，可本地跑 wasm/服务端）产一条降噪 wav，item 可切换源。源站 `isolate_voice` |
| **旁白录制（麦克风）** | ❌ | `MediaRecorder` 录麦 → 落 A 轨 audio item → 自动转写。源站 record 模式 mic/screen/camera/voiceover |

## 4. 转写 / 文字稿编辑

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| AssemblyAI 词级转写 + 说话人分离 | ✅ | `transcript/assemblyai.ts`，speaker_labels |
| 段落/片段视图 + 说话人标签 + 轨道选择 | ✅ | `TranscriptPanel` |
| 删词=删视频（keptSegments 重排）| ✅ | `transcript/edit.ts` |
| 静音压缩 + 去填充词（clean_script）| ✅ | `maxGapFrames` + `fillerIndices` |
| find_transcript 定位短语→帧位 | ✅ | agent 工具 |
| **timeline.md / read_script / apply_script（改文本即改片）** | 🟡 | 有 delete_text，无「把时间线序列化成带时间码 Markdown 文稿→编辑→diff 回操作」。做：`serializeToScript(state)→md`，`applyScript(md)→ops`。源站最独特交互（域 C `apply_script`/`read_script`，`[sN]` 行映射可播放区间）|
| **read_av_script（结构化音视频脚本）** | ❌ | agent 的结构化剪辑表示。做：把时间线导成 agent 可读的 AV 脚本文本。源站 `read_av_script` |
| **转写校正（改文本）** | ❌ | 编辑器里改错字，词↔帧映射不变。源站 `manage_transcript` content/json |
| **多语言转写变体（共享时间轴）** | 🟡 | 有双语字幕（短语级译文），无完整 transcript 变体体系。做：`transcript(source) 1—N variant(lang)`，字幕/双语选变体显示。源站 `transcription_sub_asset`(variant_group) |
| 说话人重命名 / 合并 | ❌ | 面板里改 speaker 名、合并两说话人。源站转写编辑 |

## 5. 字幕

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| 字幕 overlay（tiktok/netflix/plain）| ✅ | `CaptionsLayer` |
| 卡拉OK逐词高亮 + pacing 词/短语 | ✅ | activePage/currentWordIndex |
| 字幕随编辑重排（retime）| ✅ | `retimeWords`（源站 dVe/fVe/dH 模型）|
| 双语字幕（译文第二行）| ✅ | `captions/translate.ts` |
| 烧录进导出 | ✅ | 合成内渲染 |
| **样式预设扩充（Persona/Bubble Pop/Submagic/Noir…）** | 🟡 | 现 3 个。做：加更多命名预设（字体/描边/背景/动画）到 `caption_style_preset` 风格表。源站 `caption_style_preset`(owner) + 十来个预设名 |
| **逐词覆盖（隐藏/遮罩/拆/并/改字）** | ❌ | 对单个词做显示覆盖。做：`caption_word_override[{wordId, action, text}]`，渲染时套用。源站 `caption_word_override` 表，`edit_captions` display_text 动作（需先 read_captions）|
| 字幕源路由（选哪些音轨生成）| 🟡 | 有 sourceItemId（单轨）。多轨合并生成可扩。源站 `sourceScope`/`trackOrder` |

## 6. Motion Graphics

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| 211 模板库 drop-in + 沙箱 | ✅ | `template-host.ts`（黑名单+受限 eval）|
| create_motion_graphic（LLM 现写代码）| ✅ | agent 工具 |
| 设计框缩放（1920×1080 + scale）| ✅ | ItemLayer fit |
| **属性面板（properties schema 驱动）** | 🟡 | InspectorPanel 能改 props，但没吃模板的 `properties` schema（类型化控件：text/color/number/font/boolean/image/select）。做：模板 meta 带 propSchema → 生成对应控件。源站 9 种属性类型自动生成参数面板 |
| **transparentBackground 叠加开关** | ❌ | MG 作透明覆盖层。做：item flag，渲染时不铺底。源站标准 overlay 开关 |
| **manage_template（工程模板打包/应用）** | ❌ | 一组 MG+设计风格打包。做：模板=item 组+风格快照，apply 落轨。源站 `manage_template` |
| **MG→透明视频（convert_motion_graphic_to_video）** | ❌ | 云渲 MG 为 vp8/WebM alpha。做：`@remotion/renderer` 渲 MG 单独段（透明 codec）。源站 `convert_motion_graphic_to_video`+`register_converted_video` |
| **导出 MG 为 ProRes4444 alpha .mov** | ❌ | NLE XML 导出前用。做：renderMedia codec=prores。源站 `export_motion_graphic_prores`（PRO 门控）|

## 7. 设计风格 / 品牌

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| **设计风格库（颜色/字体/动效预设）** | ❌ | 应用到模板/字幕/整片的品牌视觉。做：`designStyle{palette,fonts,motion}` 存工程 + 注入 MG/字幕默认色字体。源站 `manage_design_style`，`design_style` 表（当前应用的即工程品牌）|
| **品牌套件 brand kit（logo/色/字）** | ❌ | agent 自动套用。源站 `manage_brand_kit`，`brand_kit` 表 |

## 8. AI 生成（花钱域，全部未实现）

> 全部对标源站 §8 `submit_*`（异步 job + 积分门控）。本地方案：接对应 API 或开源自建，统一走 job/队列。当前仓库只有占位素材（3 音乐+voice 样本），**零生成能力**。

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| **AI 视频生成** | ❌ | `submit_video`；接 BytePlus **Seedance2**/Kling API（或开源 Wan2.1）；文/图生视，1–15s，首末帧。产 asset→edit_item 落轨 |
| **AI 图片生成** | ❌ | `submit image`；OpenAI **gpt-image-2** / Gemini nano-banana（或开源 **FLUX.1**）|
| **AI 配音 TTS** | ❌ | `submit_voice`；火山 **Doubao BigTTS**（中文优，uranus/saturn 音色）+ **ElevenLabs**（或开源 CosyVoice/F5-TTS）。先跑试听选音（voice 卡）。有 35 个试听样本在逆向资源 |
| **AI 音乐生成** | ❌ | `submit_music`；**Mureka**/Suno（或开源 MusicGen/Stable Audio）|
| **AI 音效生成** | ❌ | `submit_sound`；**ElevenLabs SFX**（或 Stable Audio Open）。先查库再生成省钱 |
| **着色器生成（转场/特效）** | ❌ | `submit_shader`；Gemini→GLSL/TS，产 `EffectProcessor`/`TransitionProcessor` 子类，**必须编译校验+沙箱**（同 MG）|
| **任务队列 + 轮询 + 积分计量** | ❌ | 上述全走统一 `job/generation_job`（幂等+poll_due）+ `track_progress` 轮询 + `api_usage.service` 按供应商计费。源站 G3/G4 |

## 9. 素材 / 媒体

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| 音频素材库（3 音乐+voice）| ✅ | `audio/library.ts` |
| MG 模板库（211）| ✅ | 内置 JSON |
| **通用媒体导入（上传视频/图/音）** | ✅ | 上传端点 `vite-plugin-upload` 写入 `public/media/uploads`，客户端探测时长/尺寸，预览与导出同源 |
| **媒体池（文件夹/搜索/排序/收藏/网格）** | 🟡 | 「我的素材」面板与 `assets[]` 已完成，支持导入和点击落轨；文件夹/搜索/排序/收藏待补 |
| **手机上传 `/m/:token`** | ❌ | 扫码手机传素材。源站 phone-upload 模块 |
| **库素材浏览（转场/特效/LUT/缩放/音效）** | 🟡 | 只有 MG 库。做：把转场/特效/LUT/zoom/sfx 也做成库分类。源站 `browse_library`（7 类）|
| **LUT（Sony S-Log3/Canon Log3）** | ❌ | 对 video 应用 .cube LUT。做：WebGL 3D LUT 采样。源站 2 个内置相机 log 转换 |
| **在线素材搜索（Pexels/Pixabay/Unsplash/Freesound）** | ❌ | `search_stock_media` 归一各家 API→import URL。配 `push_asset`/`download_media` |
| **URL→资产（push_asset/download_media）** | ❌ | 公网媒体 URL 注册/下载为工程资产 |
| **网页抓取（web_browser）** | ❌ | **Firecrawl**/Jina Reader 抓网页作参考。源站 `web_browser` |
| **字体搜索（search_fonts）** | 🟡 | 已加载 4 个 Google Fonts；无搜索。做：Google Fonts API 列表 + 按需 `@remotion/google-fonts` 动态加载。源站 `search_fonts` |
| **多模态自检（view_timeline_frames / view_asset_frames）** | ❌ | **agent 渲染若干帧成图自己"看"**。做：`@remotion/renderer` renderStill 指定帧→base64→回传 agent（tool_result 带 image）。源站 `view_timeline_frames`（护城河：agent 真看成片）|

## 10. 导出 / 交付

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| 导出 MP4（服务端 @remotion/renderer, h264+aac）| ✅ | `vite-plugin-export.ts` + `remotion/render.mjs` |
| 字幕烧录 + 字体保真 | ✅ | CaptionsLayer + Google Fonts |
| 宽高比/fit（长转短基础）| ✅ | 见功能 ⑪ |
| **导出字幕文件（srt/txt）** | ❌ | 把 caption cues 序列化成 SubRip/txt（同步返回）。源站 `submit_export` format=subtitles |
| **导出音频（mp3/wav）** | ❌ | renderMedia codec=mp3，或 ffmpeg 抽音轨。源站 audio tab |
| **导出 XML → Premiere/DaVinci（fcpxml）** | ❌ | 时间线序列化成 FCPXML 方言 + MG 作 ProRes 引用。源站 `nleFormat` fcp_xml/fcp_xml_resolve —— 长转短交付口 |
| **浏览器端 WebCodecs 快导** | ❌ | 轻量导出走 `VideoEncoder`+muxer（不经服务端 Chrome）。源站 in-browser 快路径 |
| **异步渲染 job + 轮询（track_export）** | ❌ | 现同步阻塞。做：导出入队列返 renderId，前端轮询进度。源站 `track_export` + Remotion Lambda |
| **部分导出（帧范围）** | ❌ | renderMedia frame range。源站 startFrame/endFrameExclusive |
| **字体兜底确认（confirmFontFallback）** | 🟡 | 已加载常用字体；无「不支持字体清单→二次确认」门。源站 §10 |
| **免费档水印** | ❌ | 合成加水印层（按 plan）。源站 `updateWatermark` |
| **导出历史 + 渲染后评分** | ❌ | `export_history` 表 + 反馈。源站 |

## 11. Agent / 对话平台

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| Anthropic 原生 tool-use（可换真 Claude 一行）| ✅ | `agent/`，现跑 grok 中转 |
| 流式输出（text/thinking）| ✅ | `messages.stream` |
| ~19 个工具（读/加/改/转写/字幕/删词/比例）| ✅ | `tools.ts`+`transcript-tools.ts` |
| **propose → review → apply（提案审阅再落地）** | ✅ | Agent 先在草稿态执行结构编辑并生成 proposal；`ProposalCard` 支持逐操作勾选、预览、应用和拒绝，批准后作为一次原子提交，可一次 undo |
| **多轮会话持久化（session/reset/max_turns）** | 🟡 | 有循环，无会话存储。做：`chat_block` 有序存对话；reset/继续。源站 `sdk_session` |
| **@ 引用素材进对话** | ❌ | 聊天里 @某片段/资产带上下文。源站 `chat_context_entry` |
| **对话历史持久化** | ❌ | 刷新即丢。源站 `chat_block`(project_seq) |
| **扩展思考展示（thinking block UI）** | 🟡 | 中转透传 thinking，UI 未必渲染。做：渲染 thinking_start/delta/end 折叠块 |
| **Agent 设置（模型/速度/思考/MG 质量/自动放行）** | ❌ | 设置面板。源站 agent settings |
| **Bash/Edit/Read/Write 等 SDK 内置工具（工程即目录）** | ❌ | 源站底座=Claude Agent SDK，把工程当虚拟文件系统。复刻可选：真上 Agent SDK。护城河③ |

## 12. 技能 Skills

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| **内置技能预设（6 创作模式）** | ❌ | motion-graphic/talking-head/explainer/long-to-short/product-launch/ai-short = 系统提示+允许工具+默认参数。做：`skills[]` 预设，选中改 agent system+toolset。源站 `agent_skill` + scenario_preset |
| **自定义技能（建/改名/删 + 存为技能）** | ❌ | 把一次编辑流程冻结成可复用技能。源站 `manage_skill`，`skill_create_prompt` |
| **skill_guard（按技能的工具放行门）** | ❌ | 高风险/高成本操作弹审批。源站 `skill_guard_shown/option_selected` |

## 13. 协作 / 分享

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| **实时同步 + 在线状态** | ❌ | 多人同编。做：**Rocicorp Zero**（local-first+响应式）或 Yjs/Liveblocks；源站 `viewsyncer.chatcut.io`=zero-cache |
| **分享链接（只读/认领/协作）** | ❌ | `/share/:token`·`/v/:token`·`/share-claim`。做：分享路由 + 只读渲染 + 成员认领。源站 share-api |
| **邀请协作者 + 成员角色** | ❌ | better-auth organization。源站 `project_member`(role) |
| **评论 / 批注** | ❌ | 片段/时间点留评论。源站 `comment`/`annotation` |
| **webhook / API key（团队自动化）** | ❌ | 源站 `job_api_key` |

## 14. 账号 / 计费 / 积分

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| **鉴权（登录/会话/登出）** | ❌ | **better-auth**（开源，+organization 插件）。源站 `/api/auth` |
| **多租户 / 工作区 / 组织** | ❌ | better-auth organization。源站 workspace 切换 |
| **积分系统（授予/流水/花费门控）** | ❌ | TopBar 现是静态 18.5。做：`credit_grant`(有效期)+`credit_tx`(流水,幂等)+服务端扣费门控。源站 G4 |
| **Stripe 计费（plans/checkout/portal）** | ❌ | free/premium/business。源站 payment-api |
| **功能门控（featureKey/配额）** | ❌ | 按功能设时长/片段/起点配额。源站门控系统 |
| **限流** | ❌ | `{type} limit exceeded`。源站速率限制 |

## 15. 多端 / 集成 / MCP

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| **外部 MCP server（52 工具暴露给 ChatGPT/Codex/TRAE）** | ❌ | 把 executeTool 包成 MCP server（OAuth2+动态注册）。源站 `api.chatcut.io/api/external-mcp/mcp` |
| **CLI / 桌面授权 / connect** | ❌ | `editor_boot_token` 设备配对。源站 cli-auth/desktop-auth/connect 模块 |
| **公开 API 网关** | ❌ | `router.chatcut.io/public-api` + api key |
| **多宿主安装页** | ❌ | ChatGPT/Codex/TRAE/WorkBuddy 安装页 |
| **内嵌编辑器授权（inline-editor embed）** | ❌ | `/auth/inline-editor` 第三方内嵌 |

## 16. 长转短（专项工作流）

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| 宽高比 + fit（16:9↔9:16/1:1/4:3/3:4）| ✅ | 功能 ⑪ |
| **自动重构图（人脸/主体跟踪 auto-reframe）** | ❌ | 换比例时自动跟主体移动裁切窗。做：人脸/显著性检测（MediaPipe/TF.js）→ 关键帧化裁切位置。源站 `reframe`（×71）|
| **智能切片（按转写自动找高光→多条短视频）** | ❌ | LLM 读转写打分找高光段→批量生成短视频序列。源站 smart clipping + 多时间线 |
| **垂直安全区** | ❌ | 9:16 时显示安全框辅助排版 |

## 17. 引导 / 场景 / Roadmap

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| **6 创作模式场景（含 prompt+guidance）** | ❌ | 新建工程时选模式 → 预填 agent 系统+首条引导。逆向已存 19 生成预设+6 封面。源站 `scenario_preset` |
| **公开路线图（提交+投票）** | ❌ | `/roadmap` 页 + roadmap_item/vote。源站 roadmap 模块 |

## 18. 遥测 / 增长（非核心，最后做）

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| **遥测（Axiom + PostHog，679 事件）** | ❌ | 埋点。源站 PostHog+Axiom |
| **联盟 / 归因（FirstPromoter/utm）** | ❌ | 源站 `campaign_link` |
| **注册反滥用（email/ip/fingerprint）** | ❌ | 源站 `signup_attempt` |
| **自定义快捷键** | ❌ | `user_shortcut_preset` |
| **i18n（/zh /en）** | ❌ | UI 双语（我们默认中文）|
| **dockview 可拖拽面板布局** | 🟡 | 有固定分隔条+localStorage，非完整 dockview。源站 dockview |
| **反馈组件** | ❌ | 报告问题/评分 |

---

## 建议实现顺序（优先级）

**P0 地基（不做后面都虚）**
1. ✅ 工程持久化（IndexedDB）+ 多工程 + 仪表盘
2. ✅ propose→apply 交互契约
3. 🟡 通用媒体导入 + 视频 item 已完成；媒体池基础完成，管理能力待补

**P1 补齐 NLE 核心**
4. 🟡 多时间线/序列待完成；轨道管理部分完成
5. 🟡 刀片/吸附和现有动画模型已完成；ripple 待补
6. 🟡 转场和特效已完成基础版本；标记已完成，复杂 GLSL 效果待补

**P2 生成矩阵（护城河，接 API）**
7. 统一 job 队列 + 积分计量骨架
8. 配音 TTS（有样本，最好接）→ 图片 → 视频 → 音乐/音效 → 着色器生成
9. 设计风格/品牌套件

**P3 交付 & 平台**
10. 导出扩充（srt/xml/audio/ProRes/WebCodecs/异步）
11. 鉴权 + 计费 + 门控
12. 协作/分享/实时同步；技能系统；多模态自检；MCP server

**P4 增长/长转短高级**
13. auto-reframe 主体跟踪；智能切片；场景引导；roadmap；遥测；i18n

> 说明：本文档是「对标源站」的全量差集，不代表全都要做。核心复刻价值在 P0–P2；P3–P4 是「产品化/平台化」，按需取舍。
