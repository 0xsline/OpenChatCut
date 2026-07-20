// 可运行自检：`npx tsx src/components/chat/widget-parse.check.ts`
// 覆盖 widget 样例 + formatWidgetAnswer 拼答案 + 畸形 widget 的容错。
import assert from 'node:assert';
import { parseWidgets, formatWidgetAnswer, type WidgetField } from './widget-parse';

const REAL_EXAMPLE = `好的！在开始制作之前，我需要了解几个关键信息：

<widget>
  <form-single id="duration" label="视频时长大概多少？" options="60s|约1分钟,180s|约3分钟,300s|约5分钟" allow_other="false"/>
  <form-single id="ratio" label="视频画幅比例" options="16:9|横屏 16:9,9:16|竖屏 9:16,1:1|方形"/>
  <form-multi id="content" label="想重点涵盖哪些内容？（多选）" options="生平经历,代表诗作赏析,历史背景与时代"/>
  <form-visual id="voiceId" label="选择一个配音音色：" required="true">
    <visual-option value="ruyayichen" name="儒雅逸辰" media="/voice-samples/doubao-ruyayichen.mp3" aspect-ratio="16:5" summary="男 / 年轻 / 儒雅飘逸"/>
    <visual-option value="morgan" name="Morgan" media="/voice-samples/x.mp3" summary="..."/>
  </form-visual>
</widget>`;

// ---- 段落顺序 + 字段解析 ----
const segs = parseWidgets(REAL_EXAMPLE);
assert.strictEqual(segs.length, 2, 'segment 数应为 2（文本 + widget）');
assert.strictEqual(segs[0].type, 'text');
assert.ok(segs[0].type === 'text' && segs[0].text.includes('好的！在开始制作之前'));
assert.strictEqual(segs[1].type, 'widget');
assert.ok(segs[1].type === 'widget');
const fields = segs[1].type === 'widget' ? segs[1].fields : [];
assert.strictEqual(fields.length, 4, '应解出 4 个字段');

const [duration, ratio, content, voiceId] = fields as [
  Extract<WidgetField, { kind: 'single' }>,
  Extract<WidgetField, { kind: 'single' }>,
  Extract<WidgetField, { kind: 'multi' }>,
  Extract<WidgetField, { kind: 'visual' }>,
];

assert.strictEqual(duration.kind, 'single');
assert.strictEqual(duration.id, 'duration');
assert.strictEqual(duration.label, '视频时长大概多少？');
assert.strictEqual(duration.allowOther, false);
assert.deepStrictEqual(duration.options, [
  { value: '60s', display: '约1分钟' },
  { value: '180s', display: '约3分钟' },
  { value: '300s', display: '约5分钟' },
]);

assert.strictEqual(ratio.kind, 'single');
assert.strictEqual(ratio.allowOther, false, 'allow_other 缺省应为 false');
assert.deepStrictEqual(ratio.options, [
  { value: '16:9', display: '横屏 16:9' },
  { value: '9:16', display: '竖屏 9:16' },
  { value: '1:1', display: '方形' },
]);

assert.strictEqual(content.kind, 'multi');
assert.deepStrictEqual(content.options, [
  { value: '生平经历', display: '生平经历' },
  { value: '代表诗作赏析', display: '代表诗作赏析' },
  { value: '历史背景与时代', display: '历史背景与时代' },
]);

assert.strictEqual(voiceId.kind, 'visual');
assert.strictEqual(voiceId.required, true);
assert.strictEqual(voiceId.options.length, 2);
assert.deepStrictEqual(voiceId.options[0], {
  value: 'ruyayichen',
  name: '儒雅逸辰',
  media: '/voice-samples/doubao-ruyayichen.mp3',
  summary: '男 / 年轻 / 儒雅飘逸',
  aspectRatio: '16:5',
});
assert.deepStrictEqual(voiceId.options[1], {
  value: 'morgan',
  name: 'Morgan',
  media: '/voice-samples/x.mp3',
  summary: '...',
  aspectRatio: undefined,
});

// ---- formatWidgetAnswer ----
const answer = formatWidgetAnswer(fields, {
  duration: '180s',
  ratio: '16:9',
  content: ['生平经历', '代表诗作赏析'],
  voiceId: 'ruyayichen',
});
assert.strictEqual(
  answer,
  ['- 视频时长大概多少？：约3分钟', '- 视频画幅比例：横屏 16:9', '- 想重点涵盖哪些内容？（多选）：生平经历、代表诗作赏析', '- 选择一个配音音色：：儒雅逸辰'].join('\n'),
);

// 未作答的字段应跳过；allow_other 的自由文本应原样作为展示
const partial = formatWidgetAnswer(fields, { duration: '自定义两分钟' });
assert.strictEqual(partial, '- 视频时长大概多少？：自定义两分钟');

// ---- 无 widget 的普通文本：整段原样返回 ----
const plain = parseWidgets('这是一句普通回复，没有表单。');
assert.strictEqual(plain.length, 1);
assert.deepStrictEqual(plain[0], { type: 'text', text: '这是一句普通回复，没有表单。' });

// ---- 畸形 widget：解不出字段时原样当文本，不抛错 ----
const malformed = '前面的话<widget><form-single id="x"/></widget>后面的话';
assert.doesNotThrow(() => parseWidgets(malformed));
const malformedSegs = parseWidgets(malformed);
assert.strictEqual(malformedSegs.length, 3);
assert.deepStrictEqual(malformedSegs[1], { type: 'text', text: '<widget><form-single id="x"/></widget>' });

// ---- 空 widget（无字段）同样退化为文本 ----
const empty = '<widget></widget>';
assert.doesNotThrow(() => parseWidgets(empty));
assert.deepStrictEqual(parseWidgets(empty), [{ type: 'text', text: '<widget></widget>' }]);

console.log('widget-parse.check: ok');
