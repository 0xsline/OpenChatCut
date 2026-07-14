# ChatCut 复刻 · 功能覆盖 TODO（对标源站全量清单）

> 逐项对照逆向资料（`~/Desktop/project/chatcut-reverse/`：52 工具规格 / PRD / architecture_findings / deep_mining / 页面清单 / 缺口清单）与本仓库（`chatcut-clone/`）当前实现。
>
> **图例**：✅ 已实现 · 🟡 部分实现 · ❌ 未实现
>
> 每个 🟡/❌ 项给：**怎么做 / 用什么技术 / 对应源站**。初始生成于 2026-07-13；状态于 2026-07-14 从 `feature-coverage.html` 同步。

当前共 **133** 项：✅ 已实现 **51** · 🟡 部分实现 **23** · ❌ 未实现 **59**。按“已实现=1、部分实现=0.5”计算，路线图覆盖率为 **47.0%**。

---

## 0. 总览打分

| 域 | 状态 |
|---|---|
| 编辑器核心 / 时间线 | 🟡 源站 Dock 树（AI 贯穿、时间线仅跨素材+预览）、工具栏、轨道头、波形视觉、素材面板、动态轨道 / `edit_track` 与角色闪避已完成并经浏览器回归；Ripple、真实峰值与 Viewer 直接操控仍待补 |
| MG 模板 | ✅ 基本完整（211+生成+沙箱），缺属性面板/设计风格 |
| 转写 / 文字稿编辑 | 🟡 核心在（删词=删视频/静音压缩）且 `timeline.md` / `read_script` / `apply_script` 已完成；仍缺 av_script、校正和完整变体体系 |
| 字幕 | 🟡 源站 21 个样式预设、轨道头 CC 下拉、卡拉OK、跟随与双语翻译已完成；缺逐词覆盖/多轨源路由 |
| AI 生成（视频/图/配音/音乐/音效/着色器）| 🟡 图/视频/配音/音乐/音效已接 provider 适配层并完成本地浏览器联调；音乐/视频已接统一异步 job + `track_progress`。生成文件和媒体池资产立即持久化，落轨操作继续进入可拒绝的提案，缺真实供应商凭据实测、着色器、持久队列/积分计量 |
| 导出 | 🟡 MP4 服务端渲染 + srt/txt 同步导出已完成；缺 xml/audio/ProRes/WebCodecs/异步job |
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
| 撤销/重做 | ✅ | 快照式 history，最多保留最近 100 个工程快照；挂载转写也进入 history，可一次撤销 |
| 拖拽移动 / 裁剪（trim 手柄）/ 跨轨约束 | ✅ | `Timeline.tsx` pointer 拖拽 |
| 时间轴横向缩放 🔍 / 竖向轨道缩放 Alt+滚轮 | ✅ | zoom/trackScale 状态；播放头和时间码改为局部 DOM 绘制，根 `Editor`/Inspector/素材库不再随 `frameupdate` 逐帧重渲。浏览器 3 秒 MG 实测 p95 17.4ms、最大 17.6ms、长任务 0，见 `design-qa.md` |
| 时间线上下拖高 + 加权轨道高度 | ✅ | `cc.timelineH` + WEIGHT；按源站 Dockview 树改为只跨 Assets + Viewer，AI 列贯穿到底；使用源站式 sticky 轨道头、工具分组、片段配色、音频波形视觉与右下反馈入口 |
| **多时间线/序列（每工程多条）** | ✅ | `ProjectDoc V2` 已包含 `timelines[] + activeTimelineId`；底部 Tab 支持切换、新建、复制、重命名、删除、隐藏和一键 9:16 竖屏副本，旧工程自动迁移；Agent 已接 `manage_timelines` |
| **轨道管理（增删/改序/角色/锁/隐/静音/收紧）** | ✅ | 稳定轨道 id + 动态 V/A 别名；创建、空轨删除、排序、命名、anchor/follower 角色、锁定、折叠、隐藏、静音与 tighten 均已完成；删除护栏保证至少各留 1 条视频/音频轨，显式空轨序列不再回退出幽灵 V/A 轨；旧工程自动迁移，Agent 已接源站式 `edit_track` |
| **刀片工具(B)/修剪工具(N)/吸附** | ✅ | 刀片按钮/B 键在播放头切分，切口 `srcInFrame` 递进；拖拽/裁剪可吸附到 0、播放头和邻近片段边 |
| **Ripple 编辑（插入/覆盖模式）** | 🟡 | 已有波纹删除（同轨后续片段左移合缝）和修剪模式下右边缘联动位移；仍缺把 insert/overwrite 统一接到素材落轨、拖拽、粘贴、move/add 和 Agent `edit_item` 参数 |
| **片段变换（缩放/位置/旋转）** | ✅ | `ClipTransform {scale,x,y,rotation}` 通过 `ClipWrapper` 应用 CSS transform；属性面板提供缩放、位置、旋转滑块 |
| **动画/关键帧（源真相：无通用 K 帧）** | ✅ | MG 使用 `interpolate`/`spring`/bezier；`builtin:zoom` 提供参数化缩放动画；`ReframeCurveV1` 提供焦点与倍率稀疏关键帧 |
| **更多媒体类型：image / gif / svg / text / solid** | 🟡 | image、video、text 已完成；gif、svg、solid 待补。text 支持内容、字号、颜色、对齐和字重 |
| **视频素材片段（video item）** | ✅ | 导入真视频并通过 `<OffthreadVideo>` 预览和导出 |
| **特效（blur/zoom/mosaic/CRT/ASCII…）** | ✅ | 9/9 个已定位源特效均已接入 WebGL：luma-key、local-mosaic、magnify、rect/circle-mask、CRT、shake、tilt-shift 与 **ASCII Rain**。ASCII Rain 使用源站 4-pass DAG；运行时可把多个特效的局部 pass graph 重编号后串成有序栈。Inspector 支持追加、移除、上下排序、逐项调参和 ASCII RGB 颜色；`manage_effects` 同步支持 effectId 定位的栈操作 |
| **转场（cross-dissolve/dip/whip-pan/zoom/slide/luma…）** | ✅ | 12/12 均使用从线上 bundle 抽出的源 GLSL：交叉溶解、黑场、柔化擦除、甩镜、闪白、亮度混合、page-curl、rack-focus、organic-dissolve、impact-shake、charge-zoom、clean-swipe。图片/视频走 WebGL；DOM/MG/text 走 6 个可表达转场的 CSS fallback，其余安全回退溶解 |
| **标记 markers（点/段批注）** | ✅ | 支持点/区间标记、批注、8 色、跳转和标记帧吸附；源站 `manage_markers` |
| **色度键 / 绿幕（chroma key）** | ❌ | 对 video item 做颜色抠像。做：WebGL shader 抠指定色。源站 `chroma` |
| **变速 / 重定时（variable speed）** | 🟡 | 有 set_item_timing 改时长，无保音调变速。做：item 加 `playbackRate`，`<Audio>/<Video>` 用 `playbackRate` + 时间线时长按 rate 换算（源站 caption 的 `dH` 已含 playbackRate 语义）|

## 3. 音频处理

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| 音频片段 + 音量 | ✅ | `<Audio volume>` |
| **淡入淡出（fadeIn/Out 秒）** | ✅ | `fadeInFrames`/`fadeOutFrames`：视觉通过 `ClipWrapper` opacity，音频通过 volume 函数处理；属性面板按秒调节 |
| **响度归一化（-14 LUFS）** | ❌ | 分析音频 RMS/LUFS → 增益。做：Web Audio `AnalyserNode` 离线算，或导出后 ffmpeg `loudnorm`。源站 `normalize`/`loudness` |
| **自动闪避 ducking（music 遇 voice 降）** | ✅ | anchor 轨活动区间驱动 follower 轨动态降音量；默认 -12 dB，支持 `audioRouting.duckDepthDb` 手动深度，独立 Audio 与视频内嵌音频均生效 |
| **AI 降噪 / 人声隔离** | ❌ | `denoised_audio_asset`。做：接 **DeepFilterNet3**（开源 Rust，可本地跑 wasm/服务端）产一条降噪 wav，item 可切换源。源站 `isolate_voice` |
| **旁白录制（麦克风）** | 🟡 | 工具栏 mic 已接 `getUserMedia + MediaRecorder`，停止后导入媒体池并落到播放头处 A1；仍缺录后自动转写、设备/倒计时设置及 Camera/Screen 模式 |

## 4. 转写 / 文字稿编辑

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| AssemblyAI 词级转写 + 说话人分离 | ✅ | `transcript/assemblyai.ts`，speaker_labels |
| 段落/片段视图 + 说话人标签 + 轨道选择 | ✅ | `TranscriptPanel` |
| 删词=删视频（keptSegments 重排）| ✅ | `transcript/edit.ts` |
| 静音压缩 + 去填充词（clean_script）| ✅ | `maxGapFrames` + `fillerIndices` |
| find_transcript 定位短语→帧位 | ✅ | agent 工具 |
| **timeline.md / read_script / apply_script（改文本即改片）** | ✅ | `src/script/` 已实现 `[sN]/[cN]/[gap]` Markdown 序列化、删词/删行/移行 diff、行序重排、stale stamp 守卫和原子提案提交，并有 check 与 Agent E2E；v1 暂不支持素材内片段重放 |
| **read_av_script（结构化音视频脚本）** | ❌ | agent 的结构化剪辑表示。做：把时间线导成 agent 可读的 AV 脚本文本。源站 `read_av_script` |
| **转写校正（改文本）** | ❌ | 编辑器里改错字，词↔帧映射不变。源站 `manage_transcript` content/json |
| **多语言转写变体（共享时间轴）** | 🟡 | 有双语字幕（短语级译文），无完整 transcript 变体体系。做：`transcript(source) 1—N variant(lang)`，字幕/双语选变体显示。源站 `transcription_sub_asset`(variant_group) |
| 说话人重命名 / 合并 | ❌ | 面板里改 speaker 名、合并两说话人。源站转写编辑 |

## 5. 字幕

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| 字幕 overlay（源站 21 个样式）| ✅ | `CaptionsLayer` + `captions/styles.ts`；字体、字号、描边、阴影、逐词高亮背景及每页词数均取自源站 bundle |
| 卡拉OK逐词高亮 + pacing 词/短语 | ✅ | activePage/currentWordIndex |
| 字幕随编辑重排（retime）| ✅ | `retimeWords`（源站 dVe/fVe/dH 模型）|
| 双语字幕（译文第二行）| ✅ | `captions/translate.ts` |
| 烧录进导出 | ✅ | 合成内渲染 |
| **样式预设扩充（Persona/Bubble Pop/Submagic/Noir…）** | ✅ | 轨道头 CC 下拉已按源站顺序接入 21 个预设和 8 种字幕翻译语言；样式选择直接作用于预览/导出。证据 `qa-caption-style-menu.png` |
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

## 8. AI 生成（花钱域）

> 全部对标源站 §8 `submit_*`（异步 job + 积分门控）。当前已完成 5 个 provider 适配层、服务器密钥隔离、生成文件入库与 Agent 工具接线；音乐/视频已统一为提交即返 `jobId`，再由 `track_progress` 的 params/status/wait 幂等落入媒体池。生成文件与 `addAsset` 作为不可回滚副作用立即写入媒体池，时间线落轨仍留在 proposal 中，拒绝提案不会遗失已生成素材。真实供应商凭据、进程外持久队列、其余生成类型异步化与积分计量仍待补。

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| **AI 视频生成** | 🟡 | `submit_video` 已接火山方舟 **Seedance 2.0** 与 **Kling V3 Omni**：文/图/参考生成、首末帧、3/4–15s、Kling customize/intelligence 多镜头；提交立即返 `jobId`，由 `track_progress` 等待后幂等下载入媒体池。浏览器 mock 已验证两家、异步闭环且不自动落轨；待真实 key 实测 |
| **AI 图片生成** | 🟡 | `submit_image` 已接 OpenAI **gpt-image-2** / Gemini nano-banana（当前映射 `gemini-3.1-flash-image`），支持尺寸/比例/质量/参考图/多张并写媒体池+时间线；浏览器 mock 已验证两模型。待真实图片权限 key 实测 |
| **AI 配音 TTS** | 🟡 | `submit_voice` 已接火山 **Doubao Seed TTS 2.0** + **ElevenLabs**，支持两家专属参数、ffprobe 时长与 35 个试听样本；浏览器 mock 已验证两家且仅入媒体池。待真实供应商 key 实测与 voice 选择卡 |
| **AI 音乐生成** | 🟡 | `submit_music` 已接 **Mureka** `/v1/instrumental/generate`，提交立即返 `jobId`，由 `track_progress` 等待 provider task 后幂等下载入媒体池；兼容 `audio_url/url/wav_url/flac_url`。浏览器 mock 已验证异步闭环；待真实 key 实测 |
| **AI 音效生成** | 🟡 | `submit_sound` 已接 **ElevenLabs Sound Effects**，支持时长/`promptInfluence`、ffprobe 时长、仅入媒体池；浏览器 mock 已验证。待真实 key 实测 |
| **着色器生成（转场/特效）** | ❌ | `submit_shader`；Gemini→GLSL/TS，产 `EffectProcessor`/`TransitionProcessor` 子类，**必须编译校验+沙箱**（同 MG）|
| **任务队列 + 轮询 + 积分计量** | 🟡 | 音乐/视频已共享进程内 generation job，支持 `track_progress` params/status/wait、失败状态和成功结果幂等入库。待改为进程外持久队列、覆盖图片/配音/音效，并接 `api_usage.service` 按供应商计费。源站 G3/G4 |

## 9. 素材 / 媒体

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| 音频素材库（3 音乐+voice）| ✅ | `audio/library.ts` |
| MG 模板库（211）| ✅ | 内置 JSON |
| **通用媒体导入（上传视频/图/音）** | ✅ | 上传端点 `vite-plugin-upload` 写入 `public/media/uploads`，客户端探测时长/尺寸，预览与导出同源 |
| **媒体池（文件夹/搜索/排序/收藏/网格）** | ✅ | `ProjectDoc V2` 工程级共享素材池与文件夹树已完成：上传/拖拽、全库搜索、类型筛选、名称/时长/导入顺序排序、收藏、网格/列表、多选批量移动/落轨、文件夹新建/重命名/空目录删除、素材重命名；旧工程自动迁移。UI 已对标源站的 3 列卡片、单行搜索/上传/目录/视图/排序/筛选工具栏和滚动密度。Agent 已接源站同名 `manage_media_pool`；浏览器在 10 素材工程完成交互与视觉回归并清理测试数据 |
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
| **导出字幕文件（srt/txt）** | ✅ | `submit_export format=subtitles`：从当前 caption words/phrase/双语 cue 生成 UTF-8 SRT 或 TXT，支持帧/秒范围、同步下载与安全文件名；已在浏览器用真实转写字幕端到端验证 |
| **导出音频（mp3/wav）** | ❌ | renderMedia codec=mp3，或 ffmpeg 抽音轨。源站 audio tab |
| **导出 XML → Premiere/DaVinci（fcpxml）** | ❌ | 时间线序列化成 FCPXML 方言 + MG 作 ProRes 引用。源站 `nleFormat` fcp_xml/fcp_xml_resolve —— 长转短交付口 |
| **浏览器端 WebCodecs 快导** | ❌ | 轻量导出走 `VideoEncoder`+muxer（不经服务端 Chrome）。源站 in-browser 快路径 |
| **异步渲染 job + 轮询（track_export）** | ❌ | 现同步阻塞。做：导出入队列返 renderId，前端轮询进度。源站 `track_export` + Remotion Lambda |
| **部分导出（帧范围）** | 🟡 | 字幕导出已支持 `startFrame`/`endFrameExclusive`（及秒兼容）并归零时间码；MP4/audio 的 renderMedia frame range 仍待补 |
| **字体兜底确认（confirmFontFallback）** | 🟡 | 已加载常用字体；无「不支持字体清单→二次确认」门。源站 §10 |
| **免费档水印** | ❌ | 合成加水印层（按 plan）。源站 `updateWatermark` |
| **导出历史 + 渲染后评分** | ❌ | `export_history` 表 + 反馈。源站 |

## 11. Agent / 对话平台

| 功能 | 状 | 怎么做 / 技术 / 源站 |
|---|---|---|
| Anthropic 原生 tool-use（可换真 Claude 一行）| ✅ | `agent/`，现跑 grok 中转 |
| 流式输出（text/thinking）| ✅ | `messages.stream` |
| ~19 个工具（读/加/改/转写/字幕/删词/比例）| ✅ | `tools.ts`+`transcript-tools.ts` |
| **propose → review → apply（提案审阅再落地）** | ✅ | Agent 先在草稿态执行结构编辑并生成 proposal；`ProposalCard` 支持逐操作勾选、预览、应用和拒绝，批准后作为一次原子提交，可一次 undo；提案保存完整 `baseDoc`，待审期间工程一旦变化会拒绝 stale 回放并要求重试 |
| **多轮会话持久化（session/reset/max_turns）** | 🟡 | 有循环，无会话存储。做：`chat_block` 有序存对话；reset/继续。源站 `sdk_session` |
| **@ 引用素材进对话** | ✅ | 媒体池和模板库引用以稳定 `id + kind` 保存，发送时解析为结构化 `chat_context_entry`（素材含 src/尺寸/时长，模板含分类/尺寸/props）；显示名只负责 UI，不参与资源寻址，删除 @ 文本会同步移除引用 |
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
3. ✅ 通用媒体导入 + 视频 item + 工程级媒体池管理已完成

**P1 补齐 NLE 核心**
4. ✅ 多时间线/序列、动态轨道 / `edit_track` 与角色闪避已完成
5. 🟡 刀片/吸附、波纹删除和右修剪联动已完成；insert/overwrite 全链路仍待补
6. ✅ 12 个源转场 GLSL、9 个源 WebGL 特效（含 ASCII Rain 4-pass DAG）、有序特效栈与颜色参数、标记均已完成

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
