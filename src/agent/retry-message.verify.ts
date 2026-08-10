import assert from 'node:assert/strict';
import { createAgentRetry, ensureAgentRetryMetadata } from './agent-session';
import type { AgentReference } from './context';

const reference: AgentReference = { id: 'asset-1', name: '素材', kind: 'video' };
const options = { askOnly: true, references: [reference] };
const retry = createAgentRetry('  生成字幕  ', options);
assert.deepEqual(retry, {
  text: '生成字幕',
  askOnly: true,
  references: [reference],
}, 'retry payload preserves the original prompt, mode, and references');
assert.notEqual(retry?.references, options.references, 'retry payload owns its reference array');
assert.equal(createAgentRetry('   '), undefined, 'empty prompts cannot be retried');

const existing = createAgentRetry('已经带元数据', { askOnly: true });
const hydrated = ensureAgentRetryMetadata([
  { role: 'user', text: '历史用户消息' },
  { role: 'assistant', text: '历史回答' },
  { role: 'user', text: '已经带元数据', retry: existing },
]);
assert.deepEqual(hydrated[0], {
  role: 'user',
  text: '历史用户消息',
  retry: { text: '历史用户消息' },
}, 'legacy user messages receive retry metadata during hydration');
assert.deepEqual(hydrated[1], { role: 'assistant', text: '历史回答' }, 'assistant messages are unchanged');
assert.equal(hydrated[2].retry, existing, 'existing retry metadata is preserved');

console.log('retry-message.verify: ok');
