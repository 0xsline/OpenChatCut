// 可运行自检：`npx tsx src/agent/followup-tools.check.ts`
// ask_followup_questions 的核心是把 fields 序列化成 <widget> 文本，再由 UI 的 parseWidgets 解析成
// 表单卡。本检验证这条往返：buildFollowupWidget → parseWidgets 字段无损，且 execFollowupTool 的
// __followup 契约、无选项降级、空 fields 报错都成立。
import assert from 'node:assert';
import { buildFollowupWidget, execFollowupTool, FOLLOWUP_TOOL_NAMES } from './followup-tools';
import { parseWidgets, type WidgetField } from '../../components/chat/widget-parse';
import type { AgentContext } from '../context';

const ctx = {} as AgentContext; // followup 不碰编辑器状态

// ---- 往返：single + multi 字段经 buildFollowupWidget → parseWidgets 无损 ----
const text = buildFollowupWidget(
  [
    { id: 'ratio', label: '画幅比例', type: 'single', options: [{ value: '16:9', display: '横屏 16:9' }, { value: '9:16', display: '竖屏 9:16' }], required: true },
    { id: 'topics', label: '重点内容', type: 'multi', options: [{ value: 'a', display: '生平' }, { value: 'b', display: '作品' }], allowOther: true },
  ],
  '开始前需要确认几件事：',
);
const segs = parseWidgets(text);
assert.strictEqual(segs.length, 2, '应为 文本 + widget 两段');
assert.ok(segs[0].type === 'text' && segs[0].text.includes('开始前需要确认'), 'prompt 应作为前置文本段');
assert.ok(segs[1].type === 'widget', '第二段应是 widget');
const fields = segs[1].type === 'widget' ? segs[1].fields : [];
assert.strictEqual(fields.length, 2, '应解出 2 个字段');
const [ratio, topics] = fields as [Extract<WidgetField, { kind: 'single' }>, Extract<WidgetField, { kind: 'multi' }>];
assert.strictEqual(ratio.kind, 'single');
assert.strictEqual(ratio.id, 'ratio');
assert.strictEqual(ratio.label, '画幅比例');
assert.strictEqual(ratio.required, true, 'required 应保留');
assert.deepStrictEqual(ratio.options, [{ value: '16:9', display: '横屏 16:9' }, { value: '9:16', display: '竖屏 9:16' }]);
assert.strictEqual(topics.kind, 'multi');
assert.strictEqual(topics.allowOther, true, 'allow_other 应保留');

// ---- 无选项字段降级为 prompt 行，不产出 widget 字段 ----
const freeText = buildFollowupWidget([{ id: 'title', label: '视频标题', type: 'single', options: [] }], '');
const freeSegs = parseWidgets(freeText);
assert.ok(!freeSegs.some((s) => s.type === 'widget'), '无选项字段不应产出 widget 卡');
assert.ok(freeSegs.some((s) => s.type === 'text' && s.text.includes('- 视频标题')), '无选项字段应降级为提问行');

// ---- 混合：一个带选项 + 一个自由文本 → widget 卡里只含带选项的那个，自由文本进前置文本 ----
const mixed = buildFollowupWidget(
  [
    { id: 'q1', label: '带选项', type: 'single', options: ['x', 'y'] },
    { id: 'q2', label: '自由输入', type: 'single', options: [] },
  ],
  '',
);
const mixedSegs = parseWidgets(mixed);
const mixedWidget = mixedSegs.find((s) => s.type === 'widget');
assert.ok(mixedWidget && mixedWidget.type === 'widget' && mixedWidget.fields.length === 1, '带选项字段独立成卡');
assert.ok(mixedSegs.some((s) => s.type === 'text' && s.text.includes('- 自由输入')), '自由文本字段降级为提问行');

// ---- 特殊字符（引号/尖括号/&）经 esc → decodeEntities 无损 ----
const escaped = buildFollowupWidget([{ id: 'q', label: 'A & B <c> "d"', type: 'single', options: [{ value: 'v', display: 'x & y' }] }], '');
const escFields = (parseWidgets(escaped).find((s) => s.type === 'widget') as { type: 'widget'; fields: WidgetField[] }).fields;
assert.strictEqual(escFields[0].label, 'A & B <c> "d"', '标签特殊字符应无损往返');
const escOpt = escFields[0].options[0] as { display?: string; value?: string };
assert.strictEqual(escOpt.display ?? escOpt.value, 'x & y', '选项特殊字符应无损往返');

// ---- execFollowupTool 契约：合法输入返回 __followup，空 fields 报错 ----
assert.ok(FOLLOWUP_TOOL_NAMES.has('ask_followup_questions'));
const ok = execFollowupTool('ask_followup_questions', { fields: [{ id: 'r', label: '比例', type: 'single', options: ['16:9', '9:16'] }], prompt: '选一个' }, ctx) as { __followup?: string; note?: string };
assert.ok(typeof ok.__followup === 'string' && ok.__followup.includes('<widget>'), '合法调用应返回 __followup widget 文本');
assert.ok(typeof ok.note === 'string' && ok.note.length > 0, '应带 note 提示等待作答');
const empty = execFollowupTool('ask_followup_questions', { fields: [] }, ctx) as { error?: string };
assert.ok(empty.error, '空 fields 应报错');
const noRenderable = execFollowupTool('ask_followup_questions', { fields: [{ label: '', type: 'single', options: [] }] }, ctx) as { error?: string };
assert.ok(noRenderable.error, '无可渲染字段应报错');
const badName = execFollowupTool('nope', { fields: [] }, ctx) as { error?: string };
assert.ok(badName.error, '未知工具名应报错');

console.log('followup-tools.check.ts ✓ (widget 往返 / 无选项降级 / 特殊字符 / exec 契约)');
