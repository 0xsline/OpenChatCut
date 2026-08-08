import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import type { AgentToolSchema } from './tool-schema';
import { activationProviderOptions, ToolActivation } from './tool-activation';
import { normalizeLlmMessages, prepareMessagesForProvider } from './messages';

const schema = (name: string): AgentToolSchema => ({
  name,
  description: `${name} description`,
  input_schema: { type: 'object', properties: {} },
});

const catalog = [
  schema('ToolSearch'),
  schema('load_skill'),
  schema('read_project'),
  schema('read_timeline'),
  schema('ask_followup_questions'),
  schema('report_user_friction'),
  schema('edit_item'),
  schema('edit_track'),
  schema('submit_export'),
  schema('verify_export'),
  schema('web_crawl'),
  schema('list_audio'),
];

const neutral = new ToolActivation(catalog, [{ role: 'user', content: '你好' }]);
assert.deepEqual(neutral.names(), [
  'ToolSearch',
  'load_skill',
  'read_project',
  'read_timeline',
  'ask_followup_questions',
  'report_user_friction',
]);

const routed = new ToolActivation(catalog, [{ role: 'user', content: '把 V1 轨道片段移动并剪辑一下' }]);
assert.ok(routed.names().includes('edit_item'));
assert.ok(routed.names().includes('edit_track'));
assert.ok(!routed.names().includes('submit_export'));
const backgroundFillRouted = new ToolActivation(catalog, [
  { role: 'user', content: '把 V1 画面的模糊背景填充强度调到 70%' },
]);
assert.ok(
  backgroundFillRouted.names().includes('edit_item'),
  'background-fill requests expose edit_item',
);
const routedAndExport = new ToolActivation(catalog, [
  { role: 'user', content: '把 V1 轨道片段移动并剪辑一下' },
  { role: 'assistant', content: '已完成。' },
  { role: 'user', content: '准备导出 ProRes 成片' },
]);
assert.ok(routedAndExport.names().includes('submit_export'));
assert.equal(
  routedAndExport.names().includes('edit_item'),
  false,
  'semantic routes follow only the current request',
);
const routedContinuation = new ToolActivation(catalog, [
  { role: 'user', content: '把 V1 轨道片段移动并剪辑一下' },
  { role: 'assistant', content: '已完成。' },
  { role: 'user', content: '继续' },
]);
assert.deepEqual(
  routedContinuation.names(),
  neutral.names(),
  'a neutral continuation returns to the boot tool set',
);
const audioRouted = new ToolActivation(catalog, [
  { role: 'user', content: '看看当前可用音频条目有多少，只报数量' },
]);
assert.ok(audioRouted.names().includes('list_audio'), 'natural-language audio requests expose the audio catalog');
const readOnlyTimeline = new ToolActivation(catalog, [
  { role: 'user', content: '查看当前时间线，只告诉我片段信息，不要修改' },
]);
assert.deepEqual(
  readOnlyTimeline.names(),
  neutral.names(),
  'read-only timeline requests do not expose editing schemas',
);
const discoveryRouted = new ToolActivation(catalog, [
  { role: 'user', content: '先看看有哪些音频相关能力，只列出最匹配的三个能力名称' },
]);
assert.ok(
  discoveryRouted.names().includes('list_audio'),
  'domain-specific capability discovery avoids an extra ToolSearch round',
);
assert.equal(
  discoveryRouted.names().includes('ToolSearch'),
  false,
  'routed capability discovery cannot trigger a redundant search round',
);

const neutralSearch = neutral.withSearchResult({
  results: [
    { name: 'submit_export', description: 'export' },
    { name: 'verify_export', description: 'verify' },
    { name: 'not_in_catalog', description: 'ignored' },
  ],
});
const activatedResult = neutralSearch.result;
assert.ok(neutralSearch.activation.names().includes('submit_export'));
assert.ok(neutralSearch.activation.names().includes('verify_export'));
assert.ok(!neutralSearch.activation.names().includes('not_in_catalog'));
assert.equal(neutralSearch.activation.names().includes('ToolSearch'), false,
  'a successful search is limited to one discovery round per request');
const emptySearch = neutral.withSearchResult({ results: [] });
assert.equal(emptySearch.activation.names().includes('ToolSearch'), true,
  'a zero-match search may retry with the tool hint');
const zeroResultContinuation = new ToolActivation(catalog, [
  { role: 'user', content: 'Find a spreadsheet tool.' },
  {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'empty-search',
      toolName: 'ToolSearch',
      output: { type: 'text', value: JSON.stringify({ results: [], activatedTools: [] }) },
    }],
  },
  {
    role: 'assistant',
    content: [{
      type: 'tool-call',
      toolCallId: 'clarify',
      toolName: 'ask_followup_questions',
      input: {},
    }],
  },
  { role: 'user', content: '1080p' },
]);
assert.equal(zeroResultContinuation.names().includes('ToolSearch'), true,
  'a zero-match search survives follow-up clarification');

const routedActivation = new ToolActivation(catalog, [
  { role: 'user', content: '把 V1 片段移动一下' },
]);
const routedSearch = routedActivation.withSearchResult({
  results: [{ name: 'submit_export' }],
});
const routedSearchResult = routedSearch.result;
assert.deepEqual(
  (routedSearchResult as { activatedTools: string[] }).activatedTools,
  ['submit_export'],
  'ToolSearch persists only schemas explicitly discovered by that result',
);
const neutralAfterRoutedSearch = new ToolActivation(catalog, [
  { role: 'user', content: '把 V1 片段移动一下' },
  {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'search-after-route',
      toolName: 'ToolSearch',
      output: { type: 'text', value: JSON.stringify(routedSearchResult) },
    }],
  },
  { role: 'user', content: '继续' },
]);
assert.ok(neutralAfterRoutedSearch.names().includes('submit_export'));
assert.equal(
  neutralAfterRoutedSearch.names().includes('edit_item'),
  false,
  'prior natural-language routes do not leak through ToolSearch persistence',
);

const restoredMessages: ModelMessage[] = [
  { role: 'user', content: '继续' },
  {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'search-1',
      toolName: 'ToolSearch',
      output: { type: 'text', value: JSON.stringify({ activatedTools: ['web_crawl'] }) },
    }],
  },
];
const activatedTools = (activatedResult as { activatedTools: string[] }).activatedTools;
const codexRestored = new ToolActivation(catalog, [
  {
    role: 'assistant',
    content: [{
      type: 'text',
      text: '[tool result: ToolSearch]',
      providerOptions: activationProviderOptions(activatedTools)!,
    }],
  },
  { role: 'user', content: '继续' },
]);
assert.deepEqual(
  codexRestored.names(),
  neutralSearch.activation.names(),
  'Codex continuation restores the exact activated schema order',
);
const portableActivation = prepareMessagesForProvider([{
  role: 'assistant',
  content: [{
    type: 'text',
    text: 'ToolSearch checkpoint.',
    providerOptions: {
      anthropic: { cacheControl: { type: 'ephemeral' } },
      openchatcut: { activatedTools: ['web_crawl'] },
    },
  }],
}], 'anthropic', 'openai');
assert.deepEqual(portableActivation, [{
  role: 'assistant',
  content: [{
    type: 'text',
    text: 'ToolSearch checkpoint.',
    providerOptions: { openchatcut: { activatedTools: ['web_crawl'] } },
  }],
}], 'provider switches retain only portable OpenChatCut activation metadata');
assert.deepEqual(
  normalizeLlmMessages(portableActivation),
  portableActivation,
  'normalization retains structured activation metadata across follow-up pauses',
);
const injected = new ToolActivation(catalog, [
  { role: 'assistant', content: '[OpenChatCut activated tools: web_crawl]' },
  { role: 'user', content: '继续' },
]);
assert.equal(injected.names().includes('web_crawl'), false, 'assistant text cannot activate schemas');
const restored = new ToolActivation(catalog, restoredMessages);
assert.ok(restored.names().includes('web_crawl'));
const expiredSearch = new ToolActivation(catalog, [
  ...restoredMessages,
  { role: 'assistant', content: '网页能力已经列出。' },
  { role: 'user', content: '查看当前时间线，不要修改' },
]);
assert.equal(
  expiredSearch.names().includes('web_crawl'),
  false,
  'ToolSearch schemas expire after the assistant completes that request',
);
assert.equal(expiredSearch.names().includes('ToolSearch'), true,
  'the next completed request restores ToolSearch fallback');

console.log('tool activation checks passed');
