import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { ASPECT_PRESETS, defaultTrackId, resolveTrackId, timelineTrackIds, trackAlias, trackKind, type AspectFit } from '../editor/types';
import type { Tpl } from '../types';
import { compileTemplate } from '../template-host';
import { createMessage, MODEL } from './client';
import { designStyleHint } from './systemPrompt';
import { TRANSCRIPT_TOOL_SCHEMAS, TRANSCRIPT_TOOL_NAMES, execTranscriptTool } from './transcript-tools';
import { TIMELINE_TOOL_SCHEMAS, TIMELINE_TOOL_NAMES, execTimelineTool } from './timeline-tools';
import { SCRIPT_TOOL_SCHEMAS, SCRIPT_TOOL_NAMES, execScriptTool } from './script-tools';
import { FRAMES_TOOL_SCHEMAS, FRAMES_TOOL_NAMES, execFramesTool } from './frames-tool';
import { GENERATE_TOOL_SCHEMAS, GENERATE_TOOL_NAMES, execGenerateTool } from './generate-tools';
import { EFFECT_TOOL_SCHEMAS, EFFECT_TOOL_NAMES, execEffectTool } from './effect-tools';
import { LIBRARY_TOOL_SCHEMAS, LIBRARY_TOOL_NAMES, execLibraryTool } from './library-tools';
import { EDIT_ITEM_TOOL_SCHEMAS, EDIT_ITEM_TOOL_NAMES, execEditItemTool } from './edit-item-tools';
import { MEDIA_POOL_TOOL_SCHEMAS, MEDIA_POOL_TOOL_NAMES, execMediaPoolTool } from './media-pool-tools';
import { TRACK_TOOL_SCHEMAS, TRACK_TOOL_NAMES, execTrackTool } from './track-tools';
import { DESIGN_TOOL_SCHEMAS, DESIGN_TOOL_NAMES, execDesignTool } from './design-tools';
import { STOCK_TOOL_SCHEMAS, STOCK_TOOL_NAMES, execStockTool } from './stock-tools';
import { CAPTIONS_TOOL_SCHEMAS, CAPTIONS_TOOL_NAMES, execCaptionsTool } from './captions-tools';
import { SHADER_TOOL_SCHEMAS, SHADER_TOOL_NAMES, execShaderTool } from './shader-tools';
import { HIGHLIGHT_TOOL_SCHEMAS, HIGHLIGHT_TOOL_NAMES, execHighlightTool } from './highlight-tool';
import { REFRAME_TOOL_SCHEMAS, REFRAME_TOOL_NAMES, execReframeTool } from './reframe-tools';
import { EXPORT_TOOL_SCHEMAS, EXPORT_TOOL_NAMES, execExportTool } from './export-tools';
import { TEMPLATE_TOOL_SCHEMAS, TEMPLATE_TOOL_NAMES, execTemplateTool } from './template-tools';
import { LOUDNESS_TOOL_SCHEMAS, LOUDNESS_TOOL_NAMES, execLoudnessTool } from './loudness-tools';
import { ISOLATE_TOOL_SCHEMAS, ISOLATE_TOOL_NAMES, execIsolateTool } from './isolate-tools';
import { SKILL_TOOL_SCHEMAS, SKILL_TOOL_NAMES, execSkillTool } from './skill-tools';
import { WATERMARK_TOOL_SCHEMAS, WATERMARK_TOOL_NAMES, execWatermarkTool } from './watermark-tools';
import { MARKERS_TOOL_SCHEMAS, MARKERS_TOOL_NAMES, execMarkersTool } from './markers-tools';
import { MG_VIDEO_TOOL_SCHEMAS, MG_VIDEO_TOOL_NAMES, execMgVideoTool } from './mg-video-tools';
import { EDIT_ASSET_TOOL_SCHEMAS, EDIT_ASSET_TOOL_NAMES, execEditAssetTool } from './edit-asset-tools';
import { WEB_TOOL_SCHEMAS, WEB_TOOL_NAMES, execWebTool } from './web-tools';
import { FONT_TOOL_SCHEMAS, FONT_TOOL_NAMES, execFontTool } from './font-tools';
import { FOLLOWUP_TOOL_SCHEMAS, FOLLOWUP_TOOL_NAMES, execFollowupTool } from './followup-tools';
import { PROJECT_TOOL_SCHEMAS, PROJECT_TOOL_NAMES, execProjectTool } from './project-tools';
import { UPLOAD_TOOL_SCHEMAS, UPLOAD_TOOL_NAMES, execUploadTool } from './upload-tools';
import { FRICTION_TOOL_SCHEMAS, FRICTION_TOOL_NAMES, execFrictionTool } from './friction-tools';
import { READ_PROJECT_TOOL_SCHEMAS, READ_PROJECT_TOOL_NAMES, execReadProjectTool } from './read-project-tools';
import { MG_CODE_TOOL_SCHEMAS, MG_CODE_TOOL_NAMES, execMgCodeTool } from './mg-code-tools';
import { PLUGIN_SKILL_TOOL_SCHEMAS, PLUGIN_SKILL_TOOL_NAMES, execPluginSkillTool } from './plugin-skill-tools';
import { RUN_CODE_TOOL_SCHEMAS, RUN_CODE_TOOL_NAMES, execRunCodeTool } from './run-code-tools';
import { execTranscriptionProgress } from './transcription-progress';

// track_progress is a shared source tool. generate-tools.ts (grok's lane) owns
// target=generation; we extend its schema here — immutably, without editing that file —
// so the model can also call target=transcription (readiness of 上传即转写 ASR jobs,
// polled by assetIds). The matching dispatch intercept is in executeTool.
function withTranscriptionTarget(schemas: Anthropic.Tool[]): Anthropic.Tool[] {
  return schemas.map((tool) => {
    if (tool.name !== 'track_progress') return tool;
    const properties = (tool.input_schema.properties ?? {}) as Record<string, unknown>;
    return {
      ...tool,
      description: `${tool.description} For target=transcription, poll ingest ASR readiness (上传即转写) by assetIds instead of jobIds; a succeeded asset then carries a word-level transcript that clips inherit.`,
      input_schema: {
        ...tool.input_schema,
        properties: {
          ...properties,
          target: { type: 'string', enum: ['generation', 'transcription'] },
          assetIds: { type: 'string', description: 'For target=transcription: comma-separated asset IDs/prefixes to check ASR readiness for.' },
        },
        required: ['action', 'target'],
      },
    };
  });
}

// Anthropic native tool definitions (name / description / input_schema). Each
// one executes against the EditorCore command layer (tool == command). This is
// the source-faithful shape: Claude's Messages API tool-use, `strict`-exact.
export const TOOL_SCHEMAS: Anthropic.Tool[] = [
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
    description: 'Add a motion-graphic template as a new clip. Placed at the end of the track unless startFrame is given. ripple:true makes room — same-track clips at/after startFrame shift right by the new clip\'s length instead of overlapping (source insert edit).',
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
    description: 'Retime a clip: change its start frame and/or its duration (in frames), and/or set a fade-in / fade-out. Use this to trim or lengthen a clip, or to fade it in/out. Fades are in SECONDS (source edit_item fadeIn/fadeOut) — video clips fade opacity, audio clips fade volume; 0 clears a fade.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        startFrame: { type: 'number' },
        durationInFrames: { type: 'number' },
        fadeInSeconds: { type: 'number', description: 'Fade-in length in seconds (0 clears).' },
        fadeOutSeconds: { type: 'number', description: 'Fade-out length in seconds (0 clears).' },
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
    description: 'Delete a clip from the timeline. ripple:true also closes the gap — later clips on the same track shift left by the removed clip\'s length (source ripple delete); default leaves a gap.',
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
    name: 'create_motion_graphic',
    description: 'Generate a BRAND-NEW motion graphic from a description (writes fresh Remotion code, not from the library). Use only when no library template fits the user\'s intent.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the motion graphic should show/animate.' },
        name: { type: 'string', description: 'Short display name.' },
        durationSeconds: { type: 'number', description: 'Duration in seconds (default 3).' },
        track: { type: 'string', description: 'Current video-track alias or stable id.' },
      },
      required: ['description', 'name'],
    },
  },
  {
    name: 'clear_timeline',
    description: 'Remove ALL clips from the timeline. Only when the user clearly asks to start over / clear everything.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_aspect_ratio',
    description: 'Retarget the canvas to a different aspect ratio for long-to-short (source manage_timelines ratio+fit). E.g. turn a 16:9 video vertical for Shorts/Reels. fit: contain (letterbox) keeps everything; cover (fill+crop) fills the frame and crops the sides.',
    input_schema: {
      type: 'object',
      properties: {
        ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
        fit: { type: 'string', enum: ['contain', 'cover'], description: 'How existing clips adapt to the new ratio.' },
      },
      required: ['ratio'],
    },
  },
  // transcript / captions / delete-text-=-delete-video (source: transcribe, find_transcript, clean_script, apply_script, edit_captions)
  ...TRANSCRIPT_TOOL_SCHEMAS,
  // multi-timeline management (source manage_timelines: list/create/duplicate/switch/update/delete)
  ...TIMELINE_TOOL_SCHEMAS,
  // dynamic track management + stable ids (source edit_track)
  ...TRACK_TOOL_SCHEMAS,
  // project media-pool organization (source manage_media_pool)
  ...MEDIA_POOL_TOOL_SCHEMAS,
  // Script system (source read_script/apply_script — timeline.md 往返, 护城河③)
  ...SCRIPT_TOOL_SCHEMAS,
  // multimodal self-check (source view_timeline_frames — agent 渲帧自检)
  ...FRAMES_TOOL_SCHEMAS,
  // AI 生成套件（GPT 主攻，定义在 generate-tools.ts：submit_image/video/voice/music/sound）
  // track_progress schema extended to also accept target=transcription (上传即转写 readiness).
  ...withTranscriptionTarget(GENERATE_TOOL_SCHEMAS),
  // 源站 browse_library → edit_item（fx/lut/zoom/transition/sound 统一发现与落地）
  ...LIBRARY_TOOL_SCHEMAS,
  ...EDIT_ITEM_TOOL_SCHEMAS,
  // 兼容捷径：manage_effects（等价 edit_item type=effect 的 list/add/update/remove）
  ...EFFECT_TOOL_SCHEMAS,
  // 设计风格 = 工程品牌（source manage_design_style：list/get/apply/update/clear）
  ...DESIGN_TOOL_SCHEMAS,
  // 在线素材导入（source 同名 download_media / push_asset + search_stock_media；import_url_asset 别名）
  ...STOCK_TOOL_SCHEMAS,
  // 逐词字幕覆盖（source edit_captions display_text：read_captions/edit_caption_words 隐藏/改词/强制换行）
  ...CAPTIONS_TOOL_SCHEMAS,
  // LLM 生成自定义 WebGL 特效（source submit_shader type:effect——生成→编译校验→注册，再由 manage_effects 应用）
  ...SHADER_TOOL_SCHEMAS,
  // 智能切片：LLM 读词级转写找高光 → duplicateTimeline 9:16 → 裁段（长转短成片，护城河③ 词↔帧）
  ...HIGHLIGHT_TOOL_SCHEMAS,
  // auto-reframe 自动检测：采样帧→主体焦点→setReframeKeyframe（复用现成 reframe 渲染链）
  ...REFRAME_TOOL_SCHEMAS,
  // 异步渲染 job（source track_export）：submit_render_job 入队长渲染 + track_export 轮询进度/取结果
  ...EXPORT_TOOL_SCHEMAS,
  // 工程模板（source manage_template）：get/list_assets/apply 打包套用一组 MG+设计风格
  ...TEMPLATE_TOOL_SCHEMAS,
  // 响度归一（自定 normalize_loudness）：WebAudio 离线分析→per-clip 增益，复用 setItemVolume
  ...LOUDNESS_TOOL_SCHEMAS,
  // AI 人声隔离（源 isolate_voice / DeepFilterNet3）
  ...ISOLATE_TOOL_SCHEMAS,
  // 自定义创作技能 CRUD（源 manage_skill：list/get/create/update/delete，自定义技能与内置并列注入）
  ...SKILL_TOOL_SCHEMAS,
  // 文本水印叠加（源 updateWatermark：enabled/text/position/opacity，渲染+烧录导出）
  ...WATERMARK_TOOL_SCHEMAS,
  // 时间线批注/TODO 锚点（源 manage_markers：list/create/update/delete，点/段锚帧或锚 clip）
  ...MARKERS_TOOL_SCHEMAS,
  // MG→视频（源 convert_motion_graphic_to_video / register_converted_video：烘焙 MG 为媒体池 video 资产）
  ...MG_VIDEO_TOOL_SCHEMAS,
  // 改/删库资产（源 edit_asset：update code/props/name 过沙箱 + delete confirmImpact）
  ...EDIT_ASSET_TOOL_SCHEMAS,
  // 网页抓取（源 web_browser / Firecrawl：markdown/html/links/screenshot/branding/summary）
  ...WEB_TOOL_SCHEMAS,
  // 字体目录搜索（源 search_fonts；导出 confirmFontFallback 门在 generate-tools）
  ...FONT_TOOL_SCHEMAS,
  // 主动追问（源 ask_followup_questions：agent 缺关键信息时发交互表单卡, runtime __followup 特判渲染并暂停）
  ...FOLLOWUP_TOOL_SCHEMAS,
  // 工程会话（源 create/list/delete/duplicate/edit/restore/target_project + get_editor_url）
  ...PROJECT_TOOL_SCHEMAS,
  // 本地上传/下载链（源 request_asset_upload_url / finalize_uploaded_asset / request_asset_download）
  ...UPLOAD_TOOL_SCHEMAS,
  // 静默摩擦上报（源 report_user_friction：localStorage 本地环，无后端）
  ...FRICTION_TOOL_SCHEMAS,
  // 工程总览（源 read_project）
  ...READ_PROJECT_TOOL_SCHEMAS,
  // 内联 JSX → MG 资产（源 create_motion_graphic_from_code）
  ...MG_CODE_TOOL_SCHEMAS,
  // 按需加载源 agent-plugin 的 15 个 SKILL.md（load_skill · 渐进式披露）
  ...PLUGIN_SKILL_TOOL_SCHEMAS,
  // 在自有 e2b 沙箱里跑 skill 自带脚本 / ffmpeg / node / python（run_code）
  ...RUN_CODE_TOOL_SCHEMAS,
];

let genCounter = 0;

// Ask the model to write a fresh Remotion MG component following the template
// contract. Uses the same native Anthropic client as the agent loop. `brandHint`
// injects the project's applied design style so generated MGs match the brand.
async function generateMgCode(description: string, brandHint = ''): Promise<string> {
  const sys = `You write ONE Remotion motion-graphic React component. Output ONLY the code — no markdown fences, no prose.
Contract (MUST follow exactly):
- Shape: const Name = ({item}) => { ...; return (<AbsoluteFill>...</AbsoluteFill>); };
- NO import / require / export. These globals are already injected: React, useCurrentFrame, useVideoConfig, interpolate, interpolateColors, spring, Easing, random, Img, Audio, Sequence, AbsoluteFill.
- Canvas is 1920x1080. Animate with useCurrentFrame()+interpolate()/spring({fps,frame,config}). Get { fps, durationInFrames } from useVideoConfig().
- Pure, synchronous rendering only. FORBIDDEN: fetch, XMLHttpRequest, WebSocket, document, window, globalThis, eval, new Function, .constructor, localStorage, setTimeout, setInterval, while(true), for(;;), debugger.
- Style inline. Make it clean and visually appealing (large readable text, tasteful colors, smooth fade/slide/scale animations).${brandHint}`;
  const msg = await createMessage({
    model: MODEL,
    max_tokens: 64000, // don't truncate generated components
    system: sys,
    messages: [{ role: 'user', content: description }],
  });
  let code = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  code = code.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim(); // strip fences
  return code;
}

type Args = Record<string, unknown>;

function findItem(ctx: AgentContext, itemId: unknown) {
  const id = String(itemId ?? '');
  const items = ctx.getState().items;
  return items.find((it) => it.id === id || it.id.startsWith(id)) ?? null;
}

// Execute a tool call against the live editor. Returns a JSON-serializable result.
export async function executeTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (TRANSCRIPT_TOOL_NAMES.has(name)) return execTranscriptTool(name, args, ctx);
  if (TIMELINE_TOOL_NAMES.has(name)) return execTimelineTool(name, args, ctx);
  if (TRACK_TOOL_NAMES.has(name)) return execTrackTool(name, args, ctx);
  if (MEDIA_POOL_TOOL_NAMES.has(name)) return execMediaPoolTool(name, args, ctx);
  if (SCRIPT_TOOL_NAMES.has(name)) return execScriptTool(name, args, ctx);
  if (FRAMES_TOOL_NAMES.has(name)) return execFramesTool(name, args, ctx);
  // track_progress target=transcription → Claude-owned handler (readiness of 上传即转写
  // ASR); target=generation falls through to grok's execGenerateTool below.
  if (name === 'track_progress' && args.target === 'transcription') return execTranscriptionProgress(args, ctx);
  if (GENERATE_TOOL_NAMES.has(name)) return execGenerateTool(name, args, ctx);
  if (LIBRARY_TOOL_NAMES.has(name)) return execLibraryTool(name, args, ctx);
  if (EDIT_ITEM_TOOL_NAMES.has(name)) return execEditItemTool(name, args, ctx);
  if (EFFECT_TOOL_NAMES.has(name)) return execEffectTool(name, args, ctx);
  if (DESIGN_TOOL_NAMES.has(name)) return execDesignTool(name, args, ctx);
  if (STOCK_TOOL_NAMES.has(name)) return execStockTool(name, args, ctx);
  if (CAPTIONS_TOOL_NAMES.has(name)) return execCaptionsTool(name, args, ctx);
  if (SHADER_TOOL_NAMES.has(name)) return execShaderTool(name, args, ctx);
  if (HIGHLIGHT_TOOL_NAMES.has(name)) return execHighlightTool(name, args, ctx);
  if (REFRAME_TOOL_NAMES.has(name)) return execReframeTool(name, args, ctx);
  if (EXPORT_TOOL_NAMES.has(name)) return execExportTool(name, args, ctx);
  if (TEMPLATE_TOOL_NAMES.has(name)) return execTemplateTool(name, args, ctx);
  if (LOUDNESS_TOOL_NAMES.has(name)) return execLoudnessTool(name, args, ctx);
  if (ISOLATE_TOOL_NAMES.has(name)) return execIsolateTool(name, args, ctx);
  if (SKILL_TOOL_NAMES.has(name)) return execSkillTool(name, args, ctx);
  if (WATERMARK_TOOL_NAMES.has(name)) return execWatermarkTool(name, args, ctx);
  if (MARKERS_TOOL_NAMES.has(name)) return execMarkersTool(name, args, ctx);
  if (MG_VIDEO_TOOL_NAMES.has(name)) return execMgVideoTool(name, args, ctx);
  if (EDIT_ASSET_TOOL_NAMES.has(name)) return execEditAssetTool(name, args, ctx);
  if (WEB_TOOL_NAMES.has(name)) return execWebTool(name, args, ctx);
  if (FONT_TOOL_NAMES.has(name)) return execFontTool(name, args, ctx);
  if (FOLLOWUP_TOOL_NAMES.has(name)) return execFollowupTool(name, args, ctx);
  if (PROJECT_TOOL_NAMES.has(name)) return execProjectTool(name, args, ctx);
  if (UPLOAD_TOOL_NAMES.has(name)) return execUploadTool(name, args, ctx);
  if (FRICTION_TOOL_NAMES.has(name)) return execFrictionTool(name, args, ctx);
  if (READ_PROJECT_TOOL_NAMES.has(name)) return execReadProjectTool(name, args, ctx);
  if (MG_CODE_TOOL_NAMES.has(name)) return execMgCodeTool(name, args, ctx);
  if (PLUGIN_SKILL_TOOL_NAMES.has(name)) return execPluginSkillTool(name, args);
  if (RUN_CODE_TOOL_NAMES.has(name)) return execRunCodeTool(name, args);
  switch (name) {
    case 'read_timeline': {
      const s = ctx.getState();
      return {
        fps: s.fps,
        tracks: timelineTrackIds(s).map((id) => ({ id, alias: trackAlias(s, id), trackType: trackKind(s, id) })),
        items: s.items.map((it) => ({
          id: it.id, trackId: it.track, track: trackAlias(s, it.track), name: it.name,
          startFrame: it.startFrame, durationInFrames: it.durationInFrames, props: it.props,
          // library-facing fields (source read_project track-fx / transitions)
          zoom: it.zoom ?? null,
          effects: (it.effects ?? []).map((e) => ({ effectId: e.id, assetId: e.assetId, overrides: e.overrides ?? {} })),
        })),
        transitions: (s.transitions ?? []).map((t) => ({
          id: t.id, type: t.type, assetId: `builtin:tr-${t.type}`,
          durationInFrames: t.durationInFrames,
          outgoingItemId: t.outgoingItemId, incomingItemId: t.incomingItemId, trackId: t.trackId,
        })),
      };
    }
    case 'list_templates': {
      const cat = args.category ? String(args.category).toLowerCase() : null;
      if (!cat) {
        const counts: Record<string, number> = {};
        for (const t of ctx.templates) counts[t.category] = (counts[t.category] ?? 0) + 1;
        return { categories: counts, total: ctx.templates.length, hint: '传 category 或用 search_templates 精确找' };
      }
      return ctx.templates.filter((t) => t.category.toLowerCase() === cat).map((t) => t.name);
    }
    case 'search_templates': {
      const q = String(args.query ?? '').toLowerCase();
      return ctx.templates
        .filter((t) => t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q))
        .slice(0, 15)
        .map((t) => ({ name: t.name, category: t.category }));
    }

    case 'add_motion_graphic': {
      const q = String(args.templateName ?? '').toLowerCase();
      const matches = ctx.templates.filter((t) => t.name.toLowerCase().includes(q));
      if (matches.length === 0) return { error: `no template matching "${args.templateName}"`, available: ctx.templates.map((t) => t.name) };
      const tpl = matches[0];
      const s = ctx.getState();
      const track = resolveTrackId(s, args.track ?? 'V1', 'video') ?? defaultTrackId(s, 'video');
      if (!track) return { error: 'no video track; create one with edit_track first' };
      const startFrame = typeof args.startFrame === 'number' ? args.startFrame : undefined;
      ctx.commands.addMotionGraphic(tpl, { track, startFrame, ripple: args.ripple === true });
      return { ok: true, added: tpl.name, trackId: track, track: trackAlias(ctx.getState(), track) };
    }
    case 'update_item_props': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      ctx.commands.updateItemProps(it.id, (args.props ?? {}) as Args);
      return { ok: true, itemId: it.id, updated: Object.keys((args.props ?? {}) as Args) };
    }
    case 'move_item': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      const kind = it.kind === 'audio' ? 'audio' : 'video';
      const track = args.track === undefined ? undefined : resolveTrackId(ctx.getState(), args.track, kind);
      if (args.track !== undefined && !track) return { error: `no compatible track ${args.track}` };
      ctx.commands.moveItem(it.id, { track: track ?? undefined, startFrame: args.startFrame as number });
      return { ok: true, itemId: it.id };
    }
    case 'set_item_timing': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      if (args.startFrame !== undefined || args.durationInFrames !== undefined) {
        ctx.commands.setItemTiming(it.id, { startFrame: args.startFrame as number, durationInFrames: args.durationInFrames as number });
      }
      // fade in SECONDS (source edit_item fadeIn/fadeOut) → frames; reducer clamps to clip length
      const fps = ctx.getState().fps;
      const toFrames = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v * fps)) : undefined);
      const fadeInFrames = toFrames(args.fadeInSeconds);
      const fadeOutFrames = toFrames(args.fadeOutSeconds);
      if (fadeInFrames !== undefined || fadeOutFrames !== undefined) {
        ctx.commands.setItemFade(it.id, { fadeInFrames, fadeOutFrames });
      }
      return { ok: true, itemId: it.id, ...(fadeInFrames !== undefined ? { fadeInFrames } : {}), ...(fadeOutFrames !== undefined ? { fadeOutFrames } : {}) };
    }
    case 'duplicate_item': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      ctx.commands.duplicateItem(it.id);
      return { ok: true, duplicated: it.name };
    }
    case 'list_audio':
      return ctx.audio.map((a) => ({ name: a.name, category: a.category, seconds: Math.round(a.durationInFrames / 30) }));
    case 'add_audio': {
      const q = String(args.audioName ?? '').toLowerCase();
      const asset = ctx.audio.find((a) => a.name.toLowerCase().includes(q));
      if (!asset) return { error: `no audio matching "${args.audioName}"`, available: ctx.audio.map((a) => a.name) };
      const s = ctx.getState();
      const track = resolveTrackId(s, args.track ?? 'A1', 'audio') ?? defaultTrackId(s, 'audio');
      if (!track) return { error: 'no audio track; create one with edit_track first' };
      const startFrame = typeof args.startFrame === 'number' ? args.startFrame : undefined;
      ctx.commands.addAudio(asset, { track, startFrame, ripple: args.ripple === true });
      return { ok: true, added: asset.name, trackId: track, track: trackAlias(ctx.getState(), track) };
    }
    case 'create_motion_graphic': {
      const description = String(args.description ?? '').trim();
      if (!description) return { error: 'description is required' };
      const fps = ctx.getState().fps;
      const durationInFrames = Math.max(15, Math.round((Number(args.durationSeconds) || 3) * fps));
      let code: string;
      try {
        code = await generateMgCode(description, designStyleHint(ctx.getDoc().designStyle));
      } catch (e) {
        return { error: `generation failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!code) return { error: 'model returned empty code' };
      // Sandbox gate: compileTemplate runs the static blocklist (validateTemplate)
      // then compiles in the restricted scope — both must pass before we add it.
      try {
        compileTemplate(code);
      } catch (e) {
        return { error: `generated code rejected by sandbox: ${e instanceof Error ? e.message : String(e)}`, code };
      }
      const tpl: Tpl = {
        id: `gen_${++genCounter}`,
        name: String(args.name ?? 'Generated MG'),
        category: 'generated',
        width: 1920, height: 1080, fps,
        durationInFrames,
        props: {}, propSchema: [], thumb: null, code,
      };
      const s = ctx.getState();
      const track = resolveTrackId(s, args.track ?? 'V1', 'video') ?? defaultTrackId(s, 'video');
      if (!track) return { error: 'no video track; create one with edit_track first' };
      ctx.commands.addMotionGraphic(tpl, { track });
      return { ok: true, generated: tpl.name, trackId: track, track: trackAlias(ctx.getState(), track), durationInFrames };
    }
    case 'clear_timeline':
      ctx.commands.clearTimeline();
      return { ok: true };
    case 'set_aspect_ratio': {
      const preset = ASPECT_PRESETS.find((p) => p.label === String(args.ratio));
      if (!preset) return { error: `unknown ratio ${args.ratio}` };
      const fit = (args.fit as AspectFit) ?? ctx.getState().fit ?? 'contain';
      ctx.commands.setAspect(preset.width, preset.height, fit);
      return { ok: true, ratio: preset.label, width: preset.width, height: preset.height, fit };
    }
    case 'remove_item': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      if (args.ripple === true) ctx.commands.rippleDeleteItem(it.id); // close the gap
      else ctx.commands.removeItem(it.id);
      return { ok: true, removed: it.name, ripple: args.ripple === true };
    }
    case 'split_item': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      ctx.commands.splitItem(it.id, Number(args.atFrame));
      return { ok: true, itemId: it.id };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
