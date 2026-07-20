// Runnable check: `npx tsx src/agent/agent-settings.check.ts`.
// 验证:settings 默认值/持久化 roundtrip、<agent_settings> 注入(tier 与 planMode 分支)、
// 内联 <thinking> 抽取状态机(单 chunk/跨 chunk/未闭合/嵌套文本/半截标签)。
import assert from 'node:assert/strict';
import {
  DEFAULT_AGENT_SETTINGS, loadAgentSettings, saveAgentSettings, agentSettingsPrompt,
  createInlineThinkingExtractor, MG_TIERS,
} from './agentSettings';

// ── 默认值(node 无 localStorage → load 走 catch/空存储,两种情况都应回默认) ──
assert.deepStrictEqual(loadAgentSettings(), DEFAULT_AGENT_SETTINGS, '无存储 → 默认值');
assert.strictEqual(DEFAULT_AGENT_SETTINGS.skillGuard, true);
assert.strictEqual(DEFAULT_AGENT_SETTINGS.thinkingEnabled, false, 'thinkingEnabled 默认 false');
assert.strictEqual(DEFAULT_AGENT_SETTINGS.mgTier, 'balance', 'mgTier 默认 balance');
assert.strictEqual(DEFAULT_AGENT_SETTINGS.planMode, false, 'planMode 默认 false');
assert.deepStrictEqual([...MG_TIERS], ['speed', 'balance', 'quality']);

// ── 持久化 roundtrip(map 版 localStorage mock) ──
const store = new Map<string, string>();
// defineProperty:兼容较新 node 自带的 localStorage accessor(直接赋值可能被拒)
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  },
});
saveAgentSettings({ skillGuard: false, thinkingEnabled: true, mgTier: 'quality', planMode: true });
assert.deepStrictEqual(
  loadAgentSettings(),
  { skillGuard: false, thinkingEnabled: true, mgTier: 'quality', planMode: true },
  'save→load roundtrip 保真',
);
// 非法 tier / 缺字段回落默认
store.set('cc.agentSettings.v1', JSON.stringify({ mgTier: 'ludicrous' }));
assert.strictEqual(loadAgentSettings().mgTier, 'balance', '非法 tier 回落 balance');
assert.strictEqual(loadAgentSettings().thinkingEnabled, false, '缺字段回落默认');

// ── <agent_settings> 注入 ──
const off = agentSettingsPrompt({ mgTier: 'speed', planMode: false, skillGuard: true });
assert.ok(off.includes('<agent_settings>') && off.includes('</agent_settings>'), '有标签包裹');
assert.ok(off.includes('motion_graphic_tier=speed'), '含 tier 键值');
assert.ok(off.includes('--tier speed'), '包含 pass --tier 措辞');
assert.ok(!off.includes('plan_mode'), 'planMode off → 无计划指令');
const on = agentSettingsPrompt({ mgTier: 'quality', planMode: true, skillGuard: false });
assert.ok(on.includes('motion_graphic_tier=quality') && on.includes('--tier quality'), 'tier 跟随设置');
assert.ok(on.includes('plan_mode=on') && on.includes('编号计划'), 'planMode on → 先计划后动手指令');

// ── 内联 <thinking> 抽取状态机 ──
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

// 单 chunk 完整标签
assert.deepStrictEqual(run(['前<thinking>思考</thinking>后']), { text: '前后', thinking: '思考' }, '单 chunk 抽取');
// 无标签直通(含裸 < 不受影响)
assert.deepStrictEqual(run(['纯文本,a < b 也不受影响']), { text: '纯文本,a < b 也不受影响', thinking: '' }, '无标签直通');
// 跨 chunk:开/闭标签都被劈开
assert.deepStrictEqual(run(['开头<thi', 'nking>内部', '思考</thin', 'king>结尾']), { text: '开头结尾', thinking: '内部思考' }, '跨 chunk 劈开标签');
// 未闭合:流结束余量全归 thinking
assert.deepStrictEqual(run(['a<thinking>没闭合的思考']), { text: 'a', thinking: '没闭合的思考' }, '未闭合归 thinking');
// 未闭合 + 半截闭标签也归 thinking
assert.deepStrictEqual(run(['<thinking>x</thin']), { text: '', thinking: 'x</thin' }, '半截闭标签随未闭合归 thinking');
// 半截开标签最终没成标签 → 普通文本
assert.deepStrictEqual(run(['价格 <think']), { text: '价格 <think', thinking: '' }, '半截开标签是正文');
// 嵌套文本:thinking 里的其它标签原样留在 thinking,闭合后恢复正文
assert.deepStrictEqual(run(['A<thinking>x <b>嵌套</b> y</thinking>B']), { text: 'AB', thinking: 'x <b>嵌套</b> y' }, '嵌套标签留在 thinking');
// 多段 thinking 交替
assert.deepStrictEqual(run(['<thinking>一</thinking>正<thinking>二</thinking>文']), { text: '正文', thinking: '一二' }, '多段交替');
// thinking 内再现 <thinking> 字面量:不重入,原样进 thinking
assert.deepStrictEqual(run(['<thinking>外<thinking>内</thinking>后']), { text: '后', thinking: '外<thinking>内' }, '不重入');

console.log('agent-settings.check: ok (默认值/roundtrip/注入分支/抽取状态机)');
