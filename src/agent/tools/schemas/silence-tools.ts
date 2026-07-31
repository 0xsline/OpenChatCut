import type { AgentToolSchema } from '../../tool-schema';

const SILENCE_DEFAULTS = {
  thresholdDb: -26,
  minSilenceMs: 600,
  padMs: 150,
} as const;

export const SILENCE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'remove_silence',
    description: [
      'Remove dead air — quiet, speech-free stretches — from clips, ripple-closing each gap on its own track (ONE undoable batch).',
      'Detection is on-device and relative: a stretch counts as silence only when its level sits well below the clip\'s own speech level',
      '(so music beds and loud ambience are never cut), it lasts at least minSilenceMs, and a padMs breathing room is kept on both sides.',
      'Use this to tighten pacing (long pauses, dead space between takes). It complements word-level editing:',
      'transcribed clips that already have word edits or gap caps are skipped — use clean_script there, it trims pauses word-precisely.',
      'Clips with playbackRate≠1 or an animated zoom are skipped (reported in skipped[]). Ripple is per-track: other tracks do not shift.',
      'Call once with NO itemId to sweep every audio/video clip on the active timeline; pass itemId for a single clip.',
      'Pass dryRun:true to preview the cut list (seconds) without editing.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Only this clip (prefix id ok). Omit to process every audio/video clip.' },
        thresholdDb: { type: 'number', minimum: -60, maximum: -6, description: `Silence gate relative to the clip's speech level in dB (default ${SILENCE_DEFAULTS.thresholdDb}; more negative = more conservative).` },
        minSilenceMs: { type: 'number', minimum: 200, maximum: 10000, description: `Only remove pauses at least this long (default ${SILENCE_DEFAULTS.minSilenceMs}ms).` },
        padMs: { type: 'number', minimum: 0, maximum: 1000, description: `Breathing room kept on each side of a cut (default ${SILENCE_DEFAULTS.padMs}ms).` },
        dryRun: { type: 'boolean', description: 'true = report the would-be cuts without editing.' },
      },
    },
  },
];

export const SILENCE_TOOL_NAMES = new Set(SILENCE_TOOL_SCHEMAS.map((t) => t.name));
