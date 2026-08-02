import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import type { SkillDefinition } from '../../agent/skills/skill-types';
import { activateWorkflowStarter, workflowPromptForSkill } from './workflowStarters';

const builtInSkills: SkillDefinition[] = [
  ['11111111-1240-4000-8000-000000000004', 'long-video-to-shorts', 'Long Video to Shorts', '长视频转短视频'],
  ['11111111-1240-4000-8000-000000000012', 'multi-clips-to-reels', 'Multi Clips to Reels', '多素材剪 Reels'],
  ['11111111-1240-4000-8000-000000000005', 'ai-cinematic-short-film', 'AI Cinematic Short Film', 'AI 电影感短片'],
  ['11111111-1240-4000-8000-000000000006', 'product-ad-video-script', 'Product Ad Video Script', '产品广告脚本'],
  ['11111111-1240-4000-8000-000000000011', 'explainer-video', 'Explainer Video', '解说视频制作'],
  ['11111111-1240-4000-8000-000000000008', 'motion-graphic-placement', 'Motion Graphic Placement', '动效点缀指南'],
  ['11111111-1240-4000-8000-000000000009', 'storyboard-shot-breakdown', 'Storyboard Shot Breakdown', '拉片分镜图'],
  ['11111111-1240-4000-8000-000000000010', 'video-thumbnail-generator', 'Video Thumbnail Generator', '视频封面生成'],
].map(([id, slug, name, nameZh]) => ({
  id: id!, slug: slug!, name: name!, nameZh: nameZh!,
  description: '', summary: '一个足够长的通用工作流摘要，用来验证自定义工作流提示词。',
  scenarios: [], body: '', files: [], source: 'builtin',
}));

for (const skill of builtInSkills) {
  const prompt = workflowPromptForSkill(skill);
  const visibleLength = [...prompt.replace(/\s/g, '')].length;
  assert.ok(
    visibleLength >= 48 && visibleLength <= 64,
    `${skill.nameZh} should fill the composer with a concise, ready-to-run prompt`,
  );
}

let selectedMode: string | null = null;
let filledPrompt = '';
let focusRequests = 0;
activateWorkflowStarter(builtInSkills[0]!, {
  translate: (value) => `translated:${value}`,
  onCreativeModeChange: (id) => { selectedMode = id; },
  onPromptChange: (value) => { filledPrompt = value; },
  onRequestFocus: () => { focusRequests += 1; },
});
assert.equal(selectedMode, builtInSkills[0]!.id, 'workflow activation should select the Agent skill');
assert.equal(filledPrompt, `translated:${workflowPromptForSkill(builtInSkills[0]!)}`, 'workflow activation should fill its localized prompt');
assert.equal(focusRequests, 1, 'workflow activation should return focus to the composer');

const customSkill: SkillDefinition = {
  id: 'custom-customer-story',
  slug: 'customer-story',
  name: 'Customer Story Workflow',
  nameZh: '客户故事工作流',
  description: 'Create a concise customer story.',
  summary: '把访谈和产品素材整理成有开头、证据和收尾的客户故事。',
  scenarios: ['customer-story'],
  body: '# Customer Story Workflow',
  files: [],
  source: 'custom',
};
assert.match(workflowPromptForSkill(customSkill), /客户故事工作流/);
assert.match(workflowPromptForSkill(customSkill), /访谈和产品素材/);
assert.ok([...workflowPromptForSkill(customSkill).replace(/\s/g, '')].length <= 68);

const selectedId = builtInSkills[1]!.id;
const localeModuleId = '\0workflow-picker-test-locale';
const vite = await createServer({
  appType: 'custom',
  plugins: [{
    name: 'workflow-picker-test-locale',
    enforce: 'pre',
    resolveId(id) {
      return id.endsWith('/i18n/locale') || id.endsWith('/i18n/locale.ts') ? localeModuleId : null;
    },
    load(id) {
      if (id !== localeModuleId) return null;
      return `
        export const getLocale = () => 'zh';
        export const t = (text) => text;
        export const useT = () => t;
      `;
    },
  }],
  server: { middlewareMode: true },
});

let pickerMarkup = '';
try {
  const { WorkflowPickerContent } = await vite.ssrLoadModule('/src/components/chat/WorkflowPickerContent.tsx');
  pickerMarkup = renderToStaticMarkup(createElement(WorkflowPickerContent, {
    creativeMode: selectedId,
    onCreativeModeChange: () => undefined,
    onPromptChange: () => undefined,
    onRequestFocus: () => undefined,
    onClose: () => undefined,
  }));
} finally {
  await vite.close();
}

assert.match(pickerMarkup, /<div class="cc-creative-mode-grid">/, 'professional workflows should use the dedicated two-column grid');
assert.equal(
  (pickerMarkup.match(/class="cc-creative-mode-row cc-creative-mode-card"/g) ?? []).length,
  8,
  'every built-in workflow should render as an independently bordered card',
);
assert.equal((pickerMarkup.match(/aria-pressed="true"/g) ?? []).length, 1, 'exactly one workflow should expose selected state');
assert.match(pickerMarkup, /长视频转短视频/);
assert.match(pickerMarkup, /视频封面生成/);

console.log('workflow-starters.verify: workflow prompts, activation, and picker layout passed');
