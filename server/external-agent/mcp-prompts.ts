import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  type Prompt,
} from '@modelcontextprotocol/sdk/types.js';

const PROMPTS: Prompt[] = [
  {
    name: 'create-short-video',
    description: '把当前工程剪成节奏紧凑的竖屏短视频（钩子、推进、高潮、收尾）。',
    arguments: [{ name: 'topic', description: '主题/重点（可选）', required: false }],
  },
  {
    name: 'transcribe-and-caption',
    description: '转写时间线上的音频/视频片段并生成字幕（无音轨片段自动跳过）。',
    arguments: [{ name: 'track', description: '轨道别名，默认音频轨', required: false }],
  },
  {
    name: 'add-background-music',
    description: '为当前时间线匹配并放置合适的背景音乐，做响度标准化。',
    arguments: [{ name: 'mood', description: '情绪方向（可选）', required: false }],
  },
  {
    name: 'generate-script',
    description: '按当前素材写解说词/口播稿，并规划分镜。',
    arguments: [{ name: 'topic', description: '主题', required: true }],
  },
  {
    name: 'export-project',
    description: '导出当前工程为成片（MP4），并报告导出历史。',
    arguments: [{ name: 'format', description: 'mp4 / prores（默认 mp4）', required: false }],
  },
  {
    name: 'clean-up-draft',
    description: '检查时间线：删除填充词、静音停顿，收紧空隙。',
    arguments: [],
  },
];

const PROMPT_TEXT: Record<string, string> = {
  'create-short-video': '请把当前时间线剪成节奏紧凑的竖屏短视频：先梳理素材，确定钩子、推进、高潮和收尾，再执行剪辑、配乐、字幕与发布前检查。主题：{topic}。',
  'transcribe-and-caption': '请转写 {track} 轨道的音频/视频片段并生成字幕；没有音轨的片段跳过即可，完成后汇报哪些片段跳过了。',
  'add-background-music': '请为当前时间线选择并放置合适的背景音乐，标准化到约 -14 LUFS，并确保不与口播冲突。{topic}',
  'export-project': '请导出当前工程为成片（默认 MP4），导出前检查素材完整性，完成后报告导出历史与文件位置。',
  'clean-up-draft': '请检查当前时间线：删除口播中的填充词、删除静音停顿并收紧空隙，保持字幕与画面同步。',
};

export function registerMcpPrompts(server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    const track = typeof args.track === 'string' ? args.track.trim() : '';
    const mood = typeof args.mood === 'string' ? args.mood.trim() : '';
    const template = name === 'generate-script'
      ? `请围绕「${topic}」写一段解说词/口播稿：先明确结构（开头钩子、主体要点、结尾行动引导），再规划与素材匹配的分镜。`
      : PROMPT_TEXT[name];
    if (!template) throw new Error(`Unknown prompt ${name}`);
    const text = template
      .replace(/\{topic\}/g, topic || '当前素材')
      .replace(/\{track\}/g, track || 'A1');
    return {
      description: PROMPTS.find((prompt) => prompt.name === name)?.description,
      messages: [{
        role: 'user',
        content: { type: 'text', text: mood ? `${text}（氛围：${mood}）` : text },
      }],
    };
  });
}
