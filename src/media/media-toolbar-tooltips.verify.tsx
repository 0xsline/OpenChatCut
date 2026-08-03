import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const toolbar = await readFile(new URL('./MediaPoolToolbar.tsx', import.meta.url), 'utf8');
const semantic = await readFile(new URL('./semantic-search/SemanticSearchControls.tsx', import.meta.url), 'utf8');

for (const label of ['上传素材', '排序', '筛选', '更多操作']) {
  assert.match(toolbar, new RegExp(`data-tip=\\{t\\('${label}'\\)\\}`), `媒体工具栏应即时提示“${label}”`);
}
assert.match(toolbar, /data-tip=\{t\(mediaViewToggleLabel\(props\.view\)\)\}/, '网格/列表切换应即时提示当前操作');
assert.match(semantic, /data-tip=\{t\('本地语义搜索'\)\}/, '本地语义搜索应使用即时提示');
assert.doesNotMatch(toolbar, /className=\{?`?[^\n]*cc-media-icon[^\n]*\stitle=/, '媒体工具栏图标不应依赖延迟出现的原生 title');
assert.doesNotMatch(semantic, /className=\{?`?[^\n]*cc-media-icon[^\n]*\stitle=/, '语义搜索图标不应依赖延迟出现的原生 title');

console.log('media toolbar immediate tooltips verified');
