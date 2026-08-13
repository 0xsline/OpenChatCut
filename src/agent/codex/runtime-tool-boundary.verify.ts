import assert from 'node:assert/strict';
import type { AgentContext } from '../context.ts';
import { INITIAL } from '../../editor/initial.ts';
import { docFromTimeline } from '../../persist/projectStore.ts';
import { DEFAULT_AGENT_SETTINGS } from '../settings/agentSettings.ts';
import { TOOL_SCHEMAS } from '../tools.ts';
import { executeOpenChatCutTool } from './runtime.ts';

const context: AgentContext = {
  commands: {} as AgentContext['commands'],
  getState: () => INITIAL,
  getDoc: () => docFromTimeline(INITIAL),
  getCreativeMode: () => null,
  templates: [],
  audio: [],
  getProjectId: () => 'project-1',
};

const removeItemSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'remove_item');
assert.ok(removeItemSchema);
const rejectedMutation = await executeOpenChatCutTool(
  removeItemSchema,
  { itemId: 'missing' },
  {
    ctx: context,
    onEvent: () => undefined,
    settings: DEFAULT_AGENT_SETTINGS,
  },
);
assert.equal(rejectedMutation.success, false);
assert.match(JSON.stringify(rejectedMutation.result), /no item missing/);

const followupSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'ask_followup_questions');
assert.ok(followupSchema);
const settlementOrder: string[] = [];
const settledFollowup = await executeOpenChatCutTool(
  followupSchema,
  { fields: [{ id: 'style', label: 'Which style?', type: 'text' }] },
  {
    ctx: context,
    onEvent: (event) => {
      if (event.type === 'tool') settlementOrder.push(`tool:${event.name}`);
    },
    settings: DEFAULT_AGENT_SETTINGS,
    onFollowup: () => settlementOrder.push('followup'),
  },
);
assert.equal(settledFollowup.success, true);
assert.deepEqual(
  settlementOrder,
  ['followup', 'tool:ask_followup_questions'],
  'the real tool boundary exposes the follow-up before emitting its tool event',
);

console.log('codex runtime tool boundary verification passed');
