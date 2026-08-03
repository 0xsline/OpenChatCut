import type { AgentToolSchema } from '../../tool-schema';

export const FONT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'search_fonts',
    description: [
      'Search the font catalog the local/headless renderer can load (Google Fonts bundled in-app',
      '+ locally bundled Chinese foundry faces, source:"bundled"). Use when export reports unsupported',
      'fonts or when picking fontFamily for motion-graphic items / captions. Returns canonical family',
      'names to use verbatim. Substring-matches family AND native-name aliases',
      '(case/punctuation-insensitive) — e.g. "inter", "playfair", "noto sc", "思源黑体", "得意黑",',
      '"抖音美好体". loadable=false means catalogued only; prefer a loadable alternative or',
      'confirmFontFallback on export.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to match against font family names or native-name aliases.',
        },
        projectId: {
          type: 'string',
          description: 'Ignored; the active project is used.',
        },
      },
      required: ['query'],
    },
  },
];

export const FONT_TOOL_NAMES = new Set(FONT_TOOL_SCHEMAS.map((t) => t.name));
