// 设置面板的信息架构(一级分类 → 二级能力组 → 字段)与纯展示逻辑。
// 只放数据与纯函数,布局/交互在 SettingsDialog.tsx。
// 安全不变式:这里只描述字段元信息,任何服务端值都不会出现在前端。
import type { IconName } from './icons';

export type FieldKind = 'secret' | 'text';

export interface SettingsField {
  readonly name: string;
  readonly label: string;
  /** secret=密钥(默认遮罩);text=非密钥(base url / 模板 ID,恒明文) */
  readonly kind: FieldKind;
  /** 未配置时的 placeholder(text 字段的官方默认地址提示);缺省用通用文案 */
  readonly placeholder?: string;
  readonly note?: string;
}

export interface SettingsGroup {
  /** 能力 key(对应 caps),或特例 'llm' */
  readonly key: string;
  readonly title: string;
  readonly hint: string;
  readonly fields: readonly SettingsField[];
}

export interface SettingsCategory {
  readonly key: string;
  readonly title: string;
  readonly icon: IconName;
  readonly groups: readonly SettingsGroup[];
}

// GET /api/keys 的响应形状 — 只有布尔与来源,永远没有值。
export interface KeyState { configured: boolean; source: 'env' | 'runtime' | 'none'; }
export interface KeyStatusResponse { keys: Record<string, KeyState>; caps: Record<string, boolean>; }

const secret = (name: string, label: string): SettingsField => ({ name, label, kind: 'secret' });
const text = (name: string, label: string, placeholder?: string, note?: string): SettingsField =>
  ({ name, label, kind: 'text', placeholder, note });

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    key: 'agent', title: 'Agent 模型', icon: 'sparkles',
    groups: [
      { key: 'llm', title: 'Agent 大脑 · Claude 中转', hint: '对话与工具调用的核心，未配置无法对话。', fields: [
        secret('LLM_API_KEY', 'API Key'),
        text('LLM_BASE_URL', '中转站 Base URL', '默认 https://api.aijws.com', '改动需重启 dev server 生效'),
      ] },
    ],
  },
  {
    key: 'generation', title: 'AI 生成', icon: 'image',
    groups: [
      { key: 'image', title: '生图', hint: 'submit_image · 文生图 / 图生图，二选一即可。', fields: [
        secret('IMAGE_API_KEY', 'OpenAI 兼容图像 Key（gpt-image）'),
        text('IMAGE_BASE_URL', 'gpt-image 中转站 Base URL', '默认 https://api.openai.com'),
        secret('GEMINI_API_KEY', 'Gemini Key（Nano Banana）'),
        text('GEMINI_BASE_URL', 'Gemini 中转站 Base URL', '默认 https://generativelanguage.googleapis.com'),
      ] },
      { key: 'voice', title: '配音 / TTS', hint: 'submit_voice · ElevenLabs 或豆包二选一；ElevenLabs Key 同时用于音效生成。', fields: [
        secret('ELEVENLABS_API_KEY', 'ElevenLabs Key'),
        text('ELEVENLABS_BASE_URL', 'ElevenLabs 中转站 Base URL', '默认 https://api.elevenlabs.io'),
        secret('DOUBAO_TTS_APP_ID', '豆包 TTS App ID'),
        secret('DOUBAO_TTS_ACCESS_KEY', '豆包 TTS Access Key'),
        text('DOUBAO_TTS_BASE_URL', '豆包中转站 Base URL', '默认 https://openspeech.bytedance.com'),
      ] },
      { key: 'video', title: '生视频', hint: 'submit_video · 文 / 图生视频，二选一即可。', fields: [
        secret('SEEDANCE_API_KEY', 'Seedance（豆包）Key'),
        text('SEEDANCE_BASE_URL', 'Seedance 中转站 Base URL', '默认 https://ark.cn-beijing.volces.com/api/v3'),
        secret('KLING_API_KEY', '可灵 Kling Key'),
        text('KLING_BASE_URL', 'Kling 中转站 Base URL', '默认 https://api-singapore.klingai.com'),
      ] },
      { key: 'music', title: '生音乐', hint: 'submit_music · 文字生成配乐。', fields: [
        secret('MUREKA_API_KEY', 'Mureka Key'),
        text('MUREKA_BASE_URL', 'Mureka 中转站 Base URL', '默认 https://api.mureka.ai'),
      ] },
    ],
  },
  {
    key: 'assets', title: '素材 · 转写', icon: 'folder',
    groups: [
      { key: 'stock', title: '在线图库', hint: 'search_stock_media · 搜索可商用图片 / 视频素材。', fields: [
        secret('PEXELS_API_KEY', 'Pexels Key'),
        secret('PIXABAY_API_KEY', 'Pixabay Key'),
      ] },
      { key: 'transcription', title: '转写 / 口播剪辑', hint: 'transcribe_track · 词级字幕、清口水、删词。', fields: [
        secret('ASSEMBLYAI_API_KEY', 'AssemblyAI Key'),
      ] },
    ],
  },
  {
    key: 'tools', title: '增强工具', icon: 'sliders',
    groups: [
      { key: 'sandbox', title: '沙箱执行', hint: 'run_code · ffmpeg / node / python 媒体探测与处理。', fields: [
        secret('E2B_API_KEY', 'E2B Key'),
        text('E2B_TEMPLATE', 'E2B 模板 ID（可选）'),
      ] },
      { key: 'web', title: '网页抓取', hint: 'web_browser · 抓取网页内容供 Agent 参考。', fields: [
        secret('FIRECRAWL_API_KEY', 'Firecrawl Key'),
      ] },
    ],
  },
];

/** 组的「已配置」判定:llm 看 LLM_API_KEY 本身,其余看服务端能力布尔。 */
export function groupConfigured(status: KeyStatusResponse | null, group: SettingsGroup): boolean {
  if (!status) return false;
  if (group.key === 'llm') return Boolean(status.keys.LLM_API_KEY?.configured);
  return Boolean(status.caps[group.key]);
}

/** 分类徽标用:该分类下已配置组数。 */
export function categoryConfiguredCount(status: KeyStatusResponse | null, category: SettingsCategory): number {
  return category.groups.filter((g) => groupConfigured(status, g)).length;
}

/** 输入框 placeholder:永不回填服务端值,只描述状态。带默认地址提示的
 * text 字段(base url)已配置时显示「已自定义」,其余显示通用文案。 */
export function fieldPlaceholder(field: SettingsField, configured: boolean, stagedClear: boolean): string {
  if (stagedClear) return '将清除 · 保存后生效';
  if (configured) return field.placeholder ? '已自定义 · 留空保持不变' : '已配置 · 留空保持不变';
  return field.placeholder ?? '未配置 · 粘贴以启用';
}
