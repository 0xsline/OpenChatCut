import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  findMediaNameConflict,
  isMediaImportCancelled,
  mediaImportErrorMessage,
  MediaImportCancelledError,
  normalizeMediaName,
} from './mediaImportConflict';

assert.equal(normalizeMediaName('  旅行封面.PNG  '), '旅行封面.png');
assert.equal(normalizeMediaName('ＡＢＣ.mp4'), 'abc.mp4');
assert.equal(findMediaNameConflict([{ id: 'a', name: '旅行封面.PNG' }], '旅行封面.png')?.id, 'a');
assert.equal(isMediaImportCancelled(new MediaImportCancelledError()), true);
assert.equal(mediaImportErrorMessage(new Error('part 3 failed (503)')), '上传第 3 个分片失败（503）');
assert.equal(mediaImportErrorMessage(new Error('unexpected internal failure')), '导入素材失败，请重试');

const panel = readFileSync(new URL('./MediaPoolPanel.tsx', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../Editor.tsx', import.meta.url), 'utf8');
assert.match(editor, /findMediaNameConflict\(stateRef\.current\.assets \?\? \[\], file\.name\)/, '所有导入入口必须在共享层检查同名素材');
assert.match(editor, /window\.confirm\(t\('素材「\{name\}」已存在。覆盖会同步替换/, '同名素材必须在写入前确认');
assert.match(editor, /commands\.relinkMediaAsset\(ready\.id/, '覆盖必须复用原素材 ID 并同步时间线引用');
assert.match(editor, /return targetId \? \{ \.\.\.imported, id: targetId \} : imported/, '覆盖后返回引用必须继续使用原素材 ID');
assert.match(panel, /if \(isMediaImportCancelled\(reason\)\) continue/, '取消一个同名素材后必须继续处理同批非重复素材');
assert.match(panel, /setError\(mediaImportErrorMessage\(reason\)\)/, '素材池不得显示内部英文错误');

console.log('media-import-conflict.verify: shared conflict handling preserves asset identity');
