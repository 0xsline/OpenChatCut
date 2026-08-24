import assert from 'node:assert/strict';
import EN_DATA from '../en/templates-data';
import { IT } from './index';
import IT_DATA from './templates-data';

const required = [
  '多语言词级转写 · 本地模型 · 该轨共 {n} 段会逐段转写（免费、离线、素材不出本机）。转写后可点词删减（删词=剪音频）。',
  '多语言词级转写 · 说话人分离 · 该轨共 {n} 段会逐段上传。转写后可点词删减（删词=剪音频）。',
  '简洁白字',
  '黑底白字',
  '字幕样式',
  '下载原文件',
  '导出透明 MOV',
  '导出中…',
  '素材导出失败：{message}',
  '导入文件夹…',
  '停止正在准备的监听文件夹「{dir}」',
  '停止监听文件夹「{dir}」',
  '正在选择监听文件夹…',
  '监听文件夹（自动导入新素材）…',
] as const;

for (const key of required) {
  assert.ok(IT[key], `missing Italian translation for ${key}`);
  assert.notEqual(IT[key], key, `Italian translation must not fall back to the Chinese key for ${key}`);
}

for (const key of Object.keys(EN_DATA)) {
  assert.ok(IT_DATA[key], `missing Italian template label for ${key}`);
  assert.notEqual(IT_DATA[key], EN_DATA[key], `Italian template label must not fall back to English for ${key}`);
}

console.log(`it mediaCoverage.verify: ${required.length} UI keys and ${Object.keys(EN_DATA).length} template labels covered`);
