import type { AgentToolSchema } from '../../tool-schema';

export const FRAMES_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'view_timeline_frames',
    description: [
      'Render still frames of one timeline composition (pending/draft edits included).',
      'frames and seconds are ABSOLUTE TIMELINE coordinates, not source-media positions.',
      'Use after visual edits (MG/text, transitions, zoom, filters, aspect, captions) to verify the composed result.',
      'Do not use to verify flex crop / keep-only-region jobs: at most one look before cropping, never after.',
      'Provide exact coordinates or count; with neither, samples evenly (default 4, max 16). Multi-frame results are one labeled contact sheet when possible.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        frames: { type: 'array', items: { type: 'number' }, description: 'Absolute timeline frame numbers to render.' },
        seconds: { type: 'array', items: { type: 'number' }, description: 'Absolute timeline seconds (converted by timeline fps).' },
        count: { type: 'number', description: 'Even midpoints across the timeline/range (default 4, max 16).' },
        fromSeconds: { type: 'number', description: 'Absolute timeline range start (use with toSeconds).' },
        toSeconds: { type: 'number', description: 'Absolute timeline range end (use with fromSeconds).' },
        timelineId: { type: 'string', description: 'Timeline id/prefix; omit for the active timeline in this agent session.' },
      },
    },
  },
  {
    name: 'view_asset_frames',
    description: [
      'Inspect SOURCE media and see a labeled contact sheet; these coordinates never refer to the composed timeline.',
      'Pass assetId for the full pool source, or itemId to constrain sampling to that placed clip’s visible source window (srcInFrame + playbackRate aware).',
      'sourceTimesMs, frames, seconds, and fromSeconds/toSeconds are all SOURCE-MEDIA coordinates. With itemId, samples are clamped to its visible source window.',
      'Use for source selection/quality inspection; use view_timeline_frames for composed timeline proof. Audio has no frames.',
      'Default broad scan = 12 source-window midpoints, max 16. Finalized uploaded video prefers ffmpeg; blob/image/MG paths use browser or Remotion rendering.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Media-pool asset id (prefix ok).' },
        itemId: { type: 'string', description: 'Placed clip id/prefix. Uses its exact visible source window; alternative to assetId.' },
        timelineId: { type: 'string', description: 'Timeline containing itemId; omit for the active timeline.' },
        sourceTimesMs: {
          type: 'array',
          items: { type: 'number' },
          description: 'Millisecond offsets in source-media time. Accepts 1–16 values.',
        },
        frames: { type: 'array', items: { type: 'number' }, description: 'Source-media frame numbers (project/source timebase).' },
        seconds: { type: 'array', items: { type: 'number' }, description: 'Source-media seconds.' },
        count: { type: 'number', description: 'Even source-window midpoints (default 12 for video, max 16).' },
        fromSeconds: { type: 'number', description: 'Source-media range start; intersected with the clip window when itemId is used.' },
        toSeconds: { type: 'number', description: 'Source-media range end; intersected with the clip window when itemId is used.' },
      },
    },
  },
];

export const FRAMES_TOOL_NAMES = new Set(FRAMES_TOOL_SCHEMAS.map((t) => t.name));
