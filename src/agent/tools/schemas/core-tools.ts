import type { AgentToolSchema } from '../../tool-schema';
import { jianyingExportToolSchema } from '../jianying-export-tool';

/** Core schemas shared by the browser registry and the server-side data-only executor. */
export const CORE_TOOL_SCHEMAS: AgentToolSchema[] = [
  jianyingExportToolSchema,
  {
    name: 'read_timeline',
    description: 'Read the current timeline: fps and every clip, including canonical media linkage (sourceAssetId, resolvedSourceAssetId, linkStatus), exact source window (srcInFrame, sourceStartFrame, sourceDurationInFrames, sourceEndFrameExclusive), and editable state (keyframes, transform, filters, volume, fades). Call this first to see current state before editing.',
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
        itemId: { type: 'string', minLength: 1 },
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
        itemId: { type: 'string', minLength: 1 },
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
        itemId: { type: 'string', minLength: 1 },
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
    input_schema: { type: 'object', properties: { itemId: { type: 'string', minLength: 1 } }, required: ['itemId'] },
  },
  {
    name: 'remove_item',
    description: 'Delete a clip from the timeline. ripple:true also closes the gap — later clips on the same track shift left by the removed clip\'s length (a ripple delete); default leaves a gap.',
    input_schema: { type: 'object', properties: { itemId: { type: 'string', minLength: 1 }, ripple: { type: 'boolean' } }, required: ['itemId'] },
  },
  {
    name: 'split_item',
    description: 'Split a clip into two at the given absolute frame.',
    input_schema: { type: 'object', properties: { itemId: { type: 'string', minLength: 1 }, atFrame: { type: 'number' } }, required: ['itemId', 'atFrame'] },
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
        durationSeconds: { type: 'number', minimum: 0.5, maximum: 600, description: 'Duration in seconds (default 3).' },
        durationInFrames: { type: 'number', minimum: 15, maximum: 36000, description: 'Duration in frames (overrides durationSeconds when set).' },
        width: { type: 'number', minimum: 16, maximum: 8192, description: 'Natural width px (default 1920).' },
        height: { type: 'number', minimum: 16, maximum: 8192, description: 'Natural height px (default 1080).' },
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
        durationSeconds: { type: 'number', minimum: 0.5, maximum: 600, description: 'Duration in seconds (default 3).' },
        durationInFrames: { type: 'number', minimum: 15, maximum: 36000 },
        width: { type: 'number', minimum: 16, maximum: 8192 },
        height: { type: 'number', minimum: 16, maximum: 8192 },
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
];

export const CORE_TOOL_NAMES = new Set(CORE_TOOL_SCHEMAS.map((tool) => tool.name));
