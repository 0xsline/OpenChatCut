// 设置面板的信息架构(一级分类 → 二级能力组 → 三级厂商卡 → 字段)与纯展示逻辑。
// 只放数据与纯函数,布局/交互在 SettingsDialog.tsx,厂商图标在 vendorIcons.tsx。
// 安全不变式:这里只描述字段元信息,任何服务端值都不会出现在前端。
import type { IconName } from './icons';
import type { VendorId } from './vendorIcons';

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

export interface SettingsVendor {
  /** 厂商图标 key(vendorIcons.tsx);组内唯一,可跨组重复(MiniMax) */
  readonly vendor: VendorId;
  readonly title: string;
  /** 卡级小注(如 MiniMax 共享 Key、ElevenLabs 兼音效) */
  readonly note?: string;
  readonly fields: readonly SettingsField[];
}

export interface SettingsGroup {
  /** 能力 key(对应 caps),或特例 'llm';全局唯一,是侧栏树的选中标识 */
  readonly key: string;
  readonly title: string;
  readonly hint: string;
  readonly vendors: readonly SettingsVendor[];
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

// MiniMax 同一对 Key/Base URL 服务 4 个能力组:values 按字段名全局共享,
// 在任一 MiniMax 卡填写/清除,其余组的卡即时同步(现有实现天然如此)。
const MINIMAX_NOTE = 'MiniMax 同一个 Key，配置一次全能力（生图 / 配音 / 视频 / 音乐）通用。';
const MINIMAX_FIELDS: readonly SettingsField[] = [
  secret('MINIMAX_API_KEY', 'API Key'),
  text('MINIMAX_BASE_URL', 'Base URL', '默认 https://api.minimaxi.com'),
];
const minimax = (title: string): SettingsVendor =>
  ({ vendor: 'minimax', title, note: MINIMAX_NOTE, fields: MINIMAX_FIELDS });

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    key: 'agent', title: 'Agent 模型', icon: 'sparkles',
    groups: [
      { key: 'llm', title: 'Agent 大脑',
        hint: '对话与工具调用的核心，未配置无法对话。也可填 MiniMax M 系兼容端点 https://api.minimaxi.com/anthropic。',
        vendors: [
          { vendor: 'anthropic', title: 'Anthropic 兼容中转', fields: [
            secret('LLM_API_KEY', 'API Key'),
            text('LLM_BASE_URL', '中转站 Base URL', '默认 https://api.aijws.com', '改动需重启 dev server 生效'),
          ] },
        ] },
    ],
  },
  {
    key: 'generation', title: 'AI 生成', icon: 'image',
    groups: [
      { key: 'image', title: '生图', hint: 'submit_image · 文生图 / 图生图，任一厂商即可。', vendors: [
        { vendor: 'openai', title: 'OpenAI', fields: [
          secret('IMAGE_API_KEY', 'API Key（gpt-image）'),
          text('IMAGE_BASE_URL', 'Base URL', '默认 https://api.openai.com'),
        ] },
        { vendor: 'gemini', title: 'Google Gemini', fields: [
          secret('GEMINI_API_KEY', 'API Key（Nano Banana）'),
          text('GEMINI_BASE_URL', 'Base URL', '默认 https://generativelanguage.googleapis.com'),
        ] },
        minimax('MiniMax'),
      ] },
      { key: 'voice', title: '配音 / TTS', hint: 'submit_voice · 文字转配音，任一厂商即可。', vendors: [
        { vendor: 'elevenlabs', title: 'ElevenLabs', note: 'Key 同时用于音效生成。', fields: [
          secret('ELEVENLABS_API_KEY', 'API Key'),
          text('ELEVENLABS_BASE_URL', 'Base URL', '默认 https://api.elevenlabs.io'),
        ] },
        { vendor: 'doubao', title: '豆包 · 火山', fields: [
          secret('DOUBAO_TTS_APP_ID', 'App ID'),
          secret('DOUBAO_TTS_ACCESS_KEY', 'Access Key'),
          text('DOUBAO_TTS_BASE_URL', 'Base URL', '默认 https://openspeech.bytedance.com'),
        ] },
        minimax('MiniMax'),
      ] },
      { key: 'video', title: '生视频', hint: 'submit_video · 文 / 图生视频，任一厂商即可。', vendors: [
        { vendor: 'seedance', title: 'Seedance · 豆包', fields: [
          secret('SEEDANCE_API_KEY', 'API Key'),
          text('SEEDANCE_BASE_URL', 'Base URL', '默认 https://ark.cn-beijing.volces.com/api/v3'),
        ] },
        { vendor: 'kling', title: '可灵 Kling', fields: [
          secret('KLING_API_KEY', 'API Key'),
          text('KLING_BASE_URL', 'Base URL', '默认 https://api-singapore.klingai.com'),
        ] },
        minimax('MiniMax 海螺'),
      ] },
      { key: 'music', title: '生音乐', hint: 'submit_music · 文字生成配乐，任一厂商即可。', vendors: [
        { vendor: 'mureka', title: 'Mureka', fields: [
          secret('MUREKA_API_KEY', 'API Key'),
          text('MUREKA_BASE_URL', 'Base URL', '默认 https://api.mureka.ai'),
        ] },
        minimax('MiniMax'),
      ] },
    ],
  },
  {
    key: 'assets', title: '素材 · 转写', icon: 'folder',
    groups: [
      { key: 'stock', title: '在线图库', hint: 'search_stock_media · 搜索可商用图片 / 视频素材。', vendors: [
        { vendor: 'pexels', title: 'Pexels', fields: [secret('PEXELS_API_KEY', 'API Key')] },
        { vendor: 'pixabay', title: 'Pixabay', fields: [secret('PIXABAY_API_KEY', 'API Key')] },
      ] },
      { key: 'transcription', title: '转写 / 口播剪辑', hint: 'transcribe_track · 词级字幕、清口水、删词。', vendors: [
        { vendor: 'assemblyai', title: 'AssemblyAI', fields: [secret('ASSEMBLYAI_API_KEY', 'API Key')] },
      ] },
    ],
  },
  {
    key: 'tools', title: '增强工具', icon: 'sliders',
    groups: [
      { key: 'sandbox', title: '沙箱执行', hint: 'run_code · ffmpeg / node / python 媒体探测与处理。', vendors: [
        { vendor: 'e2b', title: 'E2B', fields: [
          secret('E2B_API_KEY', 'API Key'),
          text('E2B_TEMPLATE', '模板 ID（可选）'),
        ] },
      ] },
      { key: 'web', title: '网页抓取', hint: 'web_browser · 抓取网页内容供 Agent 参考。', vendors: [
        { vendor: 'firecrawl', title: 'Firecrawl', fields: [secret('FIRECRAWL_API_KEY', 'API Key')] },
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

/** 厂商卡的「已配置」判定:卡内全部 secret 字段(主 key)都 configured;
 * base url 等 text 字段不参与(豆包 = App ID 与 Access Key 双配齐,其余 = 单 key)。 */
export function vendorConfigured(status: KeyStatusResponse | null, vendor: SettingsVendor): boolean {
  if (!status) return false;
  const secrets = vendor.fields.filter((f) => f.kind === 'secret');
  return secrets.length > 0 && secrets.every((f) => Boolean(status.keys[f.name]?.configured));
}

/** 分类徽标用:该分类下已配置组数。 */
export function categoryConfiguredCount(status: KeyStatusResponse | null, category: SettingsCategory): number {
  return category.groups.filter((g) => groupConfigured(status, g)).length;
}

/** 侧栏树选中 key → 能力组(组 key 全局唯一);找不到回退第一组。 */
export function findGroup(key: string): SettingsGroup {
  return SETTINGS_CATEGORIES.flatMap((c) => c.groups).find((g) => g.key === key)
    ?? SETTINGS_CATEGORIES[0].groups[0];
}

/** 输入框 placeholder:永不回填服务端值,只描述状态。带默认地址提示的
 * text 字段(base url)已配置时显示「已自定义」,其余显示通用文案。 */
export function fieldPlaceholder(field: SettingsField, configured: boolean, stagedClear: boolean): string {
  if (stagedClear) return '将清除 · 保存后生效';
  if (configured) return field.placeholder ? '已自定义 · 留空保持不变' : '已配置 · 留空保持不变';
  return field.placeholder ?? '未配置 · 粘贴以启用';
}
