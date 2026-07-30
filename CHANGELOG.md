# Changelog / 更新日志

All notable changes to OpenChatCut are documented here.  
OpenChatCut 的重要变更记录在此。

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/).  
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] / [未发布]

### Fixed / 修复

- Fixed preview stalls at transition boundaries by preserving the incoming media element after the transition completes instead of remounting and re-seeking it.
  修复预览在转场边界卡顿的问题：转场结束后保留已在播放的入场媒体元素，不再重新挂载并跳转。

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
