import type { AgentToolSchema } from '../../tool-schema';

export const SCRIPT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'read_script',
    description:
      'Materialize the current timeline as timeline.md (segment-id-coded Markdown). Track sections (## V1/A1…), source regions (### file), rows: [sN] transcript sentence / [cN] Nf clip / [gap Nf]. Body order = playback order. Read this before apply_script; edit the TEXT then pass it back. Keep the <!-- script-stamp --> comment intact.',
    input_schema: {
      type: 'object',
      properties: {
        track: { type: 'string', description: 'Optional timeline track alias/id. Omit to keep the existing full-timeline behavior.' },
        showSilence: { type: 'boolean', description: 'Include editable [silence=Ns] markers. Default false.' },
      },
    },
  },
  {
    name: 'apply_script',
    description:
      'Commit an edited timeline.md back to the timeline (atomic; any invalid row rejects the whole script). Edit grammar: strike words inside a [sN] row with ~~word~~ (delete text = delete video); strike or delete a whole row to remove it; reorder rows to reorder clips (frames are re-derived from body order — never write frame numbers); deleting a [gap Nf] row closes the gap. Re-adding previously deleted words restores them. Do NOT change spoken words. preview=true validates and reports without changing anything.',
    input_schema: {
      type: 'object',
      properties: {
        timelineMd: { type: 'string', description: 'The FULL edited timeline.md content (from read_script, with your edits).' },
        preview: { type: 'boolean', description: 'true = validate + report the diff without applying.' },
        track: { type: 'string', description: 'Optional timeline track alias/id. Use the same scope as read_script.' },
      },
      required: ['timelineMd'],
    },
  },
];

export const SCRIPT_TOOL_NAMES = new Set(SCRIPT_TOOL_SCHEMAS.map((t) => t.name));
