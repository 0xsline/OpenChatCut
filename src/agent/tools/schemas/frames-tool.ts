import type { AgentToolSchema } from '../../tool-schema';

export const FRAMES_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'view_timeline_frames',
    description: [
      'Render still frames of the CURRENT timeline composition and SEE them as images (pending/draft edits included).',
      'Use after visual edits (MG/text, transitions, zoom, filters, aspect, captions) to verify the result before finishing.',
      'Provide exact frames, seconds, or count; with neither, samples evenly (default 4, max 16).',
      'Multi-frame results come back as ONE labeled contact-sheet JPEG when possible.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        frames: { type: 'array', items: { type: 'number' }, description: 'Exact frame numbers to render.' },
        seconds: { type: 'array', items: { type: 'number' }, description: 'Times in seconds (converted by timeline fps).' },
        count: { type: 'number', description: 'Even midpoints across the full timeline (default 4, max 16).' },
        fromSeconds: { type: 'number', description: 'Optional range start (with toSeconds) for focused sampling.' },
        toSeconds: { type: 'number', description: 'Optional range end (exclusive-ish; with fromSeconds).' },
        timelineId: { type: 'string', description: 'Override the active timeline by id or prefix without switching timelines.' },
      },
    },
  },
  {
    name: 'view_asset_frames',
    description: [
      'Inspect a SOURCE media-pool asset (not the timeline) and SEE a labeled contact sheet.',
      'Use for B-roll selection, finding a logo/moment, judging shot quality, long-clip high-light scanning.',
      'Prefer sourceTimesMs for precise ms samples; or count/fromSeconds/toSeconds for a broad scan',
      '(default 12 midpoints, max 16). Video files on /media/uploads use fast ffmpeg; MG/images use Remotion.',
      'NOT for timeline proof — use view_timeline_frames after edits. Audio has no frames.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Media-pool asset id (prefix ok).' },
        sourceTimesMs: {
          type: 'array',
          items: { type: 'number' },
          description: 'Millisecond offsets into the source video. Accepts 1–16 values.',
        },
        frames: { type: 'array', items: { type: 'number' }, description: 'Frame numbers within the asset (fps-based).' },
        seconds: { type: 'array', items: { type: 'number' }, description: 'Times in seconds within the asset.' },
        count: { type: 'number', description: 'Even midpoints across range (default 12 for video scan, max 16).' },
        fromSeconds: { type: 'number', description: 'Range start for scanning a sub-span of a long clip.' },
        toSeconds: { type: 'number', description: 'Range end for scanning a sub-span.' },
      },
      required: ['assetId'],
    },
  },
];

export const FRAMES_TOOL_NAMES = new Set(FRAMES_TOOL_SCHEMAS.map((t) => t.name));
