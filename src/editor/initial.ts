import templatesJson from '../../assets/templates/openchatcut-templates.json';
import socialShortsJson from '../../assets/templates/social-shorts-templates.json';
import kouboScenesJson from '../../assets/templates/koubo-scenes-templates.json';
import type { Tpl } from '../types';
import type { TimelineState } from './types';

// The template library + the first-run seed project. Shared by the loader shell
// (fallback when nothing is persisted) and the editor (agent context / library).
// 211 条(openchatcut-templates.json) + 竖屏自媒体 social-shorts（9:16）
// + 口播场景 koubo-scenes(背景+人物透窗,横竖双向)。
// 旧口播双画面(koubo-dual)预览太糙已下架,勿再合并——koubo-scenes 是替代品。
export const TEMPLATES = [
  ...(templatesJson as Tpl[]),
  ...(socialShortsJson as Tpl[]),
  ...(kouboScenesJson as Tpl[]),
];

const pick = (name: string): Tpl => TEMPLATES.find((t) => t.name.includes(name)) ?? TEMPLATES[0];
const seedItem = (id: string, tpl: Tpl, startFrame: number) => ({
  id, track: 'V1' as const, startFrame, durationInFrames: tpl.durationInFrames,
  kind: 'motion-graphic' as const, templateId: tpl.id, name: tpl.name,
  code: tpl.code, props: { ...tpl.props }, width: tpl.width, height: tpl.height,
});
const SEED_A = pick('Finance Explainer');
const SEED_B = pick('Dark Tech');

export const INITIAL: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [
    seedItem('seed_1', SEED_A, 0),
    seedItem('seed_2', SEED_B, SEED_A.durationInFrames),
  ],
  selectedId: null,
};
