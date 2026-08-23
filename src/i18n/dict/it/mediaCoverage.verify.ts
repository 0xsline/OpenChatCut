import assert from 'node:assert/strict';
import { IT } from './index';

const required = [
  '多语言词级转写 · 本地模型 · 该轨共 {n} 段会逐段转写（免费、离线、素材不出本机）。转写后可点词删减（删词=剪音频）。',
  '多语言词级转写 · 说话人分离 · 该轨共 {n} 段会逐段上传。转写后可点词删减（删词=剪音频）。',
  '简洁白字',
  '黑底白字',
  '字幕样式',
] as const;

for (const key of required) {
  assert.ok(IT[key], `missing Italian translation for ${key}`);
  assert.notEqual(IT[key], key, `Italian translation must not fall back to the Chinese key for ${key}`);
}

console.log('it mediaCoverage.verify: transcript and caption menu keys covered');
