import type { IconName } from '../icons';

interface ProjectStarter {
  readonly label: string;
  readonly description: string;
  readonly prompt: string;
  readonly icon: IconName;
}

interface QuickAction {
  readonly label: string;
  readonly prompt: string;
}

export const EMPTY_PROJECT_STARTERS: readonly ProjectStarter[] = [
  { label: '口播净剪', description: '去停顿、赘词并同步字幕', prompt: '精剪当前口播：去掉无效停顿和赘词，并生成同步字幕', icon: 'scissors' },
  { label: '动态包装', description: '标题、数据卡与转场动效', prompt: '为当前内容设计动态包装，包含标题、信息卡和转场动效', icon: 'film' },
  { label: '长片拆条', description: '提炼高光并重排为短视频', prompt: '从当前长视频中提炼高光，重排成适合发布的短视频', icon: 'video' },
  { label: '产品故事', description: '围绕卖点组织脚本和镜头', prompt: '围绕产品卖点组织脚本和镜头，制作一支产品宣传短片', icon: 'sparkles' },
  { label: 'AI 影像', description: '从概念生成镜头与声音', prompt: '根据我的概念策划一支 AI 影像，补全镜头、声音和节奏', icon: 'image' },
  { label: '知识成片', description: '把主题整理成清晰讲解', prompt: '把主题整理成结构清晰、带字幕和视觉提示的讲解视频', icon: 'play' },
];

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { label: '删除填充词', prompt: '删除当前口播中的填充词，并保持字幕与画面同步' },
  { label: '删除静音', prompt: '删除当前时间线中的静音停顿，并收紧空隙' },
  { label: '跳切', prompt: '把当前口播剪成节奏紧凑的跳切版本' },
  { label: '生成字幕', prompt: '为当前口播生成并应用同步字幕' },
  { label: '响度标准化', prompt: '将当前时间线中的人声音量标准化' },
  { label: '横转竖', prompt: '将当前工程转换为 9:16 竖屏，并调整主要画面构图' },
];

