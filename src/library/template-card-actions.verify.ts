import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./TemplateBrowser.tsx', import.meta.url), 'utf8');

assert.match(source, /onContextMenu=\{\(event\) =>/);
assert.match(source, /aria-label=\{t\('添加到时间线：\{name\}'/);
assert.match(source, /<Icon name="plus"/);
assert.doesNotMatch(source, /className="cc-template-add"\s+onClick=/);
assert.match(source, /title=\{t\('更多操作'\)\}/, 'the visible menu button should remain keyboard accessible');

console.log('template-card-actions.verify: template cards separate drag, add, and management actions');
