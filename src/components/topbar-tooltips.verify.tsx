import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const exportHistory = await readFile(new URL('./ExportHistory.tsx', import.meta.url), 'utf8');

assert.match(
  exportHistory,
  /<TopBarIconButton[\s\S]*?icon="download"[\s\S]*?label=\{t\('导出历史'\)\}/,
  '导出历史按钮应复用顶部栏图标按钮',
);
assert.doesNotMatch(
  exportHistory,
  /<button title=\{t\('导出历史'\)\}/,
  '导出历史按钮不应使用样式不可控的原生 title',
);

console.log('top bar immediate tooltips verified');
