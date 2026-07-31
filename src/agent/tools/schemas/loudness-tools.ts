import type { AgentToolSchema } from '../../tool-schema';

export const LOUDNESS_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'normalize_loudness',
    description:
      'Normalize audio clip(s) to a target integrated loudness (LUFS) by analyzing each clip offline (WebAudio) and applying the computed gain as the clip volume. Defaults to -14 LUFS (streaming loudness standard). To normalize MANY/all clips, call this ONCE with NO itemId — a single call processes every audio clip on the active timeline and returns per-clip results ({itemId, measuredLufs, gain}). Do NOT call it once per clip. Pass itemId ONLY to normalize a single specific clip.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'number', description: 'Target integrated loudness in LUFS (default -14).' },
        itemId: { type: 'string', description: 'Normalize only this clip (prefix id ok). Omit to normalize all audio clips.' },
      },
    },
  },
];

export const LOUDNESS_TOOL_NAMES = new Set(LOUDNESS_TOOL_SCHEMAS.map((t) => t.name));
