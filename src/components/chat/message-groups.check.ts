// Runnable check: `npx tsx src/components/chat/message-groups.check.ts`.
// groupMessages 把连续同名工具行折叠成组(≥GROUP_MIN),其余原样;验证折叠/阈值/顺序/索引。
import assert from 'node:assert/strict';
import type { DisplayMessage } from '../../agent/useAgent';
import { groupMessages, GROUP_MIN } from './message-groups';

const tool = (name: string, id = ''): DisplayMessage => ({ role: 'tool', text: '', tool: { name, args: { id }, result: { ok: true } } });
const txt = (t: string): DisplayMessage => ({ role: 'assistant', text: t });

// 20× edit_gap 夹在文本与另一工具之间 → 折成一个 toolgroup,前后各自成行
const msgs: DisplayMessage[] = [
  txt('开始'),
  ...Array.from({ length: 20 }, (_, i) => tool('edit_gap', 'g' + i)),
  tool('read_timeline'),
  txt('完成'),
];
const items = groupMessages(msgs);
assert.deepStrictEqual(items.map((it) => it.kind), ['single', 'toolgroup', 'single', 'single'], '20 连续 edit_gap 折成 1 组,文本/其它工具各自成行');
const grp = items[1];
assert.ok(grp.kind === 'toolgroup');
assert.strictEqual(grp.kind === 'toolgroup' && grp.name, 'edit_gap');
assert.strictEqual(grp.kind === 'toolgroup' && grp.items.length, 20, '组里含全部 20 次');
assert.strictEqual(grp.kind === 'toolgroup' && grp.items[0].index, 1, '组内保留原始 message 索引(用于 key/feedback)');
assert.strictEqual(grp.kind === 'toolgroup' && grp.items[19].index, 20);

// 阈值:GROUP_MIN-1 次不折叠(各自成行),GROUP_MIN 次折叠
const below = groupMessages(Array.from({ length: GROUP_MIN - 1 }, () => tool('search_templates')));
assert.ok(below.every((it) => it.kind === 'single'), `不足 ${GROUP_MIN} 次不折叠`);
const at = groupMessages(Array.from({ length: GROUP_MIN }, () => tool('search_templates')));
assert.deepStrictEqual(at.map((it) => it.kind), ['toolgroup'], `满 ${GROUP_MIN} 次折叠`);

// 不同名相邻工具不合并(信息量保留)
const distinct = groupMessages([tool('clean_script'), tool('read_timeline'), tool('manage_timelines')]);
assert.ok(distinct.every((it) => it.kind === 'single'), '不同名工具各自成行,不误折');

// 两段同名被别的工具隔开 → 两个独立组
const split = groupMessages([...Array.from({ length: 4 }, () => tool('edit_gap')), tool('read_timeline'), ...Array.from({ length: 3 }, () => tool('edit_gap'))]);
assert.deepStrictEqual(split.map((it) => it.kind), ['toolgroup', 'single', 'toolgroup'], '被隔开的同名段各自成组');

console.log('message-groups.check: ok (折叠/阈值/索引/不误折/分段)');
