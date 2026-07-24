# Changelog / Change log

All notable changes to OpenChatCut are documented here.  
OpenChatCut Important changes are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/).  
Format reference [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/), the version number follows [Semantic Version](https://semver.org/lang/zh-CN/).

## [Unreleased] / [Unpublished]

### Added / New

- Added client-agnostic MCP configuration (`.mcp.json`) and documentation for OpenCode CLI and Antigravity IDE support.
- Converted internal comments to English and removed Chinese locale files (`README_ZH.md`, `src/i18n/dict/zh/*`).

## [0.1.3] - 2026-07-23

### Added / New

- Added independent caption tracks, multiple caption tracks per sequence, manual caption creation, and track-type selection when creating a track.
  Added independent subtitle tracks, single sequence multiple subtitle tracks, new manual subtitles, and track type selection when creating a new track.
- Added direct caption editing in the preview and timeline, including dragging a caption style onto the preview, moving captions, and trimming both edges.
  Added the ability to directly edit subtitles in the preview and timeline, supporting dragging subtitle styles into the preview, moving subtitles, and dragging both ends to adjust the duration.
- Added a PR-style Rate Stretch tool that preserves the source range while changing clip duration and playback speed.
  New PR Styled Ratio Stretch tool that changes clip duration and playback speed while maintaining source range.
- Added model-aware Agent parameters and provider validation for image, video, music, sound, and voice generation, including expanded MiniMax and Mureka support.
  Added new model levels for image, video, music, sound effects and speech generation Agent Parameter and supplier verification and expansion MiniMax with Mureka Support.
- Added OpenRouter as a built-in OpenAI-compatible Agent provider.
  New OpenRouter Built-in OpenAI-compatible Agent supplier.

### Changed / change

- Moved standalone caption styling and manual editing into the dedicated Captions workspace, with a direct “Caption styles” entry from Transcript.
  Centralize independent subtitle styles and manual editing into the "Subtitles" workspace, and add a new "Subtitle Styles" shortcut entry in "Text".
- Improved local transcription source recovery by falling back to IndexedDB media and the original clip when extracted audio is unavailable.
  Improved recovery of local transcribed material: fallback to when extracting audio is unavailable IndexedDB Materials and original footage.
- Added Ctrl/Command + mouse-wheel zoom to the motion-tracking target picker.
  Added new for motion tracking target selector Ctrl/Command + Mouse wheel zoom.

### Fixed / Repair

- Fixed `promptOptimizer` being sent to non-MiniMax image models; it is now emitted only for MiniMax `image-01`.
  Repair Xiangfei MiniMax Picture model sent `promptOptimizer` issue; this parameter is now only used for MiniMax `image-01`。
- Fixed Agent thinking content rendering raw Markdown instead of formatted, collapsible content.
  Repair Agent Thinking process shown directly Markdown The original text is not formatted or folded.
- Fixed motion-tracking previews opening on a black first frame for affected videos.
  Fixed an issue where the preview of some videos stopped at the first black frame when motion tracking was turned on.
- Fixed imprecise floating-point playback-speed labels and clarified exiting Rate Stretch mode.
  Fixed the issue where the playback speed displayed abnormal floating point precision, and clarified how to exit the ratio stretch mode.

## [0.1.2] - 2026-07-21

### Added / New

- Added WebCodecs-accelerated browser video export with live progress, cancellation, and automatic fallback to the compatible server renderer.
  Add new based on WebCodecs The browser accelerates video export, supports real-time progress, cancellation of operations, and automatically falls back to server-side rendering when incompatible.
- Added multi-provider stock search across Pexels, Pixabay, Unsplash, and Freesound with media type, orientation, category, platform, deduplication, and partial-result handling.
  Add new coverage Pexels、Pixabay、Unsplash with Freesound Multi-platform material search supports media type, direction, classification, platform filtering, deduplication and partial result return.
- Added richer Agent editing controls for track-scoped scripts and captions, timeline frame and marker targeting, exact template placement, voice-isolation attachment, and structured follow-up widgets.
  Add richer Agent Editing capabilities include track-level scripts and subtitles, timeline frame and marker positioning, precise template placement, vocal isolation mounting, and structured questioning components.
- Added reusable Motion Graphic exports as ProRes 4444 MOV files alongside FCPXML references, plus design-style thumbnails and scenario metadata.
  Add dynamic layer ProRes 4444 MOV Reuse export and matching FCPXML Quote, and add design style thumbnails and applicable scene metadata.
- Added real-time export progress with processed/total frame counts and estimated time remaining.
  Added real-time export progress, showing that it has been processed/Total frames and estimated time remaining.
- Added hardware-aware local H.264 encoding with VideoToolbox on macOS, NVENC on supported Windows render paths, FFmpeg hardware-encoder probing, and automatic software fallback.
  Added hardware-aware local H.264 Encoding:macOS Use VideoToolbox, supported Windows Rendering path usage NVENC，FFmpeg Will actually detect the hardware encoder and automatically fall back to software encoding.
- Added tracked domain-level checks for desktop, server, Agent tools, editor, captions, persistence, shaders, and export behavior.
  Domain-level checks have been added and incorporated into version management, covering desktop, server,Agent Tools, editors, subtitles, persistence,shader and export behavior.

### Changed / change

- Exact template placement now scales playback rate, fades, keyframes, zoom animation, and transitions together so retimed templates preserve their original visual rhythm.
  Precise template placement now synchronizes scale playback rates, fades, keyframes, scale animations, and transitions, allowing templates to maintain their original visual rhythm after shifting speeds.
- Caption sources now keep a stable explicit order, while repeated Agent proposal operations are compacted only when their arguments truly match.
  Subtitle sources now maintain stable explicit order; duplicates Agent Proposal actions will only be merged if their parameters are exactly the same.
- Made Remotion render concurrency CPU- and memory-aware, and added a configurable global heavy-export queue to avoid resource contention.
  Remotion Rendering and discovery will now be based on CPU Dynamically adjust memory and add a configurable heavy-duty export global queue to avoid resource contention.
- Normalized variable-frame-rate media before Remotion playback and preserved H.264 bitrate ceilings across hardware and software normalization paths.
  Variable frame rate footage will enter Remotion Normalized before playback while maintaining in hardware and software normalization paths H.264 Peak code rate constraints.

### Fixed / Repair

- Restricted rich-widget media previews to trusted same-origin, blob, and safe data URLs to prevent unintended external or local-network requests.
  Media preview for rich interactive components now only allows trusted origins,Blob and safety Data URL, to avoid accidental access to external or local network addresses.
- Fixed silence markers being attached to the wrong segment, Motion Graphic render-cache collisions across durations, and FCPXML references diverging from downloaded MOV filenames.
  Fixed silence markers being associated with wrong clips, render cache conflicts with different dynamic layer durations, and FCPXML Quote and download MOV File name inconsistency issue.
- Fixed automatic export QA bypassing verification when browser rendering succeeded by routing QA-enabled exports through the verifiable server artifact path.
  Fixed an issue where the automatic export quality check was bypassed when the browser rendered successfully; enable QA A verifiable server-side sharding path will be used later.
- Fixed concurrent exports overcommitting local CPU and memory while queued jobs now remain discoverable until they actually start.
  Fixed the problem of multiple export tasks overoccupying the local machine at the same time CPU Due to memory issues, queued tasks will remain queryable until they actually start.
- Fixed failed or timed-out export, frame-rate conversion, and media-normalization jobs leaving partial temporary files behind.
  Fixed an issue where incomplete temporary files were left after export, frame rate conversion or material normalization failed and timed out.

## [0.1.1] - 2026-07-21

### Added / New

- Added configurable built-in Agent providers for Anthropic, OpenAI, Gemini, Kimi, Qwen, GLM, DeepSeek, MiniMax, Mistral, and custom OpenAI-compatible APIs.  
  New Anthropic、OpenAI、Gemini、Kimi、Qwen、GLM、DeepSeek、MiniMax、Mistral and custom OpenAI-compatible API of built-in Agent configuration.
- Added provider-specific API key, Base URL, model configuration, connection checks, and model discovery.  
  Added isolation by supplier API Key、Base URL, model configuration, connection checking and model discovery.
- Added multi-provider runtime architecture diagrams and a Discord community link.  
  Added multi-model provider runtime architecture diagram and Discord Community entrance.

### Changed / change

- Migrated the built-in Agent runtime to the Vercel AI SDK provider abstraction.  
  will be built-in Agent Runtime migration to Vercel AI SDK Multi-vendor abstraction.
- Restricted the desktop release workflow to manual execution and reduced its token permissions.  
  Limit desktop publishing workflows to manual triggering and tighten workflow token permissions.

## [0.1.0] - 2026-07-20

### Added / New

- Initial public release of the local-first, agent-native OpenChatCut video editor.  
  first public release local-first、agent-native of OpenChatCut Video editor.
- Added editable multitrack projects, media management, transcript-driven editing, preview, effects, transitions, motion graphics, LUTs, and production exports.  
  Provides editable multi-track projects, material management, script editing, preview, special effects, transitions, dynamic graphics,LUT Export with finished film.
- Added built-in Agent tools and MCP access for Codex and Claude Code.  
  Provides built-in Agent Tools and orientation Codex、Claude Code of MCP access.
- Added Electron desktop packaging for macOS, Windows, and Linux.  
  provide macOS、Windows with Linux of Electron Desktop packaging capabilities.

[Unreleased]: https://github.com/0xsline/OpenChatCut/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/0xsline/OpenChatCut/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/0xsline/OpenChatCut/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/0xsline/OpenChatCut/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/0xsline/OpenChatCut/releases/tag/v0.1.0
