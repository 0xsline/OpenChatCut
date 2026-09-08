import assert from 'node:assert/strict';
import type { DisplayMessage } from './agent-session';
import type { LLMMessage } from './runtime';
import { planRetryRewind } from './retry-rewind';

const user = (text: string): DisplayMessage => ({ role: 'user', text, retry: { text } });
const assistant = (text: string): DisplayMessage => ({ role: 'assistant', text });
const tool = (name: string): DisplayMessage => ({ role: 'tool', text: '', tool: { name, args: {}, result: { ok: true } } });
const modelUser = (content: string): LLMMessage => ({ role: 'user', content });
const modelAssistant = (content: string): LLMMessage => ({ role: 'assistant', content });

// The failed last turn, with tool and error rows that exist only in the display history.
{
  const messages = [
    user('加个片头'), assistant('好的'),
    user('下载一段背景'), assistant(''), tool('download_media'), { role: 'error', text: 'Chunk timeout of 120000ms exceeded' } as DisplayMessage,
  ];
  const llm = [modelUser('加个片头'), modelAssistant('好的'), modelUser('下载一段背景'), modelAssistant('')];
  assert.deepEqual(planRetryRewind(messages, llm, 2), { messages: 2, llm: 2 });
  // Rewinding an earlier turn drops everything after it in both histories.
  assert.deepEqual(planRetryRewind(messages, llm, 0), { messages: 0, llm: 0 });
}

// Attached context is appended to the model copy of the turn; the display copy is the bare text.
{
  const messages = [user('下载一段背景')];
  const llm = [modelUser('下载一段背景\n\n{"type":"chat_context_entry","entries":[]}')];
  assert.deepEqual(planRetryRewind(messages, llm, 0), { messages: 0, llm: 0 });
  // A different suffix on the same line is a different turn.
  assert.equal(planRetryRewind(messages, [modelUser('下载一段背景视频')], 0), null);
}

// Multi-part model content (text plus an image) still identifies the turn by its text.
{
  const messages = [user('看看这张图'), assistant('看到了')];
  const llm: LLMMessage[] = [
    { role: 'user', content: [{ type: 'text', text: '看看这张图' }, { type: 'image', image: 'data:image/png;base64,AA==' }] },
    modelAssistant('看到了'),
  ];
  assert.deepEqual(planRetryRewind(messages, llm, 0), { messages: 0, llm: 0 });
}

// Display-only rows never count as user turns: the continue card and widgets do not shift the ordinal.
{
  const messages = [user('第一步'), { role: 'continue', text: '' } as DisplayMessage, user('继续')];
  const llm = [modelUser('第一步'), modelAssistant('...'), modelUser('继续')];
  assert.deepEqual(planRetryRewind(messages, llm, 2), { messages: 2, llm: 2 });
  assert.deepEqual(planRetryRewind(messages, llm, 0), { messages: 0, llm: 0 });
}

// When the histories cannot be matched the plan is null and the caller falls back to re-sending.
{
  const messages = [user('第一步'), assistant('...'), user('第二步')];
  // A model-only user message (a proposal rejection) sits after the target turn.
  const withRejection = [modelUser('第一步'), modelAssistant('...'), modelUser('第二步'), modelUser('User clicked Deny')];
  assert.equal(planRetryRewind(messages, withRejection, 2), null);
  // A compacted history no longer contains the turn.
  assert.equal(planRetryRewind(messages, [modelUser('[summary]'), modelAssistant('...')], 0), null);
  // Not a user turn, out of range, or an empty prompt.
  assert.equal(planRetryRewind(messages, [modelUser('第一步'), modelAssistant('...'), modelUser('第二步')], 1), null);
  assert.equal(planRetryRewind(messages, [], 5), null);
  assert.equal(planRetryRewind([user('   ')], [modelUser('   ')], 0), null);
}

console.log('retry-rewind.verify: ok');
