import { getPluginSkill } from './plugin-skills';
import type { SkillDefinition } from './skill-types';

interface CreativeSkillMetadata {
  id: string;
  slug: string;
  name: string;
  nameZh: string;
  summary: string;
  scenarios: string[];
}

const CREATIVE_SKILL_METADATA: CreativeSkillMetadata[] = [
  {
    id: '11111111-1240-4000-8000-000000000004',
    slug: 'long-video-to-shorts',
    name: 'Long Video to Shorts',
    nameZh: '长视频转短视频',
    summary: '把一条长播客、访谈、课程或直播剪成适合社媒发布的短视频和高光。',
    scenarios: [
      'long-video-to-shorts',
      'reels',
      'tiktok',
      'shorts',
      'social-clips',
      'highlight-reel'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000012',
    slug: 'multi-clips-to-reels',
    name: 'Multi Clips to Reels',
    nameZh: '多素材剪 Reels',
    summary: '把产品、活动、旅行或游戏素材剪成适合社媒发布的 Reels。',
    scenarios: [
      'multi-clips-to-reels',
      'multi-clips-to-shorts',
      'raw-clips',
      'reels',
      'tiktok',
      'shorts'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000005',
    slug: 'ai-cinematic-short-film',
    name: 'AI Cinematic Short Film',
    nameZh: 'AI 电影感短片',
    summary: '规划并制作 AI 电影感短片，覆盖故事、镜头、提示词、连续性和最终检查。',
    scenarios: [
      'ai-film',
      'cinematic',
      'seedance',
      'story',
      'short-film',
      'video-generation'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000006',
    slug: 'product-ad-video-script',
    name: 'Product Ad Video Script',
    nameZh: '产品广告脚本',
    summary: '把产品或页面转成广告角度、开头钩子、分镜、字幕、CTA 和视觉方向。',
    scenarios: [
      'ad',
      'e-commerce',
      'landing-page',
      'marketing',
      'product',
      'script'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000011',
    slug: 'explainer-video',
    name: 'Explainer Video',
    nameZh: '解说视频制作',
    summary: '把主题、脚本、配音、产品逻辑或数据做成完整解说视频。',
    scenarios: [
      'concept',
      'course',
      'data',
      'education',
      'explainer',
      'explainer-video'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000008',
    slug: 'motion-graphic-placement',
    name: 'Motion Graphic Placement',
    nameZh: '动效点缀指南',
    summary: '在合适时机添加动效，强化表达且不遮挡内容。',
    scenarios: [
      'creator-video',
      'interview',
      'lecture',
      'motion-graphic-placement',
      'motion-graphics',
      'podcast'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000009',
    slug: 'storyboard-shot-breakdown',
    name: 'Storyboard Shot Breakdown',
    nameZh: '拉片分镜图',
    summary: '逐镜拆解镜头语言，并生成分镜参考图。',
    scenarios: [
      'cinematography',
      'director-logic',
      'film-analysis',
      'shot-analysis',
      'shot-breakdown',
      'storyboard'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000010',
    slug: 'video-thumbnail-generator',
    name: 'Video Thumbnail Generator',
    nameZh: '视频封面生成',
    summary: '基于视频内容和真实画面生成适合平台的封面图。',
    scenarios: [
      'bilibili-cover',
      'cover-image',
      'poster',
      'shorts-cover',
      'thumbnail',
      'video-cover'
    ]
  }
];

export const CREATIVE_SKILLS: SkillDefinition[] = CREATIVE_SKILL_METADATA.flatMap((metadata) => {
  const file = getPluginSkill(metadata.slug);
  if (!file) {
    if (typeof import.meta.env !== 'undefined') {
      throw new Error(`Creative skill metadata references missing SKILL.md: ${metadata.slug}`);
    }
    return [];
  }
  return [{
    ...metadata,
    description: file.description,
    body: file.body,
    files: file.files,
    source: 'builtin',
  }];
});

let customSkills: SkillDefinition[] = [];

export function setCustomSkills(list: SkillDefinition[]): void {
  customSkills = list;
}

/** Built-in then custom skills shown in the Creative Mode picker. */
export function allCreativeSkills(): SkillDefinition[] {
  return [...CREATIVE_SKILLS, ...customSkills];
}

export const findSkill = (id: string | null | undefined): SkillDefinition | undefined =>
  id ? (CREATIVE_SKILLS.find((skill) => skill.id === id) ?? customSkills.find((skill) => skill.id === id)) : undefined;
