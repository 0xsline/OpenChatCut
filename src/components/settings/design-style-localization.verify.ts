import assert from 'node:assert/strict';
import { DESIGN_STYLE_PRESETS } from '../../editor/design-presets';
import {
  localizeDesignFontRole,
  localizeDesignPresetName,
  localizeDesignRole,
  localizeDesignStyleGuide,
} from './designStyleLocalization';

const modern = DESIGN_STYLE_PRESETS.find((preset) => preset.name === 'Modern Editorial');
assert.ok(modern, '测试数据应包含 Modern Editorial');

assert.equal(localizeDesignPresetName(modern.name, 'zh'), '现代杂志编辑风');
assert.equal(localizeDesignPresetName(modern.name, 'en'), modern.name);
assert.equal(localizeDesignRole('background-chart', 'zh'), '图表背景');
assert.equal(localizeDesignRole('chart-warm-mid', 'zh'), '图表暖色中间调');
assert.equal(localizeDesignRole('background-chart', 'en'), 'background-chart');
assert.equal(localizeDesignFontRole('accent', 'zh'), '强调字体');
assert.equal(localizeDesignFontRole('callout', 'zh'), '标注字体');
assert.equal(localizeDesignFontRole('impact', 'zh'), '冲击字体');
assert.equal(localizeDesignFontRole('accent', 'en'), 'accent');
assert.equal(
  localizeDesignStyleGuide(modern.style.styleGuide ?? '', 'zh'),
  '现代杂志编辑风：暖灰纸张、笔记本或报刊网格、衬线标题与清晰的 Roboto 正文。整体像数据记者的批注笔记，以黑灰为主，仅用橙色或黄色强调关键数值和语句。',
);
assert.equal(localizeDesignStyleGuide(modern.style.styleGuide ?? '', 'en'), modern.style.styleGuide);

for (const preset of DESIGN_STYLE_PRESETS) {
  assert.notEqual(localizeDesignPresetName(preset.name, 'zh'), preset.name, `${preset.name} 应提供中文名称`);
  assert.notEqual(
    localizeDesignStyleGuide(preset.style.styleGuide ?? '', 'zh'),
    preset.style.styleGuide,
    `${preset.name} 应提供中文品牌指引`,
  );
}

console.log('design-style-localization.verify: preset names, roles and guides localize to Chinese');

