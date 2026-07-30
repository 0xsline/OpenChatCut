import type { AgentToolSchema } from '../../tool-schema';

const DEFAULT_MARKER_CAP = 120;

export const BEAT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'detect_beats',
    description: [
      'Detect musical beats and downbeats in a media asset\'s audio, on-device (no model, no network): returns bpm, a',
      'confidence ratio (trust results at ≥2; <1.2 yields no beats — speech/ambience are gated out), beats and downbeats in',
      'SOURCE seconds. Downbeats mark 4/4 bar starts — cut on downbeats for edits that land musically; beats suit faster',
      'montage rhythm. Works best on steady-tempo music; analyze tempo-changing tracks in sections via separate clips.',
      'Pass assetId (media pool) for raw analysis, or itemId (timeline clip) to ALSO get timelineFrames mapped through the',
      'clip\'s trim and speed — ready for split/move/markers. With itemId you can set markers:"beats"|"downbeats" to drop',
      'clip-anchored timeline markers at the detected points in one undoable batch (cyan=beat, purple=downbeat).',
      'To place a cut on a beat B (source seconds) manually: timelineFrame = startFrame + round((B×fps − srcInFrame) / playbackRate).',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Media-pool asset id (prefix ok) — raw source analysis.' },
        itemId: { type: 'string', description: 'Timeline clip id (prefix ok) — adds timelineFrames mapping and enables markers.' },
        markers: { type: 'string', enum: ['none', 'beats', 'downbeats'], description: 'itemId only: also create clip-anchored markers at these points (default none).' },
        markerLimit: { type: 'number', minimum: 1, maximum: 500, description: `Cap created markers (default ${DEFAULT_MARKER_CAP}).` },
      },
    },
  },
];

export const BEAT_TOOL_NAMES = new Set(BEAT_TOOL_SCHEMAS.map((t) => t.name));
