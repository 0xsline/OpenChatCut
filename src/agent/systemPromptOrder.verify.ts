// Runnable check: `npx tsx src/agent/systemPromptOrder.verify.ts`.
//
// The prompt word cache matches the **byte-by-byte prefix**. As long as the part that changes every round (timeline snapshot) is in the middle, the ones behind it
// Everything - the rest of the paragraphs, the hundreds of tool schemas, the entire conversation history - has to be re-billed every round, and a user message
// Can run up to MAX_TOOL_TURNS rounds. So the invariant observed here is: **The variable section is always the last section**,
// As long as the stable section does not change between calls, the public prefix must be covered all the way to the beginning of the volatile section.
import assert from 'node:assert/strict';
import {
  PRODUCT_IDENTITY_PROMPT,
  SYSTEM_PROMPT,
  agentLanguagePrompt,
  assembleSystemPrompt,
  buildAgentSystemPrompt,
  confirmationModePrompt,
  designStylePrompt,
  editorStatePrompt,
} from './systemPrompt';
import { buildCodexSystemPrompt } from './codex/runtime';
import { DEFAULT_AGENT_SETTINGS } from './settings/agentSettings';
import type { AgentContext } from './context';
import type { ProjectDoc, TimelineItem, TimelineState } from '../editor/types';

const commonPrefixLength = (a: string, b: string): number => {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
};

// ── Assembly rules: Stable sections come first, and variable sections end ──
{
  const stable = ['AAA', 'BBB', 'CCC'];
  assert.equal(assembleSystemPrompt(stable, '<state/>'), 'AAABBBCCC<state/>');
  assert.equal(assembleSystemPrompt(stable, ''), 'AAABBBCCC', '易变段为空也不留多余分隔');
  assert.equal(assembleSystemPrompt([], 'x'), 'x');

  // The invariant is "**at least** covering all stable segments"; if the two volatile segments happen to have the same head, the common prefix will only be longer.
  // Here we deliberately select two paragraphs with no common beginning, so that the boundary falls exactly at the end of the stable paragraph.
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

// ── Public product identity must override stale names in workflows or conversation memory ──
{
  const workflow = '\n<selected_skill>A legacy workflow calls this product AnotherChatCut.</selected_skill>';
  const system = assembleSystemPrompt([
    SYSTEM_PROMPT,
    workflow,
    PRODUCT_IDENTITY_PROMPT,
  ], '<editor_state/>');

  assert.match(PRODUCT_IDENTITY_PROMPT, /official product name is OpenChatCut/);
  assert.match(PRODUCT_IDENTITY_PROMPT, /Do not inherit product identity/);
  assert.ok(
    system.indexOf(PRODUCT_IDENTITY_PROMPT) > system.indexOf(workflow),
    'product identity should follow selected workflow instructions so stale names cannot override it',
  );
}

// ── Go through it with the real editorStatePrompt: you cannot change the prefix when changing the timeline ──
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
    return {
      getState: () => state,
      getDoc: () => doc,
      getCreativeMode: () => null,
    } as unknown as AgentContext;
  };

  const promptContext = ctxOf([item('a', 0)]);
  const apiPrompt = buildAgentSystemPrompt(promptContext, DEFAULT_AGENT_SETTINGS);
  const codexPrompt = buildCodexSystemPrompt(promptContext);
  assert.ok(
    apiPrompt.includes(PRODUCT_IDENTITY_PROMPT),
    'the central API prompt builder must include the product identity section',
  );
  assert.equal(
    codexPrompt,
    apiPrompt,
    'Codex and API backends must share the central prompt builder',
  );

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

// ── When the stable paragraph itself changes (such as changing the creative mode), the change point cannot be advanced to an earlier paragraph ──
{
  // Similarly select two values with no common beginning, so that the boundary falls exactly at the starting point of the changing section.
  const a = assembleSystemPrompt(['SYSTEM', 'CAPS', 'AAAA'], 'S');
  const b = assembleSystemPrompt(['SYSTEM', 'CAPS', 'BBBB'], 'S');
  assert.equal(commonPrefixLength(a, b), 'SYSTEMCAPS'.length, '只从真正变化的那一段开始失效');
}

// ── The project creation guide will enter the prompt word and cover all edits instead of just constraining MG ──
{
  const prompt = designStylePrompt({
    colors: [],
    fonts: [],
    styleGuide: '字幕保持两行以内，避免炫光转场。',
  });
  assert.match(prompt, /字幕保持两行以内/);
  assert.match(prompt, /Follow it for every edit/);
  assert.match(SYSTEM_PROMPT, /creative direction and asset plan/);
  assert.match(SYSTEM_PROMPT, /Never claim or imply success after an unresolved tool failure/);
}

// ── Auto-apply mode appends a late override; manual mode stays byte-identical ──
{
  assert.equal(confirmationModePrompt('manual'), '', 'manual (ask) mode must not change the static prompt');
  const auto = confirmationModePrompt('auto');
  assert.match(auto, /# Auto-apply mode \(YOLO\)/);
  assert.match(auto, /overrides the '# Planning and confirmation' rules above/);
  assert.match(auto, /do NOT stop between major stages for confirmation/i);
  assert.match(auto, /do NOT confirm the creative direction or asset plan/i);
  const autoCtx = {
    getState: () => ({ fps: 30, width: 1920, height: 1080, selectedId: null, tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'], items: [] }),
    getDoc: () => ({ version: 3, assets: [], mediaFolders: [], activeTimelineId: 'tl1', timelines: [] }),
    getCreativeMode: () => null,
    getApprovalMode: () => 'auto',
  } as unknown as AgentContext;
  assert.ok(
    buildAgentSystemPrompt(autoCtx, DEFAULT_AGENT_SETTINGS).includes('# Auto-apply mode (YOLO)'),
    'auto-apply mode must inject the YOLO override into the built prompt',
  );
}

console.log('systemPromptOrder.verify: ok (易变段收尾/真 editorStatePrompt 不污染前缀/失效点最小化)');
