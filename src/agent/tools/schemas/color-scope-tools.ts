import type { AgentToolSchema } from '../../tool-schema';

export const COLOR_SCOPE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'inspect_color',
    description: [
      'Measure color scopes of a frame BY THE NUMBERS instead of eyeballing screenshots: luma black/white points, % clipped',
      'shadows/highlights, per-channel means, warm-cool (R−B) and green-magenta balance overall AND per luma band',
      '(shadows/mids/highlights), mean saturation, and a saturation-weighted 12-bin hue histogram (30° bins from red) with',
      'dominant-hue labels — e.g. an orange cluster is usually skin, cyan/azure is usually sky.',
      'Default mode measures the COMPOSITED timeline at `frame` or `seconds` (grades/filters/effects applied, all layers',
      'stacked — to read one clip, pick a frame where it fills the screen). Pass assetId (+ sourceSeconds) to measure a RAW',
      'media-pool asset frame before any grading instead.',
      'Typical loop: inspect_color → adjust via edit_item filters / color effects / LUT looks → inspect_color again to',
      'confirm the numbers moved as intended. Use view_timeline_frames when you also want to SEE the frame.',
      'To match another shot in one call, pass referenceFrame/referenceSeconds or referenceAssetId/referenceSourceSeconds.',
      'The result includes signed target-minus-reference deltas and dead-zone-filtered named control suggestions.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        frame: { type: 'number', description: 'Timeline frame to measure (composited). Default: middle of the content.' },
        seconds: { type: 'number', description: 'Timeline time in seconds (alternative to frame).' },
        assetId: { type: 'string', description: 'Measure a RAW media-pool asset instead of the timeline (prefix id ok).' },
        sourceSeconds: { type: 'number', description: 'Asset mode only: source time to sample (default: asset midpoint).' },
        referenceFrame: { type: 'number', description: 'Reference timeline frame to compare against.' },
        referenceSeconds: { type: 'number', description: 'Reference timeline time in seconds (alternative to referenceFrame).' },
        referenceAssetId: { type: 'string', description: 'Compare against a RAW media-pool asset frame (prefix id ok).' },
        referenceSourceSeconds: { type: 'number', description: 'Reference asset source time (default: midpoint).' },
      },
    },
  },
];

export const COLOR_SCOPE_TOOL_NAMES = new Set(COLOR_SCOPE_TOOL_SCHEMAS.map((t) => t.name));
