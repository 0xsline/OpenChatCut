// Set the information architecture of the panel (first-level classification → second-level capability group → third-level provider page → fields) and pure display logic.
// Three columns: Left tree = Category → Capability; Middle column = Vendor list under this capability; Right column = Configuration page of the selected vendor.
// Agent LLM saves independent API URLs, API Keys and models for each vendor; the capability to generate classes can be additionally provided
// Default provider route. Layout/interaction is in SettingsDialog.tsx, vendor icons are in vendorIcons.tsx.
// Security invariant: the secret field only has a Boolean status, and the value will never be backfilled; the model/routing field is a non-secret configuration,
// The current value is echoed through the models channel of GET /api/keys (server-side NON_SECRET_NAMES whitelist).
import { t } from '../../i18n/locale';
import {
  LLM_PROVIDER_PRESETS,
  isLocalLlmProvider,
  llmProviderConfigNames,
} from '../../../shared/llm-providers';
import type { CodexAgentStatus } from '../../../shared/codex-agent';
import type { IconName } from '../icons';
import type { VendorId } from './vendorIcons';

export type FieldKind = 'secret' | 'text' | 'select' | 'toggle' | 'directory';

export interface SelectOption { readonly value: string; readonly label: string; }

export interface SettingsField {
  readonly name: string;
  readonly label: string;
  /** secret=key (mask, never backfill); text=plain text input; select=drop-down (always non-secret model/routing value);
   * toggle=switch (non-secret, ''=on by default, '0'=disabled);directory=desktop native directory selection + manual input */
  readonly kind: FieldKind;
  /** Placeholder when not configured (only non-model text: official default address prompt); default to universal copy */
  readonly placeholder?: string;
  readonly note?: string;
  /** Select option; text is used as datalist input suggestion (such as LLM_MODEL) */
  readonly options?: readonly SelectOption[];
  /** The default value name of the non-confidential model field: select renders the first item "default (xxx)", text renders "default xxx"
   * placeholder. The text field takes it to the models value channel (select constant); clear = returns to default (''). */
  readonly defaultLabel?: string;
  /** Agent LLM field populated from the provider's /models response after a connection test. */
  readonly discoverableModel?: boolean;
}

export interface SettingsVendorPage {
  /** Selected identifier in the middle column, globally unique: 'capability/provider' such as 'video/hailuo' */
  readonly key: string;
  readonly vendor: VendorId;
  readonly title: string;
  /** Page-level small notes (rendered at the top of the field card, such as MiniMax shared Key, ElevenLabs and sound effects) */
  readonly note?: string;
  /** Non-HTTP connection flow rendered by the dedicated Codex account controls. */
  readonly connection?: 'codex';
  readonly fields: readonly SettingsField[];
}

export interface SettingsGroup {
  /** Capability key (corresponding to server caps), or special case 'llm'; globally unique, it is the selection identifier of the left tree */
  readonly key: string;
  readonly title: string;
  readonly hint: string;
  /** Generate the "Default Vendor" routing field (PREFERRED_*) with four capabilities and render it at the top of the middle column; not rendered by default */
  readonly route?: SettingsField;
  readonly vendors: readonly SettingsVendorPage[];
}

export interface SettingsCategory {
  readonly key: string;
  readonly title: string;
  readonly icon: IconName;
  readonly groups: readonly SettingsGroup[];
}

// Response shape of GET/POST /api/keys — secret only returns Boolean and source; models are non-secret value channels
// (Models, URLs and routes, not set = ''), never contains any key value.
export interface KeyState { configured: boolean; source: 'env' | 'runtime' | 'none'; }
export interface KeyStatusResponse {
  keys: Record<string, KeyState>;
  caps: Record<string, boolean>;
  models: Record<string, string>;
}

const secret = (name: string, label: string): SettingsField => ({ name, label, kind: 'secret' });
const text = (name: string, label: string, placeholder?: string, note?: string): SettingsField =>
  ({ name, label, kind: 'text', placeholder, note });
/** Non-confidential model text field: value echo, placeholder="default xxx". */
const modelText = (name: string, label: string, defaultLabel: string, note?: string, discoverableModel?: boolean): SettingsField =>
  ({ name, label, kind: 'text', defaultLabel, note, discoverableModel });
const directory = (name: string, label: string, defaultLabel: string, note?: string): SettingsField =>
  ({ name, label, kind: 'directory', defaultLabel, note });
/** Non-confidential model select: The first item automatically generates "default (xxx)" (value=''). */
const modelSelect = (name: string, label: string, defaultLabel: string, values: readonly string[]): SettingsField =>
  ({ name, label, kind: 'select', defaultLabel, options: values.map((v) => ({ value: v, label: v })) });

/** Capability routing select:'' = asked every time; the remaining values are consistent with the agent tool parameters/PREFERRED_* stored values. */
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
    note: preset.id === 'anthropic'
      ? '内置 Agent 需要 Anthropic API Key。Claude Code 订阅用户请通过「外部 Agent 接入 (MCP)」连接；OpenChatCut 不接收 Claude OAuth。'
      : '每个厂商独立保存地址、密钥与模型。先测试连接，成功后可从接口返回的模型中选择。',
    fields: [
      {
        name: names.baseUrl,
        label: 'API URL',
        kind: 'text',
        defaultLabel: preset.baseUrl,
        note: '填写完整 API 前缀；可使用官方地址、自建网关或兼容中转。',
      },
      secret(names.apiKey, isLocalLlmProvider(preset.id) ? 'API Key（可选）' : 'API Key'),
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

const CODEX_PAGE: SettingsVendorPage = {
  key: 'llm/codex',
  vendor: 'openai',
  title: 'OpenAI · Codex',
  connection: 'codex',
  note: '使用 ChatGPT 订阅登录，由官方 Codex CLI 管理凭据、续期与退出。OpenChatCut 不会读取或显示 OAuth 凭据。',
  fields: [
    {
      name: 'CODEX_MODEL',
      label: 'Codex 模型',
      kind: 'text',
      defaultLabel: 'Codex 默认模型',
      discoverableModel: true,
      note: '登录后可读取当前账号可用的模型，也可以手动填写模型 ID。',
    },
    {
      name: 'CODEX_REASONING_EFFORT',
      label: '推理强度',
      kind: 'select',
      options: [{ value: '', label: '模型默认' }],
      note: '读取模型后显示当前模型支持的档位；留空使用该模型的默认值。',
    },
  ],
};

const AGENT_VENDOR_PAGES: readonly SettingsVendorPage[] = LLM_PROVIDER_PRESETS.flatMap((preset) => {
  const page = llmPage(preset);
  return preset.id === 'openai' ? [page, CODEX_PAGE] : [page];
});

// MiniMax serves 4 capabilities for the same Key/Base URL pair, and only the model fields of that capability are linked to the capability on the page.
const MINIMAX_NOTE = 'MiniMax 同一个 Key，配置一次全能力（生图 / 配音 / 视频 / 音乐）通用。';
const minimaxPage = (cap: string, modelField: SettingsField, title = 'MiniMax', vendor: VendorId = 'minimax'): SettingsVendorPage => ({
  key: `${cap}/${vendor}`, vendor, title, note: MINIMAX_NOTE,
  fields: [
    secret('MINIMAX_API_KEY', 'API Key'),
    text('MINIMAX_BASE_URL', 'Base URL', '默认 https://api.minimaxi.com'),
    modelField,
  ],
});

// BytePlus ModelArk serves image (Seedream) and video (Seedance) from the same Key/Base URL,
// separate from LLM_BYTEPLUS_* (Agent chat) — same sharing convention as MiniMax above.
const BYTEPLUS_NOTE = 'BytePlus ModelArk 同一个 Key，图生 / 视频生成通用；与「Agent 大脑」的 BytePlus 配置各自独立。';
const byteplusPage = (cap: string, modelField: SettingsField, title = 'BytePlus · ModelArk'): SettingsVendorPage => ({
  key: `${cap}/byteplus`, vendor: 'byteplus', title, note: BYTEPLUS_NOTE,
  fields: [
    secret('BYTEPLUS_API_KEY', 'API Key'),
    text('BYTEPLUS_BASE_URL', 'Base URL', '默认 https://ark.ap-southeast.bytepluses.com/api/v3'),
    modelField,
  ],
});

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    key: 'agent', title: 'Agent 模型', icon: 'sparkles',
    groups: [
      { key: 'llm', title: 'Agent 大脑',
        hint: '对话与工具调用的核心，未配置无法对话。',
        vendors: AGENT_VENDOR_PAGES },
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
          { value: 'wavespeed', label: 'WaveSpeed' },
          { value: 'byteplus', label: 'BytePlus · Seedream' },
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
          { key: 'image/wavespeed', vendor: 'wavespeed', title: 'WaveSpeed', fields: [
            secret('WAVESPEED_API_KEY', 'API Key'),
            text('WAVESPEED_BASE_URL', 'Base URL', '默认 https://api.wavespeed.ai'),
            modelText('WAVESPEED_IMAGE_MODEL', '生图模型', 'wavespeed-ai/flux-dev'),
          ] },
          byteplusPage('image', modelText('BYTEPLUS_IMAGE_MODEL', '生图模型', 'seedream-4-5-251128',
            '测试连接后可直接选择接口返回的模型，也可以手动填写模型 ID。', true), 'BytePlus · Seedream'),
        ] },
      { key: 'voice', title: '配音 / TTS', hint: 'submit_voice · 文字转配音，任一厂商即可。',
        route: routeSelect('PREFERRED_VOICE_VENDOR', [
          { value: 'elevenlabs', label: 'ElevenLabs' },
          { value: 'doubao', label: '豆包' },
          { value: 'minimax', label: 'MiniMax' },
          { value: 'inworld', label: 'Inworld' },
          { value: 'fishaudio', label: 'Fish Audio' },
          { value: 'speechify', label: 'Speechify' },
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
          { key: 'voice/inworld', vendor: 'inworld', title: 'Inworld', fields: [
            secret('INWORLD_TTS_API_KEY', 'API Key'),
            text('INWORLD_TTS_BASE_URL', 'Base URL', '默认 https://api.inworld.ai'),
            modelText('INWORLD_TTS_MODEL', '配音模型', 'inworld-tts-2'),
          ] },
          { key: 'voice/fishaudio', vendor: 'fishaudio', title: 'Fish Audio', fields: [
            secret('FISHAUDIO_TTS_API_KEY', 'API Key'),
            text('FISHAUDIO_TTS_BASE_URL', 'Base URL', '默认 https://api.fish.audio'),
            modelText('FISHAUDIO_TTS_MODEL', '配音模型', 's2.1-pro'),
          ] },
          { key: 'voice/speechify', vendor: 'speechify', title: 'Speechify', fields: [
            secret('SPEECHIFY_TTS_API_KEY', 'API Key'),
            text('SPEECHIFY_TTS_BASE_URL', 'Base URL', '默认 https://api.sws.speechify.com'),
            modelSelect('SPEECHIFY_TTS_MODEL', '配音模型', 'simba-multilingual',
              ['simba-multilingual', 'simba-english', 'simba-3.2']),
          ] },
        ] },
      { key: 'video', title: '生视频', hint: 'submit_video · 文 / 图生视频，任一厂商即可。',
        route: routeSelect('PREFERRED_VIDEO_VENDOR', [
          { value: 'seedance2', label: 'Seedance' },
          { value: 'kling', label: '可灵' },
          { value: 'hailuo', label: 'MiniMax 海螺' },
          { value: 'byteplus', label: 'BytePlus · Seedance' },
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
          byteplusPage('video', modelText('BYTEPLUS_VIDEO_MODEL', '视频模型', 'seedance-1-5-pro-251215',
            '测试连接后可直接选择接口返回的模型，也可以手动填写模型 ID。', true), 'BytePlus · Seedance'),
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

/** Temporary changes: field name in map = temporary storage; '' = clear explicitly (model fields will return to default).*/
export type StagedValues = Record<string, string>;

export function omitKey(obj: StagedValues, name: string): StagedValues {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== name));
}

/** '' is explicitly cleared and sent as is; non-null values ​​are sent after trimming; pure blank input is regarded as unchanged (to prevent misclearing).*/
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

/** Whether the field goes through the non-confidential models value channel (current value echo; temporary baseline = current value on the server; clear = return to default).*/
export function isModelField(field: SettingsField): boolean {
  return field.kind === 'select' || field.kind === 'toggle' || field.defaultLabel !== undefined;
}

/** Current model/routing value on the server ('' = not set = use default).*/
export function modelValue(status: KeyStatusResponse | null, name: string): string {
  return status?.models?.[name] ?? '';
}

/** provider page "Configured": All secrets in the page are configured (doubao = double keys);
 * Pages without secret (local disk) to see if any field has been set.*/
export function vendorConfigured(
  status: KeyStatusResponse | null,
  page: SettingsVendorPage,
  codexStatus?: CodexAgentStatus | null,
): boolean {
  if (page.connection === 'codex') {
    return Boolean(codexStatus?.installed && codexStatus.account?.type === 'chatgpt');
  }
  if (!status) return false;
  if (isLocalLlmProvider(page.vendor)) {
    const names = llmProviderConfigNames(page.vendor);
    return Boolean(status.models[names.model]?.trim());
  }
  const secrets = page.fields.filter((f) => f.kind === 'secret');
  if (secrets.length === 0) return page.fields.some((f) => Boolean(status.keys[f.name]?.configured));
  return secrets.every((f) => Boolean(status.keys[f.name]?.configured));
}

/** Determination of "configured" capability group: llm depends on whether any provider page is fully configured, and the rest depends on the server capability Boolean (caps).*/
export function groupConfigured(
  status: KeyStatusResponse | null,
  group: SettingsGroup,
  codexStatus?: CodexAgentStatus | null,
): boolean {
  if (group.key === 'llm') {
    return group.vendors.some((page) => vendorConfigured(status, page, codexStatus));
  }
  return status ? Boolean(status.caps[group.key]) : false;
}

/** Classification logo: Number of configured capabilities/Total number of capabilities (capability level count).*/
export function categoryGroupStats(
  status: KeyStatusResponse | null,
  category: SettingsCategory,
  codexStatus?: CodexAgentStatus | null,
): { done: number; total: number } {
  return {
    done: category.groups.filter((group) => groupConfigured(status, group, codexStatus)).length,
    total: category.groups.length,
  };
}

/** Select key → ability group in the left tree (the group key is globally unique); if not found, fall back to the first group.*/
export function findGroup(key: string): SettingsGroup {
  return SETTINGS_CATEGORIES.flatMap((c) => c.groups).find((g) => g.key === key)
    ?? SETTINGS_CATEGORIES[0].groups[0];
}

/** Complete options for select rendering: insert "default (xxx)" before model select; routing select comes with "ask every time".*/
export function selectOptions(field: SettingsField): readonly SelectOption[] {
  const base = field.options ?? [];
  if (field.defaultLabel === undefined) return base;
  return [{ value: '', label: t('默认（{name}）', { name: t(field.defaultLabel) }) }, ...base];
}

// Routing option value → AND group of keys required to determine "configured" (OR; mirror server computeCaps and
// CAP_PROVIDERS of agent capabilities, do not change them separately).
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

/** Routing drop-down option copy: Add the "(not configured)" suffix when the provider has not configured it, and it is still optional (there is a fallback inquiry guardrail on the Agent side).
 * Non-routing select (model drop-down) returns unchanged.*/
export function selectOptionLabel(
  status: KeyStatusResponse | null, field: SettingsField, opt: SelectOption,
): string {
  if (!field.name.startsWith('PREFERRED_') || opt.value === '') return t(opt.label);
  const needs = ROUTE_NEEDS[opt.value];
  const has = (n: string): boolean => Boolean(status?.keys[n]?.configured);
  const ok = Boolean(needs?.some((group) => group.every(has)));
  return ok ? t(opt.label) : t('{name}（未配置）', { name: t(opt.label) });
}

/** Input box placeholder: secret / Ordinary text never backfills, only describes the status; model text describes the default value.*/
export function fieldPlaceholder(field: SettingsField, configured: boolean, stagedClear: boolean): string {
  if (isModelField(field)) {
    if (stagedClear) return t('恢复默认 · 保存后生效');
    return field.defaultLabel ? t('默认 {name}', { name: t(field.defaultLabel) }) : t('默认');
  }
  if (stagedClear) return t('将清除 · 保存后生效');
  if (configured) return field.placeholder ? t('已自定义 · 留空保持不变') : t('已配置 · 留空保持不变');
  return field.placeholder ? t(field.placeholder) : t('未配置 · 粘贴以启用');
}
