import type { AgentToolSchema } from '../../tool-schema';

/** Cross-project full-text search over chats, captions and transcripts. */
export const SEARCH_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'search_content',
    description: [
      'Search project content across the local library: agent chat messages, caption texts and',
      'transcript words (FTS5, Chinese-aware segmentation). Use when the user asks "where did I',
      'say X" / "which project has the caption about Y" / referencing earlier edits or words.',
      'Returns per-hit kind (chat|caption|transcript), projectId, ref and score, best first.',
      'Query is segmented with the same dictionary as the index, so 2-char Chinese words work.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Content to find, e.g. 背景音乐音量 / 字幕样式 / 黄昏的海边' },
        projectId: {
          type: 'string',
          description: 'Optional project id to scope the search; omit to search every project.',
        },
        limit: { type: 'number', description: 'Optional max hits (default 20, max 50).' },
      },
      required: ['query'],
    },
  },
];

export const SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(
  SEARCH_TOOL_SCHEMAS.map((tool) => tool.name),
);
