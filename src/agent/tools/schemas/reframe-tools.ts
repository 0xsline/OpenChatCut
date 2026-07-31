import type { AgentToolSchema } from '../../tool-schema';

export const REFRAME_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'auto_reframe',
    description:
      "Auto-reframe a video clip: sample its frames, detect the subject/focal point per interval, and write reframe keyframes (builtin:zoom __openchatcutReframeCurve) so the crop window follows the subject when the canvas aspect differs (e.g. 16:9→9:16). Clears the clip's existing reframe keyframes first, then re-detects. Browser-only (needs the actual video pixels); returns an error if run headless or if the target isn't a video with a source.",
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Target video clip id (prefix ok).' },
        intervalFrames: { type: 'number', description: 'Sample the video every N frames (default 15, min 1). Smaller = more keyframes, slower.' },
        sensitivity: { type: 'number', description: '0..1 focus sharpness: higher snaps the focal point harder to the strongest-detail region (default 0.5).' },
        smooth: { type: 'number', description: '0..1 temporal EMA on focal path (default 0.45). Higher = less crop jitter; 0 = raw per-frame energy.' },
        maxSamples: { type: 'number', description: 'Cap on seek samples for long clips (default 60).' },
      },
      required: ['itemId'],
    },
  },
];

export const REFRAME_TOOL_NAMES = new Set(REFRAME_TOOL_SCHEMAS.map((t) => t.name));
