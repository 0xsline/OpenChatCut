import type { SkillDefinition } from '../../agent/skills/skill-types';
import type { Locale } from '../../i18n/locale';

const BUILTIN_WORKFLOW_PROMPTS = new Map<string, string>([
  ['11111111-1240-4000-8000-000000000004', '请分析当前长视频，挑选最有传播力的高光片段，剪成节奏紧凑的竖屏短视频，并完成字幕、标题和发布前检查。'],
  ['11111111-1240-4000-8000-000000000012', '请梳理当前素材，选出最有表现力的镜头，按钩子、推进、高潮和收尾重组为一支竖屏 Reels，并完成配乐与节奏优化。'],
  ['11111111-1240-4000-8000-000000000005', '请根据当前主题规划一支电影感短片，先确定故事结构和视觉风格，再生成连贯镜头，完成声音、节奏和成片检查。'],
  ['11111111-1240-4000-8000-000000000006', '请提炼产品核心卖点和目标人群，设计有吸引力的开头、分镜、字幕与行动引导，并整理成可直接制作的短视频脚本。'],
  ['11111111-1240-4000-8000-000000000011', '请把当前主题或资料整理成清晰的解说视频，完成内容结构、旁白、画面匹配、字幕与节奏设计，并检查信息是否准确。'],
  ['11111111-1240-4000-8000-000000000008', '请分析当前时间线，在不遮挡主体和字幕的前提下，为重点信息添加克制的标题、强调动效与转场，并统一节奏和视觉风格。'],
  ['11111111-1240-4000-8000-000000000009', '请逐镜分析参考视频的构图、景别、运镜、节奏和转场，整理成可复用的分镜表，并为关键镜头生成清晰的画面参考。'],
  ['11111111-1240-4000-8000-000000000010', '请根据当前视频内容筛选真实高质量画面，设计适合发布平台的封面构图、标题和视觉层级，并输出可直接使用的封面方案。'],
]);

function compactWorkflowSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, ' ').trim().replace(/[。！？!?]+$/u, '');
  const characters = [...normalized];
  if (characters.length <= 16) return normalized;
  return `${characters.slice(0, 15).join('')}…`;
}

type WorkflowTranslate = (value: string, params?: Record<string, string | number>) => string;

const interpolateWorkflowPrompt: WorkflowTranslate = (value, params) => (
  params
    ? value.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match))
    : value
);

export function workflowPromptForSkill(
  skill: SkillDefinition,
  translate: WorkflowTranslate = interpolateWorkflowPrompt,
  locale: Locale = 'zh',
): string {
  const builtinPrompt = BUILTIN_WORKFLOW_PROMPTS.get(skill.id);
  if (builtinPrompt) return translate(builtinPrompt);
  return translate(
    '请按“{name}”工作流处理当前工程：{summary}。先检查素材和时间线，再执行并检查成片。',
    {
      name: locale === 'en' ? skill.name : skill.nameZh,
      summary: compactWorkflowSummary(locale === 'en' ? (skill.description || skill.summary) : skill.summary),
    },
  );
}

export interface WorkflowStarterActions {
  translate: WorkflowTranslate;
  locale?: Locale;
  onCreativeModeChange: (id: string) => void;
  onPromptChange: (value: string) => void;
  onRequestFocus: () => void;
}

export function activateWorkflowStarter(
  skill: SkillDefinition,
  actions: WorkflowStarterActions,
): void {
  actions.onCreativeModeChange(skill.id);
  actions.onPromptChange(workflowPromptForSkill(skill, actions.translate, actions.locale));
  actions.onRequestFocus();
}
