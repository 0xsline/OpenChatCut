// Runnable check: `npx tsx src/agent/settings/agent-settings.verify.ts`.
// Verification: settings default value/persistence roundtrip, <agent_settings> injection (tier and planMode branches),
// Inline <thinking> extract state machine (single chunk/cross-chunk/unclosed/nested text/half label).
import assert from 'node:assert/strict';
import {
  AGENT_CACHE_MODES, DEFAULT_AGENT_SETTINGS, loadAgentSettings, saveAgentSettings,
  agentSettingsPrompt, createInlineThinkingExtractor,
  MG_TIERS,
} from './agentSettings';

// ── Default value (node has no localStorage → load uses catch/empty storage, return to default in both cases) ──
assert.deepStrictEqual(loadAgentSettings(), DEFAULT_AGENT_SETTINGS, '无存储 → 默认值');
assert.strictEqual(DEFAULT_AGENT_SETTINGS.mgTier, 'balance', 'mgTier 默认 balance');
assert.strictEqual(DEFAULT_AGENT_SETTINGS.planMode, false, 'planMode 默认 false');
assert.strictEqual(DEFAULT_AGENT_SETTINGS.cacheMode, 'short', 'cacheMode 默认 short');
assert.deepStrictEqual([...AGENT_CACHE_MODES], ['short', 'long']);
assert.deepStrictEqual([...MG_TIERS], ['speed', 'balance', 'quality']);

// ── Persistence roundtrip (map version localStorage mock) ──
const store = new Map<string, string>();
// defineProperty: compatible with the localStorage accessor that comes with newer nodes (direct assignment may be rejected)
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  },
});
saveAgentSettings({ mgTier: 'quality', planMode: true, cacheMode: 'long', serverRun: false });
assert.deepStrictEqual(
  loadAgentSettings(),
  { mgTier: 'quality', planMode: true, cacheMode: 'long', serverRun: true },
  'save→load roundtrip 保真(server-side execution is always on)',
);
// Removed settings from older storage must not leak back into the active settings shape.
store.set('cc.agentSettings.v1', JSON.stringify({ skillGuard: true, thinkingEnabled: true, mgTier: 'speed', planMode: false }));
assert.deepStrictEqual(
  loadAgentSettings(),
  { mgTier: 'speed', planMode: false, cacheMode: 'short', serverRun: true },
  '旧 thinkingEnabled 字段被忽略且新缓存字段安全回退(server-side execution stays on)',
);
// Illegal tier / Missing fields fall back to default
store.set('cc.agentSettings.v1', JSON.stringify({ mgTier: 'ludicrous' }));
assert.strictEqual(loadAgentSettings().mgTier, 'balance', '非法 tier 回落 balance');

// ── <agent_settings> injection ──
const off = agentSettingsPrompt({ mgTier: 'speed', planMode: false });
assert.ok(off.includes('<agent_settings>') && off.includes('</agent_settings>'), '有标签包裹');
assert.ok(off.includes('motion_graphic_tier=speed'), '含 tier 键值');
assert.ok(off.includes('--tier speed'), '包含 pass --tier 措辞');
assert.ok(!off.includes('plan_mode'), 'planMode off → 无计划指令');
const on = agentSettingsPrompt({ mgTier: 'quality', planMode: true });
assert.ok(on.includes('motion_graphic_tier=quality') && on.includes('--tier quality'), 'tier 跟随设置');
assert.ok(on.includes('plan_mode=on') && on.includes('numbered plan'), 'planMode on → 先计划后动手指令');

// ── Inline <thinking> extract state machine ──
const run = (chunks: string[]) => {
  const ex = createInlineThinkingExtractor();
  let text = '';
  let thinking = '';
  for (const c of chunks) {
    const r = ex.push(c);
    text += r.text;
    thinking += r.thinking;
  }
  const f = ex.flush();
  return { text: text + f.text, thinking: thinking + f.thinking };
};

// Single chunk complete label
assert.deepStrictEqual(run(['前<thinking>思考</thinking>后']), { text: '前后', thinking: '思考' }, '单 chunk 抽取');
// Unlabeled passthrough (including nudity < not affected)
assert.deepStrictEqual(run(['纯文本,a < b 也不受影响']), { text: '纯文本,a < b 也不受影响', thinking: '' }, '无标签直通');
// Across chunks: opening/closing tags are split
assert.deepStrictEqual(run(['开头<thi', 'nking>内部', '思考</thin', 'king>结尾']), { text: '开头结尾', thinking: '内部思考' }, '跨 chunk 劈开标签');
// Not closed: all remaining balance at the end of the stream returns to thinking
assert.deepStrictEqual(run(['a<thinking>没闭合的思考']), { text: 'a', thinking: '没闭合的思考' }, '未闭合归 thinking');
// Unclosed + half-closed tags also belong to thinking
assert.deepStrictEqual(run(['<thinking>x</thin']), { text: '', thinking: 'x</thin' }, '半截闭标签随未闭合归 thinking');
// The half-cut label finally becomes a label → normal text
assert.deepStrictEqual(run(['价格 <think']), { text: '价格 <think', thinking: '' }, '半截开标签是正文');
// Nested text: Leave other tags in thinking as they are, and restore the text after closing.
assert.deepStrictEqual(run(['A<thinking>x <b>嵌套</b> y</thinking>B']), { text: 'AB', thinking: 'x <b>嵌套</b> y' }, '嵌套标签留在 thinking');
// Multiple paragraphs of thinking alternate
assert.deepStrictEqual(run(['<thinking>一</thinking>正<thinking>二</thinking>文']), { text: '正文', thinking: '一二' }, '多段交替');
// Reappear in thinking <thinking> literal: no re-entry, enter thinking as it is
assert.deepStrictEqual(run(['<thinking>外<thinking>内</thinking>后']), { text: '后', thinking: '外<thinking>内' }, '不重入');
// ── <think> variants (DeepSeek/MiniMax/GLM/Qwen/MiMo series) have the same rules as <thinking> ──
assert.deepStrictEqual(run(['前<think>思考</think>后']), { text: '前后', thinking: '思考' }, '<think> 单 chunk 抽取');
assert.deepStrictEqual(run(['a<thi', 'nk>内', '部</th', 'ink>b']), { text: 'ab', thinking: '内部' }, '<think> 跨 chunk 劈开标签');
assert.deepStrictEqual(run(['a<think>没闭合的思考']), { text: 'a', thinking: '没闭合的思考' }, '<think> 未闭合归 thinking');
// Two tags in the same stream alternate without crosstalk.
assert.deepStrictEqual(run(['<think>一</think>正<thinking>二</thinking>文']), { text: '正文', thinking: '一二' }, '两种标签交替');
// The closing tag is paired with the opening tag: the </thinking> literal within the <think> block does not close the block
assert.deepStrictEqual(run(['<think>a</thinking>b</think>c']), { text: 'c', thinking: 'a</thinking>b' }, '闭标签按开标签配对');

console.log('agent-settings.verify: ok (默认值/roundtrip/注入分支/抽取状态机)');
