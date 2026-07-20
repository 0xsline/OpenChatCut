// 设置面板的信息架构(一级分类 → 二级能力组 → 三级厂商页 → 字段)与纯展示逻辑。
// 三栏:左树 = 分类 → 能力;中列 = 该能力下的厂商列表;右列 = 选中厂商的配置页。
// Agent LLM 为每个厂商保存独立的 API URL、API Key 和模型;生成类能力可额外提供
// 默认厂商路由。布局/交互在 SettingsDialog.tsx,厂商图标在 vendorIcons.tsx。
// 安全不变式:secret 字段只有布尔状态,值永不回填;模型/路由字段是非密配置,
// 当前值经 GET /api/keys 的 models 通道回显(服务端 NON_SECRET_NAMES 白名单)。
import { t } from '../../i18n/locale';
import {
  LLM_PROVIDER_PRESETS,
  llmProviderConfigNames,
} from '../../../shared/llm-providers';
import type { IconName } from '../icons';
import type { VendorId } from './vendorIcons';

export type FieldKind = 'secret' | 'text' | 'select' | 'toggle' | 'directory';

export interface SelectOption { readonly value: string; readonly label: string; }

export interface SettingsField {
  readonly name: string;
  readonly label: string;
  /** secret=密钥(遮罩、永不回填);text=明文输入;select=下拉(恒为非密模型/路由值);
   * toggle=开关(非密,''=默认开、'0'=停用);directory=桌面原生目录选择 + 手动输入 */
  readonly kind: FieldKind;
  /** 未配置时的 placeholder(仅非模型 text:官方默认地址提示);缺省用通用文案 */
  readonly placeholder?: string;
  readonly note?: string;
  /** select 的选项;text 时作为 datalist 输入建议(如 LLM_MODEL) */
  readonly options?: readonly SelectOption[];
  /** 非密模型字段的默认值名:select 首项渲染「默认（xxx）」,text 渲染「默认 xxx」
   * placeholder。text 字段带它即走 models 值通道(select 恒走);清除 = 回默认('')。 */
  readonly defaultLabel?: string;
  /** Agent LLM field populated from the provider's /models response after a connection test. */
  readonly discoverableModel?: boolean;
}

export interface SettingsVendorPage {
  /** 中列选中标识,全局唯一:'能力/厂商' 如 'video/hailuo' */
  readonly key: string;
  readonly vendor: VendorId;
  readonly title: string;
  /** 页级小注(渲染在字段卡顶部,如 MiniMax 共享 Key、ElevenLabs 兼音效) */
  readonly note?: string;
  readonly fields: readonly SettingsField[];
}

export interface SettingsGroup {
  /** 能力 key(对应服务端 caps),或特例 'llm';全局唯一,是左树的选中标识 */
  readonly key: string;
  readonly title: string;
  readonly hint: string;
  /** 生成四能力的「默认厂商」路由字段(PREFERRED_*),渲染在中列顶部;缺省不渲染 */
  readonly route?: SettingsField;
  readonly vendors: readonly SettingsVendorPage[];
}

export interface SettingsCategory {
  readonly key: string;
  readonly title: string;
  readonly icon: IconName;
  readonly groups: readonly SettingsGroup[];
}

// GET/POST /api/keys 的响应形状 — secret 只回布尔与来源;models 是非密值通道
// (模型、URL 与路由,未设 = ''),永远不含任何密钥值。
export interface KeyState { configured: boolean; source: 'env' | 'runtime' | 'none'; }
export interface KeyStatusResponse {
  keys: Record<string, KeyState>;
  caps: Record<string, boolean>;
  models: Record<string, string>;
}

const secret = (name: string, label: string): SettingsField => ({ name, label, kind: 'secret' });
const text = (name: string, label: string, placeholder?: string, note?: string): SettingsField =>
  ({ name, label, kind: 'text', placeholder, note });
/** 非密模型 text 字段:值回显,placeholder=「默认 xxx」。 */
const modelText = (name: string, label: string, defaultLabel: string, note?: string): SettingsField =>
  ({ name, label, kind: 'text', defaultLabel, note });
const directory = (name: string, label: string, defaultLabel: string, note?: string): SettingsField =>
  ({ name, label, kind: 'directory', defaultLabel, note });
/** 非密模型 select:首项自动生成「默认（xxx）」(value='')。 */
const modelSelect = (name: string, label: string, defaultLabel: string, values: readonly string[]): SettingsField =>
  ({ name, label, kind: 'select', defaultLabel, options: values.map((v) => ({ value: v, label: v })) });

/** 能力路由 select:'' = 每次询问;其余 value 与 agent 工具参数 / PREFERRED_* 存值一致。 */
const routeSelect = (name: string, options: readonly SelectOption[]): SettingsField => ({
  name, label: '默认厂商', kind: 'select',
  note: '选中未配置的厂商时，Agent 会回退为先询问。',
  options: [{ value: '', label: '每次询问（默认）' }, ...options],
});

const llmPage = (preset: (typeof LLM_PROVIDER_PRESETS)[number]): SettingsVendorPage => {
  const names = llmProviderConfigNames(preset.id);
  return {
    key: `llm/${preset.id}`,
    vendor: preset.id as VendorId,
    title: preset.label,
    note: '每个厂商独立保存地址、密钥与模型。先测试连接，成功后可从接口返回的模型中选择。',
    fields: [
      {
        name: names.baseUrl,
        label: 'API URL',
        kind: 'text',
        defaultLabel: preset.baseUrl,
        note: '填写完整 API 前缀；可使用官方地址、自建网关或兼容中转。',
      },
      secret(names.apiKey, 'API Key'),
      ...(preset.id === 'openai' ? [{
        name: 'LLM_OPENAI_API_MODE',
        label: '接口格式',
        kind: 'select' as const,
        defaultLabel: 'Responses API（推荐）',
        note: '选择服务实际支持的协议；OpenAI 使用 Responses API，兼容服务使用 Chat Completions API。',
        options: [{ value: 'chat', label: 'Chat Completions API' }],
      }] : []),
      {
        name: names.model,
        label: '模型',
        kind: 'text',
        defaultLabel: preset.defaultModel,
        discoverableModel: true,
        note: '测试连接后可直接选择接口返回的模型，也可以手动填写模型 ID。',
        options: [{ value: preset.defaultModel, label: preset.defaultModel }],
      },
    ],
  };
};

// MiniMax 同一对 Key/Base URL 服务 4 个能力,页按能力只挂该能力的模型字段。
const MINIMAX_NOTE = 'MiniMax 同一个 Key，配置一次全能力（生图 / 配音 / 视频 / 音乐）通用。';
const minimaxPage = (cap: string, modelField: SettingsField, title = 'MiniMax', vendor: VendorId = 'minimax'): SettingsVendorPage => ({
  key: `${cap}/${vendor}`, vendor, title, note: MINIMAX_NOTE,
  fields: [
    secret('MINIMAX_API_KEY', 'API Key'),
    text('MINIMAX_BASE_URL', 'Base URL', '默认 https://api.minimaxi.com'),
    modelField,
  ],
});

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    key: 'agent', title: 'Agent 模型', icon: 'sparkles',
    groups: [
      { key: 'llm', title: 'Agent 大脑',
        hint: '对话与工具调用的核心，未配置无法对话。',
        vendors: LLM_PROVIDER_PRESETS.map(llmPage) },
    ],
  },
  {
    key: 'generation', title: 'AI 生成', icon: 'image',
    groups: [
      { key: 'image', title: '生图', hint: 'submit_image · 文生图 / 图生图，任一厂商即可。',
        route: routeSelect('PREFERRED_IMAGE_VENDOR', [
          { value: 'gpt-image-2', label: 'OpenAI gpt-image' },
          { value: 'nano-banana', label: 'Gemini Nano Banana' },
          { value: 'image-01', label: 'MiniMax' },
        ]),
        vendors: [
          { key: 'image/openai', vendor: 'openai', title: 'OpenAI', fields: [
            secret('IMAGE_API_KEY', 'API Key（gpt-image）'),
            text('IMAGE_BASE_URL', 'Base URL', '默认 https://api.openai.com'),
          ] },
          { key: 'image/gemini', vendor: 'gemini', title: 'Google Gemini', fields: [
            secret('GEMINI_API_KEY', 'API Key（Nano Banana）'),
            text('GEMINI_BASE_URL', 'Base URL', '默认 https://generativelanguage.googleapis.com'),
            modelText('GEMINI_IMAGE_MODEL', '生图模型', 'gemini-3.1-flash-image'),
          ] },
          minimaxPage('image', modelSelect('MINIMAX_IMAGE_MODEL', '生图模型', 'image-01', ['image-01', 'image-01-live'])),
        ] },
      { key: 'voice', title: '配音 / TTS', hint: 'submit_voice · 文字转配音，任一厂商即可。',
        route: routeSelect('PREFERRED_VOICE_VENDOR', [
          { value: 'elevenlabs', label: 'ElevenLabs' },
          { value: 'doubao', label: '豆包' },
          { value: 'minimax', label: 'MiniMax' },
        ]),
        vendors: [
          { key: 'voice/elevenlabs', vendor: 'elevenlabs', title: 'ElevenLabs',
            note: 'Key 同时用于音效生成（submit_sound）。', fields: [
              secret('ELEVENLABS_API_KEY', 'API Key'),
              text('ELEVENLABS_BASE_URL', 'Base URL', '默认 https://api.elevenlabs.io'),
              modelSelect('ELEVENLABS_TTS_MODEL', '配音模型', 'eleven_multilingual_v2',
                ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5']),
              modelText('ELEVENLABS_SOUND_MODEL', '音效模型', 'eleven_text_to_sound_v2'),
            ] },
          { key: 'voice/doubao', vendor: 'doubao', title: '豆包 TTS · 火山', fields: [
            secret('DOUBAO_TTS_APP_ID', 'App ID'),
            secret('DOUBAO_TTS_ACCESS_KEY', 'Access Key'),
            text('DOUBAO_TTS_BASE_URL', 'Base URL', '默认 https://openspeech.bytedance.com'),
            modelText('DOUBAO_TTS_RESOURCE_ID', '音色资源 ID', 'seed-tts-2.0'),
          ] },
          minimaxPage('voice', modelSelect('MINIMAX_TTS_MODEL', '配音模型', 'speech-2.6-hd',
            ['speech-2.6-hd', 'speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'])),
        ] },
      { key: 'video', title: '生视频', hint: 'submit_video · 文 / 图生视频，任一厂商即可。',
        route: routeSelect('PREFERRED_VIDEO_VENDOR', [
          { value: 'seedance2', label: 'Seedance' },
          { value: 'kling', label: '可灵' },
          { value: 'hailuo', label: 'MiniMax 海螺' },
        ]),
        vendors: [
          { key: 'video/seedance', vendor: 'seedance', title: 'Seedance · 火山', fields: [
            secret('SEEDANCE_API_KEY', 'API Key'),
            text('SEEDANCE_BASE_URL', 'Base URL', '默认 https://ark.cn-beijing.volces.com/api/v3'),
            modelText('SEEDANCE_VIDEO_MODEL', '视频模型', 'doubao-seedance-2-0-260128'),
          ] },
          { key: 'video/kling', vendor: 'kling', title: '可灵 Kling', fields: [
            secret('KLING_API_KEY', 'API Key'),
            text('KLING_BASE_URL', 'Base URL', '默认 https://api-singapore.klingai.com'),
            modelText('KLING_VIDEO_MODEL', '视频模型', 'kling-v3-omni'),
          ] },
          minimaxPage('video', modelSelect('MINIMAX_VIDEO_MODEL', '视频模型', 'MiniMax-Hailuo-02',
            ['MiniMax-Hailuo-02', 'MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'S2V-01']), 'MiniMax 海螺', 'hailuo'),
        ] },
      { key: 'music', title: '生音乐', hint: 'submit_music · 文字生成配乐，任一厂商即可。',
        route: routeSelect('PREFERRED_MUSIC_VENDOR', [
          { value: 'mureka', label: 'Mureka' },
          { value: 'minimax', label: 'MiniMax' },
        ]),
        vendors: [
          { key: 'music/mureka', vendor: 'mureka', title: 'Mureka', fields: [
            secret('MUREKA_API_KEY', 'API Key'),
            text('MUREKA_BASE_URL', 'Base URL', '默认 https://api.mureka.ai'),
            modelText('MUREKA_MUSIC_MODEL', '音乐模型', 'auto'),
          ] },
          minimaxPage('music', modelSelect('MINIMAX_MUSIC_MODEL', '音乐模型', 'music-2.6',
            ['music-3.0', 'music-2.6', 'music-3.0-free', 'music-2.6-free', 'music-cover', 'music-cover-free'])),
        ] },
    ],
  },
  {
    key: 'assets', title: '素材 · 转写', icon: 'folder',
    groups: [
      { key: 'stock', title: '在线图库', hint: 'search_stock_media · 搜索可商用图片 / 视频素材。',
        vendors: [
          { key: 'stock/pexels', vendor: 'pexels', title: 'Pexels', fields: [secret('PEXELS_API_KEY', 'API Key')] },
          { key: 'stock/pixabay', vendor: 'pixabay', title: 'Pixabay', fields: [secret('PIXABAY_API_KEY', 'API Key')] },
          { key: 'stock/unsplash', vendor: 'unsplash', title: 'Unsplash', fields: [secret('UNSPLASH_ACCESS_KEY', 'Access Key')] },
          { key: 'stock/freesound', vendor: 'freesound', title: 'Freesound', fields: [secret('FREESOUND_API_KEY', 'API Key')] },
        ] },
      { key: 'transcription', title: '转写 / 口播剪辑', hint: 'transcribe_track · 词级字幕、清口水、删词。',
        vendors: [
          { key: 'transcription/assemblyai', vendor: 'assemblyai', title: 'AssemblyAI',
            fields: [secret('ASSEMBLYAI_API_KEY', 'API Key')] },
        ] },
    ],
  },
  {
    key: 'cloud', title: '存储', icon: 'cloud',
    groups: [
      { key: 'storage', title: '媒体存储', hint: '素材的本地保存目录，与可选的 R2 云备份。',
        vendors: [
          { key: 'storage/local', vendor: 'localdisk', title: '本地磁盘',
            note: '桌面端默认把素材存入系统应用数据目录，浏览器开发版默认使用 public/media/uploads/。'
              + '可选择任意本机目录或外置硬盘；保存后旧目录中的素材会复制到新目录（原文件保留），'
              + '工程里的素材地址不变，预览与渲染导出都会跟随新目录。',
            fields: [
              directory('MEDIA_DIR', '素材保存目录', '系统默认素材目录',
                '桌面端点击“选择目录”；浏览器中也可手动输入绝对路径。清除后回到当前运行环境的默认目录。'),
            ] },
          { key: 'storage/r2', vendor: 'r2', title: 'Cloudflare R2',
            note: '未配置时素材只存本机（「本地磁盘」页的目录）。配置后：每次上传同步写入 R2（桶保持私有，'
              + '读取经本地服务回源，src 路径不变）；本机缺文件时自动从云端取回。改动即时生效。'
              + 'R2 控制台建桶 → R2 API Token（Object Read & Write）即可拿到下面四个值。',
            fields: [
              { name: 'R2_ENABLED', label: '云同步', kind: 'toggle',
                note: '停用后新上传只存本地（密钥保留、已上云文件不受影响）；重新启用即恢复写穿。' },
              secret('R2_ACCOUNT_ID', 'Account ID'),
              secret('R2_ACCESS_KEY_ID', 'Access Key ID'),
              secret('R2_SECRET_ACCESS_KEY', 'Secret Access Key'),
              secret('R2_BUCKET', 'Bucket 名'),
            ] },
        ] },
    ],
  },
  {
    key: 'tools', title: '增强工具', icon: 'sliders',
    groups: [
      { key: 'sandbox', title: '沙箱执行', hint: 'run_code · 云端沙箱运行 ffmpeg / node / python。',
        vendors: [
          { key: 'sandbox/e2b', vendor: 'e2b', title: 'E2B',
            note: '云端隔离 Linux 沙箱，不触碰本机文件。Agent 用它跑 run_code：ffprobe 探测素材时长 / '
              + '尺寸编码、ffmpeg 转码 / 抽帧 / 加工音视频、执行 node / python 技能脚本，结果回传后'
              + '由本地工具应用到时间线。未配置只影响这些工具，剪辑与预览不受影响。',
            fields: [
              secret('E2B_API_KEY', 'API Key'),
              text('E2B_TEMPLATE', '模板 ID（可选）', undefined,
                '默认模板不带 ffmpeg；转码 / 抽帧类任务需自建含 ffmpeg 的模板并填其 ID。'),
            ] },
        ] },
      { key: 'web', title: '网页抓取', hint: 'web_browser · 抓取网页内容供 Agent 参考。',
        vendors: [
          { key: 'web/firecrawl', vendor: 'firecrawl', title: 'Firecrawl',
            fields: [secret('FIRECRAWL_API_KEY', 'API Key')] },
        ] },
    ],
  },
];

/** 暂存改动:字段名在 map 里 = 有暂存;'' = 显式清除(模型字段即回默认)。 */
export type StagedValues = Record<string, string>;

export function omitKey(obj: StagedValues, name: string): StagedValues {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== name));
}

/** '' 是显式清除,原样发送;非空值 trim 后发送;纯空白输入视为无改动(防误清)。 */
export function buildPatch(values: StagedValues): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const [name, raw] of Object.entries(values)) {
    if (raw === '') patch[name] = '';
    else if (raw.trim() !== '') patch[name] = raw.trim();
  }
  return patch;
}

export function savedMessage(): string {
  return t('已保存 · 工具即时生效，Agent 下一条消息即可感知');
}

/** 字段是否走非密 models 值通道(当前值回显;暂存基线 = 服务端当前值;清除 = 回默认)。 */
export function isModelField(field: SettingsField): boolean {
  return field.kind === 'select' || field.kind === 'toggle' || field.defaultLabel !== undefined;
}

/** 服务端当前模型 / 路由值('' = 未设 = 用默认)。 */
export function modelValue(status: KeyStatusResponse | null, name: string): string {
  return status?.models?.[name] ?? '';
}

/** 厂商页「已配置」:页内全部 secret 都 configured(豆包 = 双 key 齐);
 * 无 secret 的页(本地磁盘)看任一字段是否已设值。 */
export function vendorConfigured(status: KeyStatusResponse | null, page: SettingsVendorPage): boolean {
  if (!status) return false;
  const secrets = page.fields.filter((f) => f.kind === 'secret');
  if (secrets.length === 0) return page.fields.some((f) => Boolean(status.keys[f.name]?.configured));
  return secrets.every((f) => Boolean(status.keys[f.name]?.configured));
}

/** 能力组「已配置」判定:llm 看任一厂商页是否完整配置,其余看服务端能力布尔(caps)。 */
export function groupConfigured(status: KeyStatusResponse | null, group: SettingsGroup): boolean {
  if (!status) return false;
  if (group.key === 'llm') return group.vendors.some((page) => vendorConfigured(status, page));
  return Boolean(status.caps[group.key]);
}

/** 分类徽标:已配置能力数 / 能力总数(能力级计数)。 */
export function categoryGroupStats(
  status: KeyStatusResponse | null, category: SettingsCategory,
): { done: number; total: number } {
  return {
    done: category.groups.filter((g) => groupConfigured(status, g)).length,
    total: category.groups.length,
  };
}

/** 左树选中 key → 能力组(组 key 全局唯一);找不到回退第一组。 */
export function findGroup(key: string): SettingsGroup {
  return SETTINGS_CATEGORIES.flatMap((c) => c.groups).find((g) => g.key === key)
    ?? SETTINGS_CATEGORIES[0].groups[0];
}

/** select 渲染用的完整选项:模型 select 前插「默认（xxx）」;路由 select 自带「每次询问」。 */
export function selectOptions(field: SettingsField): readonly SelectOption[] {
  const base = field.options ?? [];
  if (field.defaultLabel === undefined) return base;
  return [{ value: '', label: t('默认（{name}）', { name: t(field.defaultLabel) }) }, ...base];
}

// 路由选项 value → 判「已配置」所需 key(OR 的 AND 组;镜像服务端 computeCaps 与
// agent capabilities 的 CAP_PROVIDERS,勿单独改动)。
const ROUTE_NEEDS: Record<string, readonly (readonly string[])[]> = {
  'gpt-image-2': [['IMAGE_API_KEY'], ['OPENAI_API_KEY']],
  'nano-banana': [['GEMINI_API_KEY']],
  'image-01': [['MINIMAX_API_KEY']],
  elevenlabs: [['ELEVENLABS_API_KEY']],
  doubao: [['DOUBAO_TTS_APP_ID', 'DOUBAO_TTS_ACCESS_KEY']],
  minimax: [['MINIMAX_API_KEY']],
  seedance2: [['SEEDANCE_API_KEY']],
  kling: [['KLING_API_KEY']],
  hailuo: [['MINIMAX_API_KEY']],
  mureka: [['MUREKA_API_KEY']],
};

/** 路由下拉选项文案:厂商未配置时加「（未配置）」后缀,仍可选(Agent 侧有回退询问护栏)。
 * 非路由 select(模型下拉)原样返回。 */
export function selectOptionLabel(
  status: KeyStatusResponse | null, field: SettingsField, opt: SelectOption,
): string {
  if (!field.name.startsWith('PREFERRED_') || opt.value === '') return t(opt.label);
  const needs = ROUTE_NEEDS[opt.value];
  const has = (n: string): boolean => Boolean(status?.keys[n]?.configured);
  const ok = Boolean(needs?.some((group) => group.every(has)));
  return ok ? t(opt.label) : t('{name}（未配置）', { name: t(opt.label) });
}

/** 输入框 placeholder:secret / 普通 text 永不回填、只描述状态;模型 text 描述默认值。 */
export function fieldPlaceholder(field: SettingsField, configured: boolean, stagedClear: boolean): string {
  if (isModelField(field)) {
    if (stagedClear) return t('恢复默认 · 保存后生效');
    return field.defaultLabel ? t('默认 {name}', { name: t(field.defaultLabel) }) : t('默认');
  }
  if (stagedClear) return t('将清除 · 保存后生效');
  if (configured) return field.placeholder ? t('已自定义 · 留空保持不变') : t('已配置 · 留空保持不变');
  return field.placeholder ? t(field.placeholder) : t('未配置 · 粘贴以启用');
}
