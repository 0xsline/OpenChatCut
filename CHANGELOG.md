# Changelog / 更新日志

All notable changes to OpenChatCut are documented here.  
OpenChatCut 的重要变更记录在此。

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/).  
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] / [未发布]

### Added / 新增

- Added first-class ChatGPT subscription sign-in for the built-in Agent through the official Codex CLI, including isolated credential storage, browser/device-code OAuth, account and model discovery, model switching, and dynamic OpenChatCut tool calling. Claude Code subscriptions remain available through the existing local MCP connection without exposing Claude OAuth credentials.
  新增基于官方 Codex CLI 的内置 Agent ChatGPT 订阅登录：支持隔离凭据存储、浏览器/设备代码 OAuth、账号与模型发现、模型切换及 OpenChatCut 动态工具调用。Claude Code 订阅继续通过既有本机 MCP 连接使用，无需向 OpenChatCut 暴露 Claude OAuth 凭据。
- Added first-class Ollama and LM Studio Agent providers with configurable local endpoints, optional API keys, model discovery, and explicit model activation.
  新增 Ollama 与 LM Studio Agent 厂商：支持配置本地端点、可选 API Key、模型发现，并仅在明确保存模型后激活。
- Added validated 4K video export across browser and server render paths, producing a 2160-pixel short edge (`3840×2160` for 16:9 projects) with matching bitrate and quality-check expectations.
  新增经校验的 4K 成片导出，覆盖浏览器与服务端渲染链路；短边输出 2160 像素（16:9 工程为 `3840×2160`），并同步适配码率与质量检查预期。
- Added professional timeline workflows: slip and rate-stretch modes, insert/overwrite placement, atomic multi-clip Inspector edits, nested sequences, source timecode, sync-lock groups, and persistent multicam range switching.
  新增专业时间线工作流：滑移与比率拉伸模式、插入/覆盖落轨、多片段属性原子编辑、嵌套序列、源时间码、同步锁定组，以及可持久化的多机位区间切换。
- Added durable generation and export jobs with refresh recovery, exact-first reruns, provider/reference preflight, editor-level background export state, cancellation, and structured terminal failures.
  新增可恢复的生成与导出任务：支持刷新续跑、精确优先重跑、厂商/引用预检、编辑器级后台导出状态、取消及结构化终态错误。
- Added scene-aware visual and spoken media search, source-versioned semantic artifacts, cached VAD evidence, immutable voice-isolation artifacts, and resumable AssemblyAI jobs.
  新增镜头感知的视觉/口语素材搜索、按源版本管理的语义产物、VAD 证据缓存、不可变人声分离产物，以及可恢复的 AssemblyAI 任务。

### Changed / 变更
- Unified selectable creative workflows and bundled Agent skills around `SKILL.md` + `load_skill` progressive disclosure. External MCP clients can now load guidance without an edit session, and selected workflow bodies no longer occupy the cached system prompt.
  统一可选创作工作流与内置 Agent Skill，改用 `SKILL.md` + `load_skill` 渐进披露；外部 MCP 客户端无需编辑会话即可加载指引，选中工作流的正文也不再占用系统提示缓存。
- Unified timeline geometry around playback-rate-aware source-time/source-window helpers, with one transition-reconciliation pass shared by move, retime, split, trim, ripple, and overwrite operations.
  统一采用感知播放速度的源时间/源窗口计算，并让移动、重定时、切分、裁剪、波纹和覆盖操作共用同一转场校正流程。
- Made selected effect and transition previews use the same deterministic GL frame, progress, uniform, aspect, and color pipeline as export, with explicit fallback states when full parity is unavailable.
  选中特效与转场的预览现在与导出共用确定性的 GL 帧、进度、uniform、画幅和色彩管线；无法完整对齐时会明确显示回退状态。

- Virtualized large resource, media-pool, and timeline surfaces; thumbnails and media previews now activate only near the viewport or on hover, while timeline pointer work is frame-coalesced and magnetic snap points are cached for each gesture.
  对大型资源库、素材池与时间线实施窗口化；缩略图和媒体预览仅在接近视口或悬停时激活，时间线指针更新按帧合并，磁吸点也按单次手势缓存。
- Moved semantic duplicate detection into the existing worker with transferable typed vectors, and deferred Agent providers, tool executors, Google fonts, and the template compiler until their feature is used.
  将语义重复检测移入现有 Worker 并使用可转移类型化向量；Agent 厂商、工具执行器、Google 字体与模板编译器也改为功能实际使用时才加载。
- Bounded rebuildable browser/server caches and multipart sessions, added source-versioned preview derivatives and a cancellable preview-proxy queue, and kept user source media outside automatic eviction.
  为可重建的浏览器/服务端缓存与分片上传会话增加边界，加入按源版本失效的预览派生文件及可取消的预览代理队列，并确保用户源媒体不参与自动淘汰。
- Made editor panel geometry viewport-relative so browser zoom and window resizing preserve user-adjusted proportions, with compact container-driven layouts for dense controls.
  将编辑器面板改为视口比例布局，使浏览器缩放和窗口尺寸变化时仍保留用户调整的区域比例，并为密集控件加入基于容器宽度的紧凑布局。
- Reorganized the inspector into contextual Basic, Video, Audio, and Animation tabs; moved secondary media and timeline actions into compact menus, and made the asset action menu available from right-click.
  将属性面板重组为按上下文启用的基础、视频、音频和动画标签；把次级素材与时间线操作收纳进紧凑菜单，并支持右键打开素材操作菜单。
- Added deduplicated, retention-bounded automatic project versions after idle edits, at five-minute intervals, and before Agent-applied changes; manual named versions remain unbounded by automatic retention.
  新增去重且有保留上限的自动工程版本：编辑空闲后、每五分钟以及 Agent 应用改动前自动留档；手动命名版本不受自动保留上限影响。
- Added Auto, smaller-file, recommended, high-quality, and bounded custom video-bitrate controls across browser and server export paths.
  为浏览器与服务端导出链路新增自动、小文件、推荐、高质量及带边界校验的自定义视频码率控制。
- Clarified that inspector controls affect the selected timeline clip rather than its source media, and improved property hierarchy, numeric-field affordances, and keyframe-control states.
  明确属性面板编辑的是当前时间线片段而非源素材，并优化属性层级、数值输入辨识度与关键帧控件状态。
- Refined the export workbench with aligned parameter rows, restrained selected states, clearer format/codec language, and an output summary covering codec, dimensions, frame rate, bitrate, and filename.
  优化导出工作台：统一参数行对齐与选中态，澄清格式/编码语义，并在输出摘要中展示编码、尺寸、帧率、码率与文件名。
- Unified the Library panel tabs and nested-sequence list with compact typography, a restrained selection indicator, flat rows, and tabular duration metadata.
  统一资源面板标签与嵌套序列列表的紧凑排版，加入克制的选中指示、扁平列表行及等宽时长信息。
- Capped the Agent change-log dialog height and made its entry list independently scrollable with a fixed header and a scoped, visible scrollbar.
  限制 Agent 修改记录弹窗的最大高度，并让记录列表在固定标题栏下独立滚动，同时提供仅作用于该列表的清晰滚动条。

### Fixed / 修复

- Blocked Agent submission until the configured model catalog is hydrated, and retried one transient gateway/network failure only before any model output is emitted.
  Agent 现在会等待模型目录加载并确认已有可用模型后才允许发送；仅在模型尚未输出任何内容时，对瞬时网关/网络故障安全重试一次。
- Added BOM/CRLF-tolerant SRT import into independent named caption tracks, and streamed local ASR media from the server to AssemblyAI through a same-origin, JSON-only route without browser-side multi-gigabyte `Blob` materialization.
  新增兼容 BOM、CRLF 的 SRT 导入并创建独立命名字幕轨；本地 ASR 素材改由仅接受同源 JSON 请求的服务端路由流式上传至 AssemblyAI，避免浏览器构造数 GB `Blob`。
- Made editor panel dividers keyboard-focusable and arrow-key resizable while preserving compact responsive timeline controls without overlap.
  编辑器面板分隔条现可键盘聚焦并使用方向键调整大小，同时保持紧凑响应式时间线控件互不遮挡。
- Moved rendered frame files out of Chat Completions tool-result text and into native vision messages across OpenAI and compatible providers, preventing base64 payloads from exhausting the model context window during multi-step Agent edits; compatible models that reject visual input retry once with bounded text-only metadata.
  OpenAI 及兼容 Provider 的 Chat Completions 模式下，渲染帧文件不再作为工具结果文本传递，而会转换为原生视觉消息，避免多步 Agent 编辑因 Base64 内容撑爆模型上下文窗口；兼容模型若拒绝视觉输入，会使用有界纯文本元数据安全重试一次。
- Aligned server-export media materialization with the renderer-visible timeline closure, isolated the browser editor bridge behind a process-local credential, and bounded generated-result header and idle-body waits so stalled providers remain recoverable.
  服务端导出媒体物化现与渲染器可见时间线闭包一致；浏览器编辑器桥改用进程内独立凭据；生成结果下载也加入响应头与正文空闲截止时间，使厂商卡死时任务仍可恢复。
- Made browser/server export cancellation reach the encoder, renderer, and destination writer while preserving an already committed success; restored jobs now terminalize safely and use registered cleanup policies instead of unlinking untrusted result paths.
  让浏览器端与服务端导出取消信号贯穿编码器、渲染器和目标写入器，同时不再用迟到取消覆盖已提交成功；恢复任务会安全进入终态，并只通过已注册清理策略处理结果，不再删除不可信路径。
- Made linked audio/video overwrite and split operations atomic, preserved transitions outside punched holes, validated transitions as unique binary seams, and corrected edited-transcript audio slip coordinates.
  将关联音视频的覆盖与切分改为原子操作，保留切洞外侧转场，把转场限制为唯一二元接缝，并修正编辑式转录音频的滑移坐标域。
- Hardened asynchronous voice isolation, multicam sync, generation, and media-derivative commits with live project/item/source revision checks and durable semantic operation IDs.
  为异步人声分离、多机位同步、生成和媒体派生提交加入实时工程、片段、源版本复核及持久语义 operation ID，避免重链或并发编辑后迟到结果回写。
- Made project-package publication transactional across browser and server storage, rejected HTML media fallbacks and cross-frame-rate nested sequences before export, and isolated a single MCP call cancellation from unrelated bridge calls.
  将工程包发布改为跨浏览器与服务端存储的事务流程；在导出前拒绝 HTML 媒体回退及跨帧率嵌套序列；单个 MCP 调用取消也不再级联终止同一桥上的无关调用。
- Restored cloud-only upload media from R2 before export, serialized concurrent hydrations, rejected HTML/non-media responses, and routed all remote probes through DNS/IP/redirect-pinned public fetches to block SSRF and rebinding.
  导出前可从 R2 恢复仅存在云端的上传素材，并串行合并同名并发回源；同时拒绝 HTML/非媒体响应，且所有远程探测都经过 DNS、IP、重定向与地址固定校验，阻断 SSRF 与 DNS 重绑定。
- Made ASR jobs unique by asset/revision/generation, prevented progressive import callbacks from double-submitting paid transcription, and kept stale transcripts reviewable without letting them drive playback, export, search, or edits.
  按素材、源版本和 generation 唯一协调 ASR，避免渐进导入回调重复提交付费转录；旧转录仍可审阅，但不再参与播放、导出、搜索或编辑。
- Corrected rational source-timecode conversion, playback-rate-aware multicam sync, and GL transition endpoint sampling; multicam now rejects mixed rates atomically and transition progress deterministically reaches both 0 and 1.
  修正有理数源时间码换算、感知播放速度的多机位同步及 GL 转场端点采样；多机位会原子拒绝混合速度，转场进度也确定性覆盖 0 与 1。
- Hardened project-index writes, MCP runtime hydration, durable open-job retention, and multi-result generation checkpoints so metadata cannot be lost, old bridges cannot overwrite new state, resumable work is never evicted, and partial Seedance/Mureka outputs cannot be published as complete.
  加固工程索引写入、MCP runtime hydration、未结束任务保留及多结果生成检查点，避免元数据丢失、旧桥覆盖新状态、可恢复任务被淘汰，以及 Seedance/Mureka 部分结果被误判为完成。

- Fixed Chromium export destination selection by using the save-file picker for single-file exports, reserving the directory picker for multi-file bundles, and invalidating stale file handles when the output filename changes.
  修复 Chromium 导出位置选择：单文件导出改用文件保存选择器，多文件打包才使用目录选择器，并在输出文件名变化时清除旧文件句柄。
- Serialized project saves through immutable snapshots, added close/switch flush barriers, and blocked destructive navigation after persistence failures.
  通过不可变快照串行化工程保存，加入关闭/切换前 flush 屏障，并在持久化失败后阻止破坏性导航。
- Rejected stale derived-media commits after relink, bound semantic/blob/ASR/generation outputs to source revisions, and staged project-package publication so failed imports never expose half-written projects.
  重链后拒绝旧派生产物回写，将语义、Blob、ASR 和生成结果绑定到源版本，并通过工程包分阶段发布避免失败导入暴露半成品。
- Bound MCP sessions to project/editor revisions, canceled queued and in-flight calls on timeout or transport close, and pruned expired sessions before request dispatch.
  将 MCP 会话绑定到工程/编辑器版本；超时或传输关闭时同时取消排队与执行中的调用，并在请求分发前清理过期会话。
- Preserved the committed revision across deferred React state updates so external MCP clients can observe `applied`, and rejected every cross-transport tool call carrying another client's `editSessionId`.
  在 React 延迟提交工程状态时保留真实已提交 revision，使外部 MCP 客户端可正确读到 `applied`；同时拒绝所有携带其他客户端 `editSessionId` 的跨传输工具调用。
- Added browser and server export-media preflight so missing media, invalid blob/local references, and nested-sequence errors fail before queueing or rendering.
  新增浏览器端与服务端导出媒体预检，使缺失素材、无效 Blob/本地引用及嵌套序列错误在排队或渲染前失败。
- Fixed preview stalls at transition boundaries by preserving the incoming media element after the transition completes instead of remounting and re-seeking it.
  修复预览在转场边界卡顿的问题：转场结束后保留已在播放的入场媒体元素，不再重新挂载并跳转。
- Balanced fixed-size resource-grid columns across the available panel width instead of leaving a large unused strip at the right edge.
  将固定尺寸的资源卡片列均匀分布到面板可用宽度，不再在网格右侧留下大块空白。
- Standardized timeline toolbar control spacing on a shared four-pixel rhythm while preserving clear separation between editing-tool groups.
  统一时间线工具栏控件的四像素间距节奏，同时保留编辑工具组之间的清晰分隔。
- Replaced duplicate two-line timeline track badges and names with one compact highlighted label: “视频1”/“字幕1” in Chinese and “V1”/“C1” in English.
  将时间线轨道头重复的两行徽章与名称合并为单个紧凑高亮标签：中文显示“视频1”“字幕1”，英文显示“V1”“C1”。
- Rounded variable-speed values for display and matched presets with a tolerance, preventing IEEE-754 noise such as `1.0000000000000004×` from leaking into clip context menus.
  对变速值进行显示舍入并以容差匹配预设，避免 `1.0000000000000004×` 等 IEEE-754 浮点噪声出现在片段右键菜单中。
- Serialized concurrent version mutations, retried failed automatic captures without dropping newer queued snapshots, and required a successful pre-change snapshot plus revision check before internal Agent edits are applied.
  串行化并发版本写入；自动留档失败后保留重试状态且不丢失已排队的新快照；内置 Agent 仅在修改前快照成功且工程版本未变化时才应用改动。
- Preserved requested bitrates during VP8/H.264 FPS retiming, including software-encoder fallback.
  在 VP8/H.264 帧率转换及软件编码回退中保留用户请求的码率。
- Kept compact media menus inside the viewport at narrow panel widths and completed keyboard focus, dismissal, and inspector-tab semantics for the reorganized controls.
  在窄面板下将紧凑素材菜单限制在视口内，并补全重组控件的键盘焦点、关闭行为与属性标签语义。

## [0.1.7] - 2026-07-29

### Added / 新增

- Added community resource packages with category-specific previews, creator and license metadata, review-ready exports, and install URLs shared by the website and editor.
  新增社区资源包：支持按分类生成预览、记录作者与许可证、导出可审核资源，并由官网与编辑器共用安装 URL。
- Added Extension Center discovery synced with the public resource catalog, plus URL/file installation and local enable, disable, and uninstall management.
  新增与官网资源目录同步的扩展中心发现页，并支持通过 URL 或文件安装，以及本地启用、停用和卸载管理。
- Added reusable resource export from the media pool so locally imported or Agent-generated assets can be packaged for contribution.
  新增从素材池导出可复用资源包，支持将本地导入或 Agent 生成的素材整理后投稿。
- Added first-run configuration guidance, direct media placement onto a chosen video track, contextual clip review comments, and expanded Agent review workflows.
  新增首次配置引导、将素材直接放入指定视频轨道、片段上下文评论，以及更完整的 Agent 审阅工作流。

### Changed / 变更

- Streamlined the resource library and Extension Center layouts, removed duplicate sample content, and documented the contribution and installation workflow in both READMEs.
  精简资源库与扩展中心布局，清理重复示例内容，并在中英文 README 中补充投稿与安装流程。
- Added Ko-fi and Afdian sponsorship links to the project documentation.
  在项目文档中新增 Ko-fi 与爱发电赞助入口。

### Fixed / 修复

- Installed URL packages now appear immediately in the Installed tab and remain manageable after reload.
  通过 URL 安装的扩展现在会立即出现在“已安装”页，并在重新加载后继续可管理。
- Fixed timeline drag feedback so the playhead guide remains visible while moving captions, video clips, and other timeline items.
  修复时间线拖动反馈，移动字幕、视频及其他片段时播放头参考线会保持可见。

## [0.1.6] - 2026-07-27

### Added / 新增

- Added an `undo_last_change` agent tool, so "undo that" works in chat. It restores the project state from before the last applied change as a normal proposed edit, meaning the user still confirms it and the revert itself stays undoable.
  新增 `undo_last_change` Agent 工具，在对话里说「撤销刚才那个」即可。它把上一步的工程状态作为一次普通提案编辑恢复，因此仍由用户确认，且这次回滚本身也可以再被撤销。
- Added per-track gap reporting to `read_project`, allowing the agent to find empty ranges without reconstructing them from every clip.
  `read_project` 新增逐轨空隙报告，Agent 无需遍历全部片段即可定位空白区间。
- Added precise Inspector controls with direct numeric entry, drag scrubbing, keyboard adjustment, and one-click resets while preserving keyframe-aware editing.
  检查器新增精确数值输入、拖拽微调、键盘调节与一键复位，同时保持关键帧感知的编辑行为。

### Changed / 变更

- Editing tools now report what actually changed on the timeline instead of a bare success, so the agent no longer has to re-read the whole project after every edit. Ripple moves collapse into rules (`track / fromFrame / by / count`) rather than listing every displaced clip, with created tracks, removed ids, and a re-read hint when a change is too large to enumerate.
  编辑类工具现在会回报时间线上实际发生的变化，而不只是「成功」，Agent 不必在每次编辑后重读整个工程。波纹位移压缩成规则（`track / fromFrame / by / count`）而不是逐条列出被推动的片段，另附新建轨道、被删片段 id，以及变更过多时的重读提示。
- Frame contact sheets now prefer moments where the picture actually changes, filling the rest with even sampling, so a locked-off shot no longer returns a grid of near-identical frames.
  帧联系表现在优先取画面真正发生变化的时刻，其余用均匀取样补齐；固定机位素材不会再返回一整版几乎相同的画面。
- Unified editor panel spacing, controls, typography, and state styling across the shell, library, media pool, preview, chat, timeline, and Inspector.
  统一编辑器壳层、资源库、素材池、预览、聊天、时间线与检查器的间距、控件、字体和状态样式。
- Kept the volatile timeline snapshot out of the cached Agent prompt prefix, improving prompt-cache reuse without changing project context.
  将频繁变化的时间线快照移出 Agent 提示词缓存前缀，在不丢失工程上下文的前提下提高缓存复用率。

### Fixed / 修复

- Fixed FCPXML export writing unusable media paths: `/media/uploads/<name>` was emitted verbatim as `file:///media/uploads/<name>`, pointing at the filesystem root, so every clip imported into DaVinci Resolve or Final Cut was offline. Assets now resolve against the real media directory (honoring `MEDIA_DIR`) with per-segment URL encoding, so non-ASCII and spaced filenames relink correctly.
  修复 FCPXML 导出的素材路径不可用:`/media/uploads/<名字>` 被原样写成 `file:///media/uploads/<名字>`(指向文件系统根目录),导入达芬奇或 Final Cut 后每条素材都是离线的。现按真实素材目录(遵循 `MEDIA_DIR`)换算为绝对路径并逐段 URL 编码,中文与含空格的文件名也能正确重链。
- Fixed FCPXML export flattening transcript-edited audio into one contiguous clip: deleted words came back in the NLE and the material after them was lost. Audio clips now export one clip per kept segment, sharing the same `keptSegments` source of truth as playback. Video clips keep playing continuously through word deletions, so they stay a single clip.
  修复 FCPXML 导出把文字稿编辑过的音频压成单段连续片段:被删掉的词会在 NLE 中重现,其后的内容整段丢失。音频片段现按保留段逐段导出,与播放层共用同一个 `keptSegments` 真源;视频片段的删词不改画面,仍保持单段。
- Fixed Agent generation, progress, aborted-turn history, and media inspection paths so partial replies survive cancellation, image references retain their real MIME type, and frame extraction failures are surfaced and recovered consistently.
  修复 Agent 生成、进度、停止后的历史记录与媒体检查链路：取消时保留已有回复，图片引用保持真实 MIME 类型，抽帧失败能够一致地报告并恢复。
- Fixed generated-result downloads by retrying transient failures and retaining the remote URL when local persistence still fails.
  修复生成结果下载：短暂失败会自动重试，本地持久化仍失败时保留远端 URL。
- Fixed editor persistence and media lifecycle edge cases: pending autosaves now flush when leaving, and cleanup no longer deletes uploads still referenced by a project.
  修复编辑器持久化与素材生命周期边界：离开编辑器时写入待处理自动保存，清理任务也不再删除工程仍在引用的上传素材。
- Fixed invalid timeline state by healing out-of-range fades and keyframes on load, and by keeping edits within clip duration, source media, and cut boundaries.
  修复非法时间线状态：载入时修正越界淡入淡出与关键帧，编辑时保证片段不超出自身时长、源素材和切割边界。
- Fixed slider drags creating excessive undo steps and exposed keyframe controls only where the selected item supports them.
  修复滑杆拖动生成过多撤销步骤的问题，并仅在选中项支持时显示关键帧控件。
- Fixed semantic media search returning duplicate or weak matches by deduplicating results per asset and applying a relevance floor.
  修复语义素材搜索返回重复或低相关结果的问题，现按素材去重并过滤弱匹配。

## [0.1.5] - 2026-07-27

### Fixed / 修复

- Fixed Gemini rejecting agent tool calls with 400 "missing a thought_signature in functionCall parts": thought signatures captured from responses were stored under one provider key but replayed from another, so multi-step tool loops always failed on the second request. Signatures now round-trip end to end (verified against the live Gemini API).
  修复 Gemini 在多步工具调用中报 400 "missing a thought_signature in functionCall parts":响应里捕获的思维签名与重放读取的键不一致,循环第二跳必失败。现签名全程往返(已用真实 Gemini API 验证)。
- Fixed tool schemas using numeric enums (sample rate, bitrate, channels, fps) being rejected by the native Gemini API; the allowed values now live in field descriptions with unchanged integer typing for every provider.
  修复工具 schema 的数字枚举(采样率/码率/声道/帧率)被 Gemini 原生 API 拒收;允许值改写入字段描述,整数类型对所有厂商保持不变。
- Fixed the legacy single-provider config migration grafting the old generic Base URL onto whichever provider is currently selected: providers with any of their own configuration are no longer touched, so switching providers can no longer silently reroute requests to an old relay.
  修复遗留单厂商配置迁移会把旧的通用 Base URL 盖给当前选中厂商的问题:已有任一专属配置的厂商不再被迁移,切换厂商不会再被静默改道到旧中转。

### Changed / 变更

- Switched Gemini, Kimi, Qwen, DeepSeek, and Mistral to their official AI SDK provider packages (`@ai-sdk/google`, `@ai-sdk/moonshotai`, `@ai-sdk/alibaba`, `@ai-sdk/deepseek`, `@ai-sdk/mistral`). Gemini now speaks the native API (`x-goog-api-key`, model-scoped paths) with thought signatures handled by the official provider; a custom Gemini Base URL must now point at a native API root (…/v1beta), not an OpenAI-compatible one. Providers without an official package (GLM, MiniMax, Xiaomi, OpenRouter) stay on `@ai-sdk/openai-compatible`.
  Gemini、Kimi、Qwen、DeepSeek、Mistral 切换到官方 AI SDK 专属包（`@ai-sdk/google`、`@ai-sdk/moonshotai`、`@ai-sdk/alibaba`、`@ai-sdk/deepseek`、`@ai-sdk/mistral`）。Gemini 改走原生 API（`x-goog-api-key`、按模型出路径），thought signature 由官方 provider 处理；自定义 Gemini Base URL 现在需填原生 API 根（…/v1beta）而非 OpenAI 兼容端点。无官方包的厂商（GLM、MiniMax、小米、OpenRouter）继续走 `@ai-sdk/openai-compatible`。

### Added / 新增

- Added an `apply_layout` agent tool that arranges clips into named layouts — split screen, thirds, grid-4, picture-in-picture, and full-frame reset — computing non-stretching cover crops per slot in one undoable step, backed by a new crop primitive on clip transforms.
  新增 `apply_layout` Agent 工具：分屏、三分、四宫格、画中画与整幅复位等命名布局一步摆位（cover 不拉伸），底层为片段变换新增裁切基元，单次可撤销。
- Added a `remove_silence` agent tool that removes dead air on-device — a speech-relative level gate with breathing-room padding that never cuts music beds — ripple-closing gaps per track in one undo step, with a dry-run preview.
  新增 `remove_silence` Agent 工具：本机按「相对本段语音电平」检测死气段（留呼吸口，不切音乐床），同轨波纹闭合、一次撤销，支持 dryRun 预览。
- Added an in-app external MCP connection guide on the dashboard and editor top bar, showing the live endpoint with copy-ready setup for Claude Code, Codex, Cursor, and Claude Desktop.
  工程首页与编辑器顶栏新增外部 MCP 接入指南，显示实际端点并提供 Claude Code / Codex / Cursor / Claude Desktop 的一键复制配置。
- Added an `inspect_color` agent tool that measures a frame by the numbers — luma black/white points, clipping percentages, warm-cool and green-magenta balance per luma band, saturation, and a 12-bin hue histogram — so the agent grades against measurements instead of eyeballing screenshots.
  新增 `inspect_color` Agent 工具：量化单帧的黑白点、溢出比例、分段暖冷/绿品平衡、饱和度与 12 档色相直方图，让 Agent 按数字调色而非目测截图。
- Added a `detect_beats` agent tool with an on-device DSP beat tracker (no model download): bpm, confidence-gated beats and 4/4 downbeats in source seconds, timeline-frame mapping through clip trim and speed, and optional one-step beat/downbeat markers for music-synced cuts.
  新增 `detect_beats` Agent 工具：本机 DSP 节拍检测（无需下载模型），输出 BPM、按可信度守门的拍点与 4/4 强拍（源秒），可经片段裁剪与变速映射到时间线帧，并一步落节拍标记用于卡点剪辑。
- Added a colorist-grade GLSL effect suite: three-way color wheels (lift/gamma/gain), levels (per-channel in/out points + gamma), highlights/shadows recovery, clarity (local-contrast unsharp), and an HSL qualifier (hue-ring secondary with hue shift / saturation / luma controls).
  新增专业调色 GLSL 套件：三路色轮（lift/gamma/gain）、色阶（分通道黑白场 + gamma）、高光/阴影恢复、清晰度（局部对比）与 HSL 限定器（色相环二级校色，可移色相/调饱和/调亮度）。
- Added volume keyframes for audio and video clips: the pen tool draws a 0–200% volume envelope directly on audio clips (drag points, right-click to delete), the inspector volume slider gains a keyframe rail, and `edit_item` accepts a `volume` keyframe channel — keyframes split, retime, and persist like every other channel.
  新增音量关键帧：钢笔工具可直接在音频片段上绘制 0–200% 音量包络（拖点改值、右键删点），检查器音量滑杆带关键帧轨，`edit_item` 支持 `volume` 关键帧通道——与其他通道一样随切割/变速/持久化。
- Added a `change_cam` agent tool for multicam switching: within a time range it keeps the target angle and removes the overlapping segments of the other listed angles (split at the bounds, no ripple, one undoable batch), warning when the target does not cover the whole range.
  新增 `change_cam` Agent 多机位切换工具：在指定区间内保留目标机位、移除其他机位的遮挡段（边界切割、无波纹、单次可撤销），目标覆盖不全时给出警告。

## [0.1.4] - 2026-07-26

### Added / 新增

- Added Xiaomi MiMo as a built-in OpenAI-compatible Agent provider.
  新增小米 MiMo 内置 OpenAI-compatible Agent 供应商。
- Added a Linux x64 AppImage desktop build to the release pipeline.
  发布流水线新增 Linux x64 AppImage 桌面构建。

### Fixed / 修复

- The collapsed thinking block now also recognizes inline `<think>` tags streamed by DeepSeek, MiniMax, GLM, Qwen, MiMo, and relays, in addition to `<thinking>`, uniformly across all providers.
  折叠的思考过程块除 `<thinking>` 外，现在也识别 DeepSeek、MiniMax、GLM、Qwen、MiMo 及各类中转以内联 `<think>` 标签输出的推理，对所有供应商统一生效。
- The desktop app now falls back to a random port when 5199 is taken instead of failing to launch; external MCP clients should use the origin from the startup log in that case.
  5199 端口被占用时，桌面端现在回退到随机端口而不是启动失败；此时外部 MCP 客户端请改用启动日志中的实际地址。
- Dragging a caption cue now clamps against its lane neighbors instead of overlapping them, and a cue dragged into a gap smaller than its own duration snaps back to its original position.
  拖动字幕片段现在会贴齐同 lane 邻居而不再重叠；拖进小于自身时长的间隙时会回弹到原位。

## [0.1.3] - 2026-07-23

### Added / 新增

- Added independent caption tracks, multiple caption tracks per sequence, manual caption creation, and track-type selection when creating a track.
  新增独立字幕轨道、单序列多字幕轨、新建手动字幕，以及新建轨道时选择轨道类型。
- Added direct caption editing in the preview and timeline, including dragging a caption style onto the preview, moving captions, and trimming both edges.
  新增在预览与时间线中直接编辑字幕，支持将字幕样式拖入预览、移动字幕及拖动两端调整时长。
- Added a PR-style Rate Stretch tool that preserves the source range while changing clip duration and playback speed.
  新增 PR 风格的比率拉伸工具，在保持源区间的同时改变片段时长与播放速度。
- Added model-aware Agent parameters and provider validation for image, video, music, sound, and voice generation, including expanded MiniMax and Mureka support.
  新增面向图片、视频、音乐、音效与语音生成的模型级 Agent 参数及供应商校验，并扩展 MiniMax 与 Mureka 支持。
- Added OpenRouter as a built-in OpenAI-compatible Agent provider.
  新增 OpenRouter 内置 OpenAI-compatible Agent 供应商。

### Changed / 变更

- Moved standalone caption styling and manual editing into the dedicated Captions workspace, with a direct “Caption styles” entry from Transcript.
  将独立字幕样式与手动编辑集中到“字幕”工作区，并在“文字稿”中新增“字幕样式”快捷入口。
- Improved local transcription source recovery by falling back to IndexedDB media and the original clip when extracted audio is unavailable.
  改进本地转写素材恢复：提取音频不可用时会回退到 IndexedDB 素材及原始片段。
- Added Ctrl/Command + mouse-wheel zoom to the motion-tracking target picker.
  为运动跟踪目标选择器新增 Ctrl/Command + 鼠标滚轮缩放。

### Fixed / 修复

- Fixed `promptOptimizer` being sent to non-MiniMax image models; it is now emitted only for MiniMax `image-01`.
  修复向非 MiniMax 图片模型发送 `promptOptimizer` 的问题；该参数现在仅用于 MiniMax `image-01`。
- Fixed Agent thinking content rendering raw Markdown instead of formatted, collapsible content.
  修复 Agent 思考过程直接显示 Markdown 原文而未格式化、折叠的问题。
- Fixed motion-tracking previews opening on a black first frame for affected videos.
  修复部分视频打开运动跟踪时预览停在黑色首帧的问题。
- Fixed imprecise floating-point playback-speed labels and clarified exiting Rate Stretch mode.
  修复播放速度显示浮点精度异常的问题，并明确比率拉伸模式的退出方式。

## [0.1.2] - 2026-07-21

### Added / 新增

- Added WebCodecs-accelerated browser video export with live progress, cancellation, and automatic fallback to the compatible server renderer.
  新增基于 WebCodecs 的浏览器加速视频导出，支持实时进度、取消操作，并在不兼容时自动回退服务端渲染。
- Added multi-provider stock search across Pexels, Pixabay, Unsplash, and Freesound with media type, orientation, category, platform, deduplication, and partial-result handling.
  新增覆盖 Pexels、Pixabay、Unsplash 与 Freesound 的多平台素材搜索，支持媒体类型、方向、分类、平台筛选、去重及部分结果返回。
- Added richer Agent editing controls for track-scoped scripts and captions, timeline frame and marker targeting, exact template placement, voice-isolation attachment, and structured follow-up widgets.
  新增更丰富的 Agent 剪辑能力，包括轨道级脚本与字幕、时间线帧和标记定位、模板精确放置、人声隔离挂载及结构化追问组件。
- Added reusable Motion Graphic exports as ProRes 4444 MOV files alongside FCPXML references, plus design-style thumbnails and scenario metadata.
  新增动态图层 ProRes 4444 MOV 复用导出及配套 FCPXML 引用，并补充设计风格缩略图与适用场景元数据。
- Added real-time export progress with processed/total frame counts and estimated time remaining.
  新增实时导出进度，显示已处理/总帧数与预计剩余时间。
- Added hardware-aware local H.264 encoding with VideoToolbox on macOS, NVENC on supported Windows render paths, FFmpeg hardware-encoder probing, and automatic software fallback.
  新增硬件感知的本地 H.264 编码：macOS 使用 VideoToolbox，受支持的 Windows 渲染路径使用 NVENC，FFmpeg 会实际探测硬件编码器并自动回退软件编码。
- Added tracked domain-level checks for desktop, server, Agent tools, editor, captions, persistence, shaders, and export behavior.
  新增并纳入版本管理的领域级检查，覆盖桌面端、服务端、Agent 工具、编辑器、字幕、持久化、shader 与导出行为。

### Changed / 变更

- Exact template placement now scales playback rate, fades, keyframes, zoom animation, and transitions together so retimed templates preserve their original visual rhythm.
  模板精确放置现在会同步缩放播放速率、淡入淡出、关键帧、缩放动画与转场，使变速后的模板保持原有视觉节奏。
- Caption sources now keep a stable explicit order, while repeated Agent proposal operations are compacted only when their arguments truly match.
  字幕来源现在保持稳定的显式顺序；重复的 Agent 提案操作仅在参数完全一致时才会合并。
- Made Remotion render concurrency CPU- and memory-aware, and added a configurable global heavy-export queue to avoid resource contention.
  Remotion 渲染并发现在会根据 CPU 与内存动态调整，并新增可配置的重型导出全局队列以避免资源争抢。
- Normalized variable-frame-rate media before Remotion playback and preserved H.264 bitrate ceilings across hardware and software normalization paths.
  可变帧率素材会在进入 Remotion 播放前完成标准化，同时在硬件与软件归一化路径中保持 H.264 峰值码率约束。

### Fixed / 修复

- Restricted rich-widget media previews to trusted same-origin, blob, and safe data URLs to prevent unintended external or local-network requests.
  富交互组件的媒体预览现在仅允许可信同源、Blob 与安全 Data URL，避免意外访问外部或本地网络地址。
- Fixed silence markers being attached to the wrong segment, Motion Graphic render-cache collisions across durations, and FCPXML references diverging from downloaded MOV filenames.
  修复静音标记关联到错误片段、不同动态图层时长发生渲染缓存冲突，以及 FCPXML 引用与下载 MOV 文件名不一致的问题。
- Fixed automatic export QA bypassing verification when browser rendering succeeded by routing QA-enabled exports through the verifiable server artifact path.
  修复浏览器渲染成功时自动导出质量检查被绕过的问题；开启 QA 后会使用可验证的服务端成片路径。
- Fixed concurrent exports overcommitting local CPU and memory while queued jobs now remain discoverable until they actually start.
  修复多个导出任务同时过量占用本机 CPU 与内存的问题，排队任务会在真正开始前持续保持可查询状态。
- Fixed failed or timed-out export, frame-rate conversion, and media-normalization jobs leaving partial temporary files behind.
  修复导出、帧率转换或素材归一化失败及超时后遗留不完整临时文件的问题。

## [0.1.1] - 2026-07-21

### Added / 新增

- Added configurable built-in Agent providers for Anthropic, OpenAI, Gemini, Kimi, Qwen, GLM, DeepSeek, MiniMax, Mistral, and custom OpenAI-compatible APIs.  
  新增 Anthropic、OpenAI、Gemini、Kimi、Qwen、GLM、DeepSeek、MiniMax、Mistral 及自定义 OpenAI-compatible API 的内置 Agent 配置。
- Added provider-specific API key, Base URL, model configuration, connection checks, and model discovery.  
  新增按供应商隔离的 API Key、Base URL、模型配置、连接检查与模型发现。
- Added multi-provider runtime architecture diagrams and a Discord community link.  
  新增多模型供应商运行时架构图与 Discord 社区入口。

### Changed / 变更

- Migrated the built-in Agent runtime to the Vercel AI SDK provider abstraction.  
  将内置 Agent 运行时迁移到 Vercel AI SDK 多供应商抽象。
- Restricted the desktop release workflow to manual execution and reduced its token permissions.  
  将桌面端发布工作流限制为手动触发，并收紧工作流令牌权限。

## [0.1.0] - 2026-07-20

### Added / 新增

- Initial public release of the local-first, agent-native OpenChatCut video editor.  
  首次公开发布 local-first、agent-native 的 OpenChatCut 视频编辑器。
- Added editable multitrack projects, media management, transcript-driven editing, preview, effects, transitions, motion graphics, LUTs, and production exports.  
  提供可编辑多轨工程、素材管理、文字稿剪辑、预览、特效、转场、动态图形、LUT 与成片导出。
- Added built-in Agent tools and MCP access for Codex and Claude Code.  
  提供内置 Agent 工具及面向 Codex、Claude Code 的 MCP 接入。
- Added Electron desktop packaging for macOS, Windows, and Linux.  
  提供 macOS、Windows 与 Linux 的 Electron 桌面端打包能力。

[Unreleased]: https://github.com/0xsline/OpenChatCut/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/0xsline/OpenChatCut/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/0xsline/OpenChatCut/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/0xsline/OpenChatCut/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/0xsline/OpenChatCut/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/0xsline/OpenChatCut/releases/tag/v0.1.0
