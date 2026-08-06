import type { AgentToolSchema } from './tool-schema';
import type { AgentContext } from './context';
import { AUDIO_ASSET_TOOL_NAMES } from './tools/schemas/audio-asset-tools';
import { SCENE_QUALITY_TOOL_NAMES, SCENE_QUALITY_TOOL_SCHEMAS } from './tools/schemas/scene-quality-tools';
import { TRANSCRIPT_TOOL_NAMES, TRANSCRIPT_TOOL_SCHEMAS } from './tools/schemas/transcript-tools';
import { TIMELINE_TOOL_NAMES, TIMELINE_TOOL_SCHEMAS } from './tools/schemas/timeline-tools';
import { SCRIPT_TOOL_NAMES, SCRIPT_TOOL_SCHEMAS } from './tools/schemas/script-tools';
import { FRAMES_TOOL_NAMES, FRAMES_TOOL_SCHEMAS } from './tools/schemas/frames-tool';
import { SCENE_DETECTION_TOOL_NAMES, SCENE_DETECTION_TOOL_SCHEMAS } from './tools/schemas/scene-detection-tools';
import { GENERATE_TOOL_NAMES, GENERATE_TOOL_SCHEMAS } from './tools/generate-schemas';
import { EFFECT_TOOL_NAMES, EFFECT_TOOL_SCHEMAS } from './tools/schemas/effect-tools';
import { LIBRARY_TOOL_NAMES, LIBRARY_TOOL_SCHEMAS } from './tools/schemas/library-tools';
import { EDIT_ITEM_TOOL_NAMES, EDIT_ITEM_TOOL_SCHEMAS } from './tools/schemas/edit-item-tools';
import { MEDIA_POOL_TOOL_NAMES, MEDIA_POOL_TOOL_SCHEMAS } from './tools/schemas/media-pool-tools';
import { TRACK_TOOL_NAMES, TRACK_TOOL_SCHEMAS } from './tools/schemas/track-tools';
import { DESIGN_TOOL_NAMES, DESIGN_TOOL_SCHEMAS } from './tools/schemas/design-tools';
import { STOCK_TOOL_NAMES, STOCK_TOOL_SCHEMAS } from './tools/schemas/stock-tools';
import { CAPTIONS_TOOL_NAMES, CAPTIONS_TOOL_SCHEMAS } from './tools/schemas/captions-tools';
import { SHADER_TOOL_NAMES, SHADER_TOOL_SCHEMAS } from './tools/schemas/shader-tools';
import { HIGHLIGHT_TOOL_NAMES, HIGHLIGHT_TOOL_SCHEMAS } from './tools/schemas/highlight-tool';
import { REFRAME_TOOL_NAMES, REFRAME_TOOL_SCHEMAS } from './tools/schemas/reframe-tools';
import { EXPORT_TOOL_NAMES, EXPORT_TOOL_SCHEMAS } from './tools/schemas/export-tools';
import { EXPORT_QA_TOOL_NAMES, EXPORT_QA_TOOL_SCHEMAS } from './tools/schemas/export-qa-tools';
import { TEMPLATE_TOOL_NAMES, TEMPLATE_TOOL_SCHEMAS } from './tools/schemas/template-tools';
import { LOUDNESS_TOOL_NAMES, LOUDNESS_TOOL_SCHEMAS } from './tools/schemas/loudness-tools';
import { ISOLATE_VOICE_TOOL_NAMES, ISOLATE_VOICE_TOOL_SCHEMAS } from './tools/schemas/isolate-voice-tools';
import { SKILL_TOOL_NAMES, SKILL_TOOL_SCHEMAS } from './tools/schemas/skill-tools';
import { INSTALL_SKILL_TOOL_NAMES, INSTALL_SKILL_TOOL_SCHEMAS } from './tools/schemas/install-skill-tools';
import { RUN_SKILL_SCRIPT_TOOL_NAMES, RUN_SKILL_SCRIPT_TOOL_SCHEMAS } from './tools/schemas/skill-exec-tools';
import { WATERMARK_TOOL_NAMES, WATERMARK_TOOL_SCHEMAS } from './tools/schemas/watermark-tools';
import { MARKERS_TOOL_NAMES, MARKERS_TOOL_SCHEMAS } from './tools/schemas/markers-tools';
import { MG_VIDEO_TOOL_NAMES, MG_VIDEO_TOOL_SCHEMAS } from './tools/schemas/mg-video-tools';
import { EDIT_ASSET_TOOL_NAMES, EDIT_ASSET_TOOL_SCHEMAS } from './tools/schemas/edit-asset-tools';
import { WEB_TOOL_NAMES, WEB_TOOL_SCHEMAS } from './tools/schemas/web-tools';
import { FONT_TOOL_NAMES, FONT_TOOL_SCHEMAS } from './tools/schemas/font-tools';
import { FOLLOWUP_TOOL_NAMES, FOLLOWUP_TOOL_SCHEMAS } from './tools/schemas/followup-tools';
import { PROJECT_TOOL_NAMES, PROJECT_TOOL_SCHEMAS } from './tools/schemas/project-tools';
import { UPLOAD_TOOL_NAMES, UPLOAD_TOOL_SCHEMAS } from './tools/schemas/upload-tools';
import { FRICTION_TOOL_NAMES, FRICTION_TOOL_SCHEMAS } from './tools/schemas/friction-tools';
import { READ_PROJECT_TOOL_NAMES, READ_PROJECT_TOOL_SCHEMAS } from './tools/schemas/read-project-tools';
import { MG_CODE_TOOL_NAMES, MG_CODE_TOOL_SCHEMAS } from './tools/schemas/mg-code-tools';
import { PLUGIN_SKILL_TOOL_NAMES, PLUGIN_SKILL_TOOL_SCHEMAS } from './tools/schemas/plugin-skill-tools';
import { RUN_CODE_TOOL_NAMES, RUN_CODE_TOOL_SCHEMAS } from './tools/schemas/run-code-tools';
import { PROBE_TOOL_NAMES, PROBE_TOOL_SCHEMAS } from './tools/schemas/probe-tools';
import { MULTICAM_TOOL_NAMES, MULTICAM_TOOL_SCHEMAS } from './tools/schemas/multicam-tools';
import { UNDO_TOOL_NAMES, UNDO_TOOL_SCHEMAS } from './tools/schemas/undo-tools';
import { VERSION_TOOL_NAMES, VERSION_TOOL_SCHEMAS } from './tools/schemas/version-tools';
import { LAYOUT_TOOL_NAMES, LAYOUT_TOOL_SCHEMAS } from './tools/schemas/layout-tools';
import { SILENCE_TOOL_NAMES, SILENCE_TOOL_SCHEMAS } from './tools/schemas/silence-tools';
import { COLOR_SCOPE_TOOL_NAMES, COLOR_SCOPE_TOOL_SCHEMAS } from './tools/schemas/color-scope-tools';
import { AUTO_GRADE_TOOL_NAMES, AUTO_GRADE_TOOL_SCHEMAS } from './tools/schemas/auto-grade-tools';
import { BEAT_TOOL_NAMES, BEAT_TOOL_SCHEMAS } from './tools/schemas/beat-tools';
import { withProgressTargets } from './tools/schemas/progress';

// Canonical tool definitions (name / description / JSON input_schema). Each one
// executes against the EditorCore command layer (tool == command). Vercel AI SDK
// adapts this existing JSON-schema catalog to the selected model provider.
export const TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'read_timeline',
    description: 'Read the current timeline: fps and every clip (id, track, name, startFrame, durationInFrames, props). Call this first to see current state before editing.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_templates',
    description: 'Discover motion-graphic templates. With no args: returns the category list with counts. With a category: returns the template names in it. There are ~211 templates, so prefer a category or search_templates instead of listing everything.',
    input_schema: { type: 'object', properties: { category: { type: 'string', description: 'Optional category to list (e.g. "title-cards", "lower-thirds").' } } },
  },
  {
    name: 'search_templates',
    description: 'Fuzzy-search templates by name/category keyword. Use this to find a specific template among the ~211.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'add_motion_graphic',
    description: 'Add a motion-graphic template as a new clip. Placed at the end of the track unless startFrame is given. ripple:true makes room — same-track clips at/after startFrame shift right by the new clip\'s length instead of overlapping (an insert edit).',
    input_schema: {
      type: 'object',
      properties: {
        templateName: { type: 'string', description: 'Template name (fuzzy match against list_templates).' },
        track: { type: 'string', description: 'Current video-track alias or stable id (default V1).' },
        startFrame: { type: 'number', description: 'Optional exact start frame; omit to append.' },
        ripple: { type: 'boolean', description: 'Insert-edit: push same-track clips at/after startFrame right to make room.' },
      },
      required: ['templateName'],
    },
  },
  {
    name: 'update_item_props',
    description: 'Change one or more editable props of a clip (e.g. text, colors). Only props from the template schema.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        props: { type: 'object', description: 'Map of propKey → new value.' },
      },
      required: ['itemId', 'props'],
    },
  },
  {
    name: 'move_item',
    description: 'Move a clip to a different track and/or start frame.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        track: { type: 'string', description: 'Current compatible track alias or stable id.' },
        startFrame: { type: 'number' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'set_item_timing',
    description: 'Retime a clip: change its start frame and/or its duration (in frames), and/or set a fade-in / fade-out. Use this to trim or lengthen a clip, or to fade it in/out. Fades are in SECONDS (edit_item fadeIn/fadeOut semantics) — video clips fade opacity, audio clips fade volume; 0 clears a fade. ripple:true shifts later same-track clips when the right edge moves (shorten closes the gap; lengthen pushes).',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        startFrame: { type: 'number' },
        durationInFrames: { type: 'number' },
        fadeInSeconds: { type: 'number', description: 'Fade-in length in seconds (0 clears).' },
        fadeOutSeconds: { type: 'number', description: 'Fade-out length in seconds (0 clears).' },
        ripple: { type: 'boolean', description: 'When duration/start moves the right edge, shift later same-track clips by the same delta.' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'duplicate_item',
    description: 'Duplicate a clip (the copy is appended to the end of its track).',
    input_schema: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] },
  },
  {
    name: 'remove_item',
    description: 'Delete a clip from the timeline. ripple:true also closes the gap — later clips on the same track shift left by the removed clip\'s length (a ripple delete); default leaves a gap.',
    input_schema: { type: 'object', properties: { itemId: { type: 'string' }, ripple: { type: 'boolean' } }, required: ['itemId'] },
  },
  {
    name: 'split_item',
    description: 'Split a clip into two at the given absolute frame.',
    input_schema: { type: 'object', properties: { itemId: { type: 'string' }, atFrame: { type: 'number' } }, required: ['itemId', 'atFrame'] },
  },
  {
    name: 'list_audio',
    description: 'List available audio assets (music / SFX) that can be placed on audio tracks A1/A2.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'add_audio',
    description: 'Add an audio asset (music/SFX) as a clip on an audio track (A1/A2). Appended to the track end unless startFrame is given.',
    input_schema: {
      type: 'object',
      properties: {
        audioName: { type: 'string', description: 'Audio asset name (fuzzy match against list_audio).' },
        track: { type: 'string', description: 'Current audio-track alias or stable id (default A1).' },
        startFrame: { type: 'number', description: 'Optional exact start frame; omit to append.' },
        ripple: { type: 'boolean', description: 'Insert-edit: push same-track clips at/after startFrame right to make room.' },
      },
      required: ['audioName'],
    },
  },
  {
    // submit_motion_graphic: sync LLM codegen + sandbox — creates the asset only
    // (media pool), no timeline placement.
    name: 'submit_motion_graphic',
    description: [
      'Submit a Motion Graphic generation job.',
      'Creates ONE motion-graphic asset in the media pool from a brief; does NOT place it on the timeline.',
      'After success, place with edit_item adds:[{type:"motion-graphic", assetId, trackId?, fromFrame?}].',
      'Prefer library templates (browse_library / add_motion_graphic) when one fits; use this only for brand-new visuals.',
      'Call only when the user clearly asked for a new MG.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Brief of what the motion graphic should show/animate.' },
        description: { type: 'string', description: 'Alias of prompt (local).' },
        name: { type: 'string', description: 'Short media-pool display name.' },
        durationSeconds: { type: 'number', description: 'Duration in seconds (default 3).' },
        durationInFrames: { type: 'number', description: 'Duration in frames (overrides durationSeconds when set).' },
        width: { type: 'number', description: 'Natural width px (default 1920).' },
        height: { type: 'number', description: 'Natural height px (default 1080).' },
      },
      required: ['name'],
    },
  },
  {
    // Legacy alias kept for older prompts/skills; same executor as submit_motion_graphic.
    name: 'create_motion_graphic',
    description: 'Alias of submit_motion_graphic (pool-only MG generation). Prefer submit_motion_graphic. Does not place on the timeline — use edit_item after.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the motion graphic should show/animate.' },
        prompt: { type: 'string', description: 'Alias of description.' },
        name: { type: 'string', description: 'Short display name.' },
        durationSeconds: { type: 'number', description: 'Duration in seconds (default 3).' },
        durationInFrames: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['name'],
    },
  },
  {
    name: 'clear_timeline',
    description: 'Remove ALL clips from the timeline. Only when the user clearly asks to start over / clear everything.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_aspect_ratio',
    description: 'Retarget the canvas to a different aspect ratio for long-to-short (same ratio+fit semantics as manage_timelines). E.g. turn a 16:9 video vertical for Shorts/Reels. fit: contain (letterbox) keeps everything; cover (fill+crop) fills the frame and crops the sides.',
    input_schema: {
      type: 'object',
      properties: {
        ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
        fit: { type: 'string', enum: ['contain', 'cover'], description: 'How existing clips adapt to the new ratio.' },
      },
      required: ['ratio'],
    },
  },
  // transcript / captions / delete-text-=-delete-video (transcribe, find_transcript, clean_script, apply_script, edit_captions)
  ...TRANSCRIPT_TOOL_SCHEMAS,
  // multi-timeline management (manage_timelines: list/create/duplicate/switch/update/delete)
  ...TIMELINE_TOOL_SCHEMAS,
  // dynamic track management + stable ids (edit_track)
  ...TRACK_TOOL_SCHEMAS,
  // project media-pool organization (manage_media_pool)
  ...MEDIA_POOL_TOOL_SCHEMAS,
  // Script system (read_script/apply_script with deterministic timeline.md round trips).
  ...SCRIPT_TOOL_SCHEMAS,
  // Multimodal self-check: view_timeline_frames lets the agent inspect rendered frames.
  ...FRAMES_TOOL_SCHEMAS,
  // Local FFmpeg scene detection: report cut points or atomically generate markers and batch cuts.
  ...SCENE_DETECTION_TOOL_SCHEMAS,
  // AI generation tools from generate-tools.ts: submit_image/video/voice/music/sound.
  // track_progress also accepts target=transcription for upload-and-transcribe readiness.
  ...withProgressTargets(GENERATE_TOOL_SCHEMAS),
  // browse_library → edit_item provides unified discovery and application for fx/lut/zoom/transition/sound.
  ...LIBRARY_TOOL_SCHEMAS,
  ...EDIT_ITEM_TOOL_SCHEMAS,
  // Compatibility shortcut: manage_effects maps to edit_item type=effect list/add/update/remove.
  ...EFFECT_TOOL_SCHEMAS,
  // Project design system: manage_design_style list/get/apply/update/clear.
  ...DESIGN_TOOL_SCHEMAS,
  // Online asset import (download_media / push_asset + search_stock_media; import_url_asset alias)
  ...STOCK_TOOL_SCHEMAS,
  // Word-level caption overrides: hide or replace words and force line breaks.
  ...CAPTIONS_TOOL_SCHEMAS,
  // Custom WebGL effects: generate → compile and verify → register → apply through manage_effects.
  ...SHADER_TOOL_SCHEMAS,
  // Smart clips: find highlights from the word-level transcript → duplicate a 9:16 timeline → trim while preserving word frames.
  ...HIGHLIGHT_TOOL_SCHEMAS,
  // Auto reframe: sample frames → detect subject focus → setReframeKeyframe through the existing render path.
  ...REFRAME_TOOL_SCHEMAS,
  // Async render jobs: submit_render_job enqueues a long render and track_export polls progress/results.
  ...EXPORT_TOOL_SCHEMAS,
  // Export QA: streams, duration, black/still frames, silence, peaks, and evidence frames around edit points.
  ...EXPORT_QA_TOOL_SCHEMAS,
  // Project templates: manage_template get/list_assets/apply installs a bundled MG and design style set.
  ...TEMPLATE_TOOL_SCHEMAS,
  // Loudness normalization: offline WebAudio analysis → per-clip gain through setItemVolume.
  ...LOUDNESS_TOOL_SCHEMAS,
  // Voice isolation: FFmpeg spectral denoising → setItemDenoise(denoisedSrc).
  ...ISOLATE_VOICE_TOOL_SCHEMAS,
  // Custom skill CRUD: list/get/create/update/delete; custom and built-in skills share the same catalog.
  ...SKILL_TOOL_SCHEMAS,
  // Text watermark overlay: enabled/text/position/opacity for preview and burned-in export.
  ...WATERMARK_TOOL_SCHEMAS,
  // Timeline annotations/TODOs: list/create/update/delete point or range anchors on frames or clips.
  ...MARKERS_TOOL_SCHEMAS,
  // MG → video: bake an MG asset into a media-pool video.
  ...MG_VIDEO_TOOL_SCHEMAS,
  // Update/delete library assets: sandbox code/props/name updates and confirm delete impact.
  ...EDIT_ASSET_TOOL_SCHEMAS,
  // Web scraping: markdown/html/links/screenshot/branding/summary
  ...WEB_TOOL_SCHEMAS,
  // Font catalog search; generate-tools enforces confirmFontFallback during export.
  ...FONT_TOOL_SCHEMAS,
  // Follow-up questions: render an interactive form card and pause the runtime through __followup.
  ...FOLLOWUP_TOOL_SCHEMAS,
  // Project session: create/list/delete/duplicate/edit/restore/target_project + get_editor_url
  ...PROJECT_TOOL_SCHEMAS,
  // Local upload/download chain: request_asset_upload_url/finalize_uploaded_asset/request_asset_download
  ...UPLOAD_TOOL_SCHEMAS,
  // Silent friction reporting through a localStorage ring buffer; no backend.
  ...FRICTION_TOOL_SCHEMAS,
  // Project overview.
  ...READ_PROJECT_TOOL_SCHEMAS,
  // Inline JSX → MG asset
  ...MG_CODE_TOOL_SCHEMAS,
  // Load 24 built-in SKILL.md on demand (load_skill · progressive disclosure)
  ...PLUGIN_SKILL_TOOL_SCHEMAS,
  // Install a GitHub skill repo into the user skill directory.
  ...INSTALL_SKILL_TOOL_SCHEMAS,
  // Run installed-skill scripts locally (whitelisted binaries, skill dir locked).
  ...RUN_SKILL_SCRIPT_TOOL_SCHEMAS,
  // Run skill-provided scripts, FFmpeg, Node, or Python through run_code in an isolated e2b sandbox.
  ...RUN_CODE_TOOL_SCHEMAS,
  // Import probe: probe_media reads hasAudioTrack/fps/duration through ffprobe.
  ...PROBE_TOOL_SCHEMAS,
  // Professional timeline: persistent clock/audio multicam, range switches, and linked/sync-lock groups.
  ...MULTICAM_TOOL_SCHEMAS,
  // Undo/redo: undo_last_change / redo_last_change submit history snapshots as normal edits.
  ...UNDO_TOOL_SCHEMAS,
  // Named version checkpoints: manage_versions list/save/restore/delete.
  ...VERSION_TOOL_SCHEMAS,
  // Named layouts: apply_layout computes transform+crop for split screen, picture-in-picture, grid, or reset.
  ...LAYOUT_TOOL_SCHEMAS,
  // Remove dead air: local relative-level detection plus split/remove ripple closure.
  ...SILENCE_TOOL_SCHEMAS,
  // Numeric color scopes: inspect_color reports black/white points, clipping, casts, and hue histograms.
  ...COLOR_SCOPE_TOOL_SCHEMAS,
  // Technical auto grade: auto_grade analyze|apply → setFilters on eligible pool media clips.
  ...AUTO_GRADE_TOOL_SCHEMAS,
  // Beat detection: local DSP reports BPM, beats, and downbeats and can add timeline markers for beat cuts.
  ...BEAT_TOOL_SCHEMAS,
  // Optional advisory review of multi-scene plans; it has no runtime enforcement role.
  ...SCENE_QUALITY_TOOL_SCHEMAS,
  // ToolSearch — keyword discovery over this catalog
  {
    name: 'ToolSearch',
    description: [
      'Search available agent tools by keyword (Claude Agent SDK ToolSearch style).',
      'Returns matching tool names + short descriptions. Use when you need an uncommon tool name',
      'or to confirm exact spelling before calling. Core edit tools stay always available.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword(s), e.g. "export", "caption", "stock", "shader".' },
        limit: { type: 'number', description: 'Max results (default 12, max 30).' },
      },
      required: ['query'],
    },
  },
];

type Args = Record<string, unknown>;

type ToolExecutor = (name: string, args: Args, ctx: AgentContext) => unknown | Promise<unknown>;
type ToolExecutorLoader = () => Promise<ToolExecutor>;

// Tool-name-selected literal imports keep Vite's chunk graph finite and
// statically discoverable while leaving executor groups outside the registry chunk.
const EXECUTOR_GROUPS: ReadonlyArray<readonly [ReadonlySet<string>, ToolExecutorLoader]> = [
  [TRANSCRIPT_TOOL_NAMES, async () => (await import('./tools/transcript-tools')).execTranscriptTool],
  [TIMELINE_TOOL_NAMES, async () => (await import('./tools/timeline-tools')).execTimelineTool],
  [TRACK_TOOL_NAMES, async () => (await import('./tools/track-tools')).execTrackTool],
  [MEDIA_POOL_TOOL_NAMES, async () => (await import('./tools/media-pool-tools')).execMediaPoolTool],
  [SCRIPT_TOOL_NAMES, async () => (await import('./tools/script-tools')).execScriptTool],
  [FRAMES_TOOL_NAMES, async () => (await import('./tools/frames-tool')).execFramesTool],
  [SCENE_DETECTION_TOOL_NAMES, async () => (await import('./tools/scene-detection-tools')).execSceneDetectionTool],
  [GENERATE_TOOL_NAMES, async () => (await import('./tools/generate-tools')).execGenerateTool],
  [LIBRARY_TOOL_NAMES, async () => (await import('./tools/library-tools')).execLibraryTool],
  [EDIT_ITEM_TOOL_NAMES, async () => (await import('./tools/edit-item-tools')).execEditItemTool],
  [EFFECT_TOOL_NAMES, async () => (await import('./tools/effect-tools')).execEffectTool],
  [DESIGN_TOOL_NAMES, async () => (await import('./tools/design-tools')).execDesignTool],
  [STOCK_TOOL_NAMES, async () => (await import('./tools/stock-tools')).execStockTool],
  [CAPTIONS_TOOL_NAMES, async () => (await import('./tools/captions-tools')).execCaptionsTool],
  [SHADER_TOOL_NAMES, async () => (await import('./tools/shader-tools')).execShaderTool],
  [HIGHLIGHT_TOOL_NAMES, async () => (await import('./tools/highlight-tool')).execHighlightTool],
  [REFRAME_TOOL_NAMES, async () => (await import('./tools/reframe-tools')).execReframeTool],
  [EXPORT_TOOL_NAMES, async () => (await import('./tools/export-tools')).execExportTool],
  [EXPORT_QA_TOOL_NAMES, async () => (await import('./tools/export-qa-tools')).execExportQaTool],
  [TEMPLATE_TOOL_NAMES, async () => (await import('./tools/template-tools')).execTemplateTool],
  [LOUDNESS_TOOL_NAMES, async () => (await import('./tools/loudness-tools')).execLoudnessTool],
  [ISOLATE_VOICE_TOOL_NAMES, async () => (await import('./tools/isolate-voice-tools')).execIsolateVoiceTool],
  [SKILL_TOOL_NAMES, async () => (await import('./tools/skill-tools')).execSkillTool],
  [INSTALL_SKILL_TOOL_NAMES, async () => (await import('./tools/install-skill-tools')).execInstallSkillTool],
  [RUN_SKILL_SCRIPT_TOOL_NAMES, async () => (await import('./tools/skill-exec-tools')).execRunSkillScriptTool],
  [WATERMARK_TOOL_NAMES, async () => (await import('./tools/watermark-tools')).execWatermarkTool],
  [MARKERS_TOOL_NAMES, async () => (await import('./tools/markers-tools')).execMarkersTool],
  [MG_VIDEO_TOOL_NAMES, async () => (await import('./tools/mg-video-tools')).execMgVideoTool],
  [EDIT_ASSET_TOOL_NAMES, async () => (await import('./tools/edit-asset-tools')).execEditAssetTool],
  [WEB_TOOL_NAMES, async () => (await import('./tools/web-tools')).execWebTool],
  [FONT_TOOL_NAMES, async () => (await import('./tools/font-tools')).execFontTool],
  [FOLLOWUP_TOOL_NAMES, async () => (await import('./tools/followup-tools')).execFollowupTool],
  [PROJECT_TOOL_NAMES, async () => (await import('./tools/project-tools')).execProjectTool],
  [UPLOAD_TOOL_NAMES, async () => (await import('./tools/upload-tools')).execUploadTool],
  [FRICTION_TOOL_NAMES, async () => (await import('./tools/friction-tools')).execFrictionTool],
  [READ_PROJECT_TOOL_NAMES, async () => (await import('./tools/read-project-tools')).execReadProjectTool],
  [MG_CODE_TOOL_NAMES, async () => (await import('./tools/mg-code-tools')).execMgCodeTool],
  [PLUGIN_SKILL_TOOL_NAMES, async () => (await import('./tools/plugin-skill-tools')).execPluginSkillTool],
  [RUN_CODE_TOOL_NAMES, async () => (await import('./tools/run-code-tools')).execRunCodeTool],
  [PROBE_TOOL_NAMES, async () => (await import('./tools/probe-tools')).execProbeTool],
  [MULTICAM_TOOL_NAMES, async () => (await import('./tools/multicam-tools')).execMulticamTool],
  [UNDO_TOOL_NAMES, async () => {
    const { execUndoTool } = await import('./tools/undo-tools');
    return (name, _args, ctx) => execUndoTool(name, ctx);
  }],
  [VERSION_TOOL_NAMES, async () => (await import('./tools/version-tools')).execVersionTool],
  [LAYOUT_TOOL_NAMES, async () => (await import('./tools/layout-tools')).execLayoutTool],
  [SILENCE_TOOL_NAMES, async () => (await import('./tools/silence-tools')).execSilenceTool],
  [COLOR_SCOPE_TOOL_NAMES, async () => (await import('./tools/color-scope-tools')).execColorScopeTool],
  [AUTO_GRADE_TOOL_NAMES, async () => (await import('./tools/auto-grade-tools')).execAutoGradeTool],
  [BEAT_TOOL_NAMES, async () => (await import('./tools/beat-tools')).execBeatTool],
  [AUDIO_ASSET_TOOL_NAMES, async () => (await import('./tools/audio-asset-tools')).execAudioAssetTool],
  [SCENE_QUALITY_TOOL_NAMES, async () => (await import('./tools/scene-quality-tools')).execSceneQualityTool],
];

const EXECUTOR_BY_NAME = new Map<string, ToolExecutorLoader>();
for (const [names, load] of EXECUTOR_GROUPS) {
  for (const name of names) EXECUTOR_BY_NAME.set(name, load);
}


// Execute a tool call against the live editor. Schema validation remains in the
// AI SDK tool wrapper; executor modules are selected only after a validated call.
export async function executeTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'track_progress') {
    const { execProgressTool } = await import('./tools/progress-tools');
    return execProgressTool(name, args, ctx);
  }
  const loadExecutor = EXECUTOR_BY_NAME.get(name);
  if (loadExecutor) return (await loadExecutor())(name, args, ctx);
  const { execCoreTool } = await import('./tools/core-tools');
  return execCoreTool(name, args, ctx, TOOL_SCHEMAS);
}
