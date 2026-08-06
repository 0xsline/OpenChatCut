import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EN } from '../i18n/dict/en';

const component = await readFile(new URL('./GenerationActivity.tsx', import.meta.url), 'utf8');
const topBarButton = await readFile(new URL('./TopBarIconButton.tsx', import.meta.url), 'utf8');

assert.match(
  component,
  /<TopBarIconButton[\s\S]*?icon="sparkles"[\s\S]*?label=\{t\('生成任务'\)\}/,
  '生成任务按钮应复用顶部栏图标按钮',
);
assert.doesNotMatch(
  component,
  /title=\{t\('生成任务'\)\}/,
  '生成任务按钮不应使用样式不可控的原生 title',
);
assert.match(topBarButton, /className="cc-tip cc-tip-r"/, '共享按钮应使用即时 tooltip');
assert.match(topBarButton, /data-tip=\{label\}/, '共享按钮应将本地化标签用于 tooltip');
assert.match(topBarButton, /onMouseEnter=/, '共享按钮应提供统一的 hover 反馈');
assert.match(topBarButton, /onMouseLeave=/, '共享按钮应在离开 hover 后恢复样式');
assert.equal(component.match(/retryClassLabel\(job\.retryClass, t\)/g)?.length, 1, '每个任务应只计算一次重试标签');

const generationActivityKeys = [
  '生成任务',
  '旧版参数摘要（不可安全重跑）',
  '参数快照不可用',
  '刷新后仍可继续检查、下载或重跑',
  '恢复中…',
  '继续任务',
  '正在读取任务…',
  '暂无生成任务',
  'Provider 任务',
  '打开结果',
  '重试可恢复任务',
  '检查进度',
  '等待中',
  '进行中',
  '已完成',
  '失败',
  '未找到',
  '可重试下载',
  '可重试生成',
  '重启后可恢复',
  '不可重试',
  '旧任务状态未知',
] as const;

for (const key of generationActivityKeys) {
  assert.notEqual(EN[key], undefined, `英文词典应包含“${key}”`);
}

assert.match(component, /t\('\{n\} 分钟前'/, '相对分钟数应通过 i18n 格式化');
assert.match(component, /t\('\{n\} 小时前'/, '相对小时数应通过 i18n 格式化');
assert.match(component, /t\('\{n\} 天前'/, '相对天数应通过 i18n 格式化');

console.log('generation activity hover and localization verified');
