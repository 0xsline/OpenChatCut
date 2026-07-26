// Runnable check: `npx tsx src/agent/abortedTurn.verify.ts`.
// 用户点「停止」后,会话历史必须仍然可以继续往下发:已发出的工具调用不能悬空。
// 这里验证「找出没有结果的工具调用」这条判定——它决定要补几个「已取消」结果。
import assert from 'node:assert/strict';
import { unresolvedToolCalls } from './abortedTurn';
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

// ── 全部有结果 → 没有悬空 ──
{
  assert.deepEqual(unresolvedToolCalls([text('user', 'hi'), call('t1', 'remove_item'), result('t1', 'remove_item')]), []);
  assert.deepEqual(unresolvedToolCalls([]), []);
  assert.deepEqual(unresolvedToolCalls([text('user', 'hi'), text('assistant', 'ok')]), []);
}

// ── 中途被打断:最后一个调用没有结果 ──
{
  const conv = [
    text('user', '删两段'),
    call('t1', 'remove_item'), result('t1', 'remove_item'),
    call('t2', 'remove_item'), // 用户在这里点了停止
  ];
  assert.deepEqual(unresolvedToolCalls(conv), [{ toolCallId: 't2', toolName: 'remove_item' }]);
}

// ── 一轮里并发多个调用,只有部分回来了 ──
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

// ── 结果在更后面的消息里也算数(不要求紧邻) ──
{
  const conv = [
    call('t1', 'x'),
    text('assistant', '稍等'),
    result('t1', 'x'),
  ];
  assert.deepEqual(unresolvedToolCalls(conv), []);
}

// ── 补完「已取消」之后,悬空清零(模拟 commitAbortedTurn 的收尾) ──
{
  const conv: LLMMessage[] = [text('user', 'go'), call('t9', 'submit_image')];
  const pending = unresolvedToolCalls(conv);
  assert.equal(pending.length, 1);
  conv.push({
    role: 'tool',
    content: pending.map(({ toolCallId, toolName }) => ({
      type: 'tool-result' as const,
      toolCallId,
      toolName,
      output: { type: 'execution-denied' as const, reason: 'Stopped by the user before this tool finished.' },
    })),
  } as unknown as LLMMessage);
  assert.deepEqual(unresolvedToolCalls(conv), [], '补完之后会话可以继续往下发');
}

console.log('abortedTurn.verify: ok (无悬空/单个悬空/并发部分回来/跨消息匹配/补完清零)');
