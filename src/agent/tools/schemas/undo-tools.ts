import type { AgentToolSchema } from '../../tool-schema';

export const UNDO_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'undo_last_change',
    description: [
      'Revert the project to its state before the most recent applied change — use it when the user asks to undo,',
      'roll back, or take back the last edit. Proposed like any other edit, so the user still confirms it,',
      'and the revert itself stays undoable. It only reaches changes that were already APPLIED:',
      'edits still pending in the current proposal are dropped by rejecting that proposal, not with this tool.',
      'Call it once per undo step; to undo several steps, ask the user to confirm each.',
    ].join(' '),
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

export const UNDO_TOOL_NAMES = new Set(UNDO_TOOL_SCHEMAS.map((t) => t.name));
