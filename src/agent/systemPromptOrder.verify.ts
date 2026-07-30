// Runnable check: `npx tsx src/agent/systemPromptOrder.verify.ts`.
//
// 提示词缓存匹配的是**逐字节前缀**。只要每轮都变的那段(时间线快照)排在中间,它后面的
// 一切——其余段落、上百个工具 schema、整段对话历史——每轮都得重新计费,而一次用户消息
// 最多能跑 MAX_TOOL_TURNS 轮。所以这里守的不变式是:**易变段永远是最后一段**,
// 两次调用之间只要稳定段没变,公共前缀就必须一路覆盖到易变段开头。
import assert from 'node:assert/strict';
import { agentLanguagePrompt, assembleSystemPrompt, designStylePrompt, editorStatePrompt, SYSTEM_PROMPT } from './systemPrompt';
import type { AgentContext } from './context';
import type { ProjectDoc, TimelineItem, TimelineState } from '../editor/types';

const commonPrefixLength = (a: string, b: string): number => {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
};

// ── 拼装规则:稳定段原样在前,易变段收尾 ──
{
  const stable = ['AAA', 'BBB', 'CCC'];
  assert.equal(assembleSystemPrompt(stable, '<state/>'), 'AAABBBCCC<state/>');
  assert.equal(assembleSystemPrompt(stable, ''), 'AAABBBCCC', '易变段为空也不留多余分隔');
  assert.equal(assembleSystemPrompt([], 'x'), 'x');

  // 不变式是「**至少**覆盖全部稳定段」;两个易变段本身若碰巧同头,公共前缀只会更长。
  // 这里特意选无公共开头的两段,让边界正好落在稳定段末尾。
  const one = assembleSystemPrompt(stable, 'XXX-1');
  const two = assembleSystemPrompt(stable, 'YYY-2-LONGER');
  assert.equal(
    commonPrefixLength(one, two),
    stable.join('').length,
    '公共前缀必须覆盖全部稳定段——短一个字节就意味着有易变内容混进了前缀',
  );
}

{
  assert.match(agentLanguagePrompt('zh'), /interface language is Chinese/);
  assert.match(agentLanguagePrompt('zh'), /in Chinese/);
  assert.match(agentLanguagePrompt('en'), /interface language is English/);
  assert.match(agentLanguagePrompt('en'), /in English/);
}

// ── 用真的 editorStatePrompt 走一遍:改时间线不能动到前缀 ──
{
  const item = (id: string, startFrame: number): TimelineItem => ({
    id, track: 'V1', startFrame, durationInFrames: 60,
    kind: 'video', name: id, src: '/m/a.mp4',
  } as TimelineItem);

  const ctxOf = (items: TimelineItem[]): AgentContext => {
    const state: TimelineState = {
      fps: 30, width: 1920, height: 1080, selectedId: null,
      tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'], items,
    };
    const doc = {
      version: 3, assets: [], mediaFolders: [], activeTimelineId: 'tl1',
      timelines: [{ ...state, id: 'tl1', name: 'main', order: 0 }],
    } as unknown as ProjectDoc;
    return { getState: () => state, getDoc: () => doc } as unknown as AgentContext;
  };

  const stable = ['SYSTEM', 'CAPS', 'SKILLS'];
  const before = assembleSystemPrompt(stable, editorStatePrompt(ctxOf([item('a', 0)])));
  const after = assembleSystemPrompt(stable, editorStatePrompt(ctxOf([item('a', 0), item('b', 60)])));

  assert.notEqual(before, after, '时间线变了,易变段当然要变');
  assert.ok(
    commonPrefixLength(before, after) >= stable.join('').length,
    '加一个片段只能影响末尾那段;前缀一动,工具 schema 和历史的缓存就全废了',
  );
  assert.equal(before.slice(0, stable.join('').length), stable.join(''), '稳定段逐字节不变');
  assert.ok(before.includes('<editor_state>'), '快照确实拼进来了');
  assert.ok(
    before.indexOf('<editor_state>') >= stable.join('').length,
    '快照整段都落在稳定段之后',
  );
}

// ── 稳定段自身变化(比如换了创作模式)时,变化点不能提前到更早的段落 ──
{
  // 同样选无公共开头的两个取值,好让边界正好落在变化的那一段起点。
  const a = assembleSystemPrompt(['SYSTEM', 'CAPS', 'AAAA'], 'S');
  const b = assembleSystemPrompt(['SYSTEM', 'CAPS', 'BBBB'], 'S');
  assert.equal(commonPrefixLength(a, b), 'SYSTEMCAPS'.length, '只从真正变化的那一段开始失效');
}

// ── 工程创作指引会进入提示词，并覆盖所有编辑而非只约束 MG ──
{
  const prompt = designStylePrompt({
    colors: [],
    fonts: [],
    styleGuide: '字幕保持两行以内，避免炫光转场。',
  });
  assert.match(prompt, /字幕保持两行以内/);
  assert.match(prompt, /所有编辑都必须遵守/);
  assert.match(SYSTEM_PROMPT, /创作方向和素材计划/);
}

console.log('systemPromptOrder.verify: ok (易变段收尾/真 editorStatePrompt 不污染前缀/失效点最小化)');
