import type { AgentToolSchema } from '../../tool-schema';

export const HIGHLIGHT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'find_highlights',
    description:
      'Create short-form highlights from long-form content: read the word-level transcript of a timeline clip, use an LLM to select the strongest self-contained moments, duplicate each into a vertical sequence (default 9:16), and trim it to the selected frame range. The clip must be transcribed first with transcribe_track. Returns each sequence id, title, and frame range. Falls back to information-density heuristics if LLM selection fails.',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'Number of short videos to create; default 3.' },
        ratio: { type: 'string', enum: ['9:16', '16:9', '1:1', '4:3', '3:4'], description: 'Short-video canvas ratio; default 9:16.' },
        topic: { type: 'string', description: 'Optional: select only highlights related to this topic.' },
        instruction: { type: 'string', description: 'Optional selection preference, such as strongest emotional conflict or moments containing data points.' },
        itemId: { type: 'string', description: 'Optional transcribed video/audio clip; defaults to the clip with the most words.' },
        minSeconds: { type: 'number', description: 'Minimum duration per highlight; default 3 seconds.' },
        maxSeconds: { type: 'number', description: 'Maximum duration per highlight; default 60 seconds.' },
      },
    },
  },
];

export const HIGHLIGHT_TOOL_NAMES = new Set(HIGHLIGHT_TOOL_SCHEMAS.map((t) => t.name));
