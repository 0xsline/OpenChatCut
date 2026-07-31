// Runnable check: `npx tsx src/agent/abortedTurn.verify.ts`.
// After the user clicks "Stop", the session history must still be able to continue to be sent down: the tool calls that have been issued cannot be left hanging.
// Here we verify the judgment "Find tool calls without results" - it determines how many "cancelled" results should be added.
import assert from 'node:assert/strict';
import { completeAbortedTurn, unresolvedToolCalls } from './abortedTurn';
import type { ModelMessage as LLMMessage } from 'ai';

const call = (id: string, name: string): LLMMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: {} }],
} as unknown as LLMMessage);

const result = (id: string, name: string): LLMMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: name, output: { type: 'text', value: '{}' } }],
} as unknown as LLMMessage);

const text = (role: 'user' | 'assistant', value: string): LLMMessage => ({
  role, content: [{ type: 'text', text: value }],
} as unknown as LLMMessage);

// ── All have results → No dangling ──
{
  assert.deepEqual(unresolvedToolCalls([text('user', 'hi'), call('t1', 'remove_item'), result('t1', 'remove_item')]), []);
  assert.deepEqual(unresolvedToolCalls([]), []);
  assert.deepEqual(unresolvedToolCalls([text('user', 'hi'), text('assistant', 'ok')]), []);
}

// ── Interrupted midway: The last call has no result ──
{
  const conv = [
    text('user', '删两段'),
    call('t1', 'remove_item'), result('t1', 'remove_item'),
    call('t2', 'remove_item'), // The user clicked stop here
  ];
  assert.deepEqual(unresolvedToolCalls(conv), [{ toolCallId: 't2', toolName: 'remove_item' }]);
}

// ── Multiple calls are made concurrently in one round, only some of them come back ──
{
  const conv: LLMMessage[] = [
    text('user', '看看这几段'),
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'a', toolName: 'read_timeline', input: {} },
        { type: 'tool-call', toolCallId: 'b', toolName: 'view_asset_frames', input: {} },
        { type: 'tool-call', toolCallId: 'c', toolName: 'detect_beats', input: {} },
      ],
    } as unknown as LLMMessage,
    result('b', 'view_asset_frames'),
  ];
  assert.deepEqual(unresolvedToolCalls(conv), [
    { toolCallId: 'a', toolName: 'read_timeline' },
    { toolCallId: 'c', toolName: 'detect_beats' },
  ], '没回来的两个都要补收尾,顺序按发出顺序');
}

// ── The result is also counted in later messages (immediate proximity is not required) ──
{
  const conv = [
    call('t1', 'x'),
    text('assistant', '稍等'),
    result('t1', 'x'),
  ];
  assert.deepEqual(unresolvedToolCalls(conv), []);
}

// ── After completing "Cancelled", clear it in the air (simulating the end of commitAbortedTurn) ──
{
  const history = [text('user', 'go')];
  const completed = completeAbortedTurn(history, [call('t9', 'submit_image')]);
  assert.equal(completed.length, 3, '模型已经返回的消息必须保留');
  assert.deepEqual(unresolvedToolCalls(completed), [], '补完之后会话可以继续往下发');
}

console.log('abortedTurn.verify: ok (无悬空/单个悬空/并发部分回来/跨消息匹配/补完清零)');
