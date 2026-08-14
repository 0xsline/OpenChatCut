import type { AgentToolSchema } from '../../tool-schema';

const TARGET_PROPERTIES = {
  itemId: {
    type: 'string',
    description: 'Timeline audio/video clip id (unique prefix accepted). Its media-pool asset and trim/speed mapping are used.',
  },
  assetId: {
    type: 'string',
    description: 'Media-pool asset id (unique prefix accepted). Use itemId instead when timeline mapping is needed.',
  },
} as const;

const PLAN_PROPERTIES = {
  itemId: {
    type: 'string',
    description: 'BGM timeline audio/video clip id (unique prefix accepted).',
  },
  timing: {
    type: 'string',
    enum: ['auto', 'beat', 'downbeat', 'section'],
    description: 'Cut timing. auto chooses section/downbeat/beat deterministically from density and available analysis.',
  },
  density: {
    type: 'string',
    enum: ['sparse', 'medium', 'dense'],
    description: 'How many analyzed timing points to retain.',
  },
  fromFrame: {
    type: 'number',
    minimum: 0,
    description: 'Optional inclusive timeline-frame range start; defaults to the BGM clip start.',
  },
  toFrame: {
    type: 'number',
    minimum: 1,
    description: 'Optional exclusive timeline-frame range end; defaults to the BGM clip end.',
  },
  targetItemIds: {
    type: 'array',
    items: { type: 'string' },
    maxItems: 64,
    description: 'Optional video clip ids/prefixes to constrain targets. Defaults to video clips overlapping the range.',
  },
} as const;

const IMAGE_PLAN_PROPERTIES = {
  itemId: {
    type: 'string',
    description: 'BGM timeline audio/video clip id (unique prefix accepted).',
  },
  timing: {
    type: 'string',
    enum: ['auto', 'beat', 'downbeat', 'section'],
    description: 'Photo-change timing. auto chooses section/downbeat/beat deterministically from density and available analysis.',
  },
  density: {
    type: 'string',
    enum: ['sparse', 'medium', 'dense'],
    description: 'How many analyzed timing points to retain.',
  },
  fromFrame: {
    type: 'number',
    minimum: 0,
    description: 'Optional inclusive timeline-frame range start; defaults to the BGM clip start.',
  },
  toFrame: {
    type: 'number',
    minimum: 1,
    description: 'Optional exclusive timeline-frame range end; defaults to the BGM clip end.',
  },
  imageAssetIds: {
    type: 'array',
    items: { type: 'string' },
    maxItems: 64,
    description: 'Optional image asset ids/prefixes in display order. Defaults to all image assets in media-pool order and cycles when needed.',
  },
  track: {
    type: 'string',
    description: 'Optional target video track id or alias, default V1. The target range must be empty and unlocked.',
  },
} as const;

export const MUSIC_INTELLIGENCE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'analyze_music',
    description: [
      'Run the installed on-device Beat This + CLAP models for a media-pool asset or timeline clip and wait for completion.',
      'Returns compact BPM, meter, confidence, tags, sections, and bounded beat/downbeat points; embeddings are never exposed.',
      'Reuses a valid cache by default; set force to recompute. This tool never downloads model packs or edits the timeline.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        ...TARGET_PROPERTIES,
        force: { type: 'boolean', description: 'Recompute even when a valid cached analysis exists. Defaults to false.' },
      },
    },
  },
  {
    name: 'inspect_music',
    description: [
      'Read an already-cached local Beat This + CLAP analysis for a media-pool asset or timeline clip.',
      'Returns compact BPM, meter, confidence, tags, sections, and bounded beat/downbeat points; embeddings are never exposed.',
      'This tool never starts analysis or downloads models. If no cache exists it explains how to install the required packs and analyze first.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        ...TARGET_PROPERTIES,
        fromMs: { type: 'number', minimum: 0, description: 'Optional source-millisecond range start.' },
        toMs: { type: 'number', minimum: 1, description: 'Optional exclusive source-millisecond range end.' },
      },
    },
  },
  {
    name: 'music_edit_plan',
    description: [
      'Build a deterministic, read-only cut plan from cached music analysis, the BGM clip trim/speed mapping, and overlapping video clips.',
      'Returns a bounded frame plan and opaque analysisRef without embeddings or unbounded analysis arrays.',
      'Call this to inspect the proposed rhythm edit before sync_cuts_to_music.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: PLAN_PROPERTIES,
      required: ['itemId', 'timing', 'density'],
    },
  },
  {
    name: 'sync_cuts_to_music',
    description: [
      'Recompute a cached music cut plan at execution time and split only unlocked video clips at its planned frames.',
      'Pass the analysisRef returned by music_edit_plan to reject stale analysis. All splits are one EditorCommands batch and one undo step.',
      'This never starts analysis and never edits the BGM clip itself.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        ...PLAN_PROPERTIES,
        analysisRef: {
          type: 'string',
          description: 'Opaque ref from music_edit_plan. Execution rejects missing or stale analysis.',
        },
      },
      required: ['itemId', 'timing', 'density', 'analysisRef'],
    },
  },
  {
    name: 'music_image_plan',
    description: [
      'Build a deterministic, read-only photo placement plan from cached music analysis and the BGM clip trim/speed mapping.',
      'The plan fills the requested range with media-pool images, changing images at beat/downbeat/section boundaries and cycling the selected image order.',
      'Call this before sync_images_to_music so the user can review the bounded placement plan. This tool never starts analysis.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: IMAGE_PLAN_PROPERTIES,
      required: ['itemId', 'timing', 'density'],
    },
  },
  {
    name: 'sync_images_to_music',
    description: [
      'Recompute a cached music image plan and add one image clip per planned beat interval.',
      'Pass the analysisRef returned by music_image_plan to reject stale analysis. All image additions are one EditorCommands batch and one undo step.',
      'The target video track must be unlocked and empty in the requested range; this never starts analysis and never edits the BGM clip.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        ...IMAGE_PLAN_PROPERTIES,
        analysisRef: {
          type: 'string',
          description: 'Opaque ref from music_image_plan. Execution rejects missing or stale analysis.',
        },
      },
      required: ['itemId', 'timing', 'density', 'analysisRef'],
    },
  },
];

export const MUSIC_INTELLIGENCE_TOOL_NAMES = new Set(
  MUSIC_INTELLIGENCE_TOOL_SCHEMAS.map((tool) => tool.name),
);
