// Set the information architecture of the panel (first-level classification → second-level capability group → third-level manufacturer page → fields) and pure display logic.
// Three columns: left tree = classification → capability; middle column = list of manufacturers under this capability; right column = configuration page of the selected manufacturer.
// Agent LLM saves independent API URLs, API Keys and models for each vendor; generation class capabilities are available additionally
// Default manufacturer route. Layout/interaction is in SettingsDialog.tsx, vendor icons are in vendorIcons.tsx.
// Security invariant: the secret field only has a Boolean state, and the value will never be backfilled; the model/routing field is a non-secret configuration,
// The current value is echoed via the models channel of GET /api/keys (server-side NON_SECRET_NAMES whitelist).
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
  /** secret=key(Mask, never backfill);text=Plain text input;select=drop down(Constantly non-secret model/routing value);
   * toggle=switch(Unclassified,''=On by default,'0'=deactivate);directory=Desktop native directory selection + Manual entry */
  readonly kind: FieldKind;
  /** When not configured placeholder(Only non-models text:Official default address prompt);Use generic copy by default */
  readonly placeholder?: string;
  readonly note?: string;
  /** select options;text time as datalist Enter suggestion(Such as LLM_MODEL) */
  readonly options?: readonly SelectOption[];
  /** Default value name for non-secret model fields:select First rendering "Default (xxx）」,text Render "Default xxx」
   * placeholder。text Take it and go with the field models value channel(select Constant walking);Clear = Return to default('')。 */
  readonly defaultLabel?: string;
  /** Agent LLM field populated from the provider's /models response after a connection test. */
  readonly discoverableModel?: boolean;
}

export interface SettingsVendorPage {
  /** Center column check mark,Globally unique:'Ability/Manufacturer' Such as 'video/hailuo' */
  readonly key: string;
  readonly vendor: VendorId;
  readonly title: string;
  /** Page level notes(Rendered on top of field card,Such as MiniMax share Key、ElevenLabs Also sound effects) */
  readonly note?: string;
  readonly fields: readonly SettingsField[];
}

export interface SettingsGroup {
  /** Ability key(Corresponding server caps),or special case 'llm';Globally unique,Is the selection mark of the left tree */
  readonly key: string;
  readonly title: string;
  readonly hint: string;
  /** Generate the "Default Vendor" routing field for four capabilities(PREFERRED_*),Rendered on top of center column;Not rendered by default */
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
// (Models, URLs and Routes, not set = ''), never contains any key value.
export interface KeyState { configured: boolean; source: 'env' | 'runtime' | 'none'; }
export interface KeyStatusResponse {
  keys: Record<string, KeyState>;
  caps: Record<string, boolean>;
  models: Record<string, string>;
}

const secret = (name: string, label: string): SettingsField => ({ name, label, kind: 'secret' });
const text = (name: string, label: string, placeholder?: string, note?: string): SettingsField =>
  ({ name, label, kind: 'text', placeholder, note });
/** Unclassified model text Field:value echo,placeholder="Default xxx」。 */
const modelText = (name: string, label: string, defaultLabel: string, note?: string): SettingsField =>
  ({ name, label, kind: 'text', defaultLabel, note });
const directory = (name: string, label: string, defaultLabel: string, note?: string): SettingsField =>
  ({ name, label, kind: 'directory', defaultLabel, note });
/** Unclassified model select:The first item automatically generates "Default (xxx）」(value='')。 */
const modelSelect = (name: string, label: string, defaultLabel: string, values: readonly string[]): SettingsField =>
  ({ name, label, kind: 'select', defaultLabel, options: values.map((v) => ({ value: v, label: v })) });

/** Capability routing select:'' = Ask every time;The rest value with agent Tool parameters / PREFERRED_* The stored value is consistent. */
const routeSelect = (name: string, options: readonly SelectOption[]): SettingsField => ({
  name, label: 'Default manufacturer', kind: 'select',
  note: 'When selecting an unconfigured vendor,Agent Will fall back to asking first.',
  options: [{ value: '', label: 'Ask every time (default)' }, ...options],
});

const llmPage = (preset: (typeof LLM_PROVIDER_PRESETS)[number]): SettingsVendorPage => {
  const names = llmProviderConfigNames(preset.id);
  return {
    key: `llm/${preset.id}`,
    vendor: preset.id as VendorId,
    title: preset.label,
    note: 'Each vendor keeps addresses, keys and models independently. Test the connection first. After success, you can choose from the models returned by the interface.',
    fields: [
      {
        name: names.baseUrl,
        label: 'API URL',
        kind: 'text',
        defaultLabel: preset.baseUrl,
        note: 'Completely filled in API Prefix; you can use official address, self-built gateway or compatible transfer.',
      },
      secret(names.apiKey, 'API Key'),
      ...(preset.id === 'openai' ? [{
        name: 'LLM_OPENAI_API_MODE',
        label: 'Interface format',
        kind: 'select' as const,
        defaultLabel: 'Responses API(recommended)',
        note: 'Select the protocols that the service actually supports;OpenAI Use Responses API, compatible with service usage Chat Completions API。',
        options: [{ value: 'chat', label: 'Chat Completions API' }],
      }] : []),
      {
        name: names.model,
        label: 'model',
        kind: 'text',
        defaultLabel: preset.defaultModel,
        discoverableModel: true,
        note: 'After testing the connection, you can directly select the model returned by the interface, or you can manually fill in the model. ID。',
        options: [{ value: preset.defaultModel, label: preset.defaultModel }],
      },
    ],
  };
};

// MiniMax serves 4 capabilities for the same Key/Base URL pair, and only the model fields of that capability are linked to the capability on the page.
const MINIMAX_NOTE = 'MiniMax same one Key, configure full capabilities once (raw picture / dubbing / video / music) universal.';
const minimaxPage = (cap: string, modelField: SettingsField, title = 'MiniMax', vendor: VendorId = 'minimax'): SettingsVendorPage => ({
  key: `${cap}/${vendor}`, vendor, title, note: MINIMAX_NOTE,
  fields: [
    secret('MINIMAX_API_KEY', 'API Key'),
    text('MINIMAX_BASE_URL', 'Base URL', 'Default https://api.minimaxi.com'),
    modelField,
  ],
});

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    key: 'agent', title: 'Agent model', icon: 'sparkles',
    groups: [
      { key: 'llm', title: 'Agent brain',
        hint: 'The core of dialogue and tool calling, dialogue cannot occur without configuration.',
        vendors: LLM_PROVIDER_PRESETS.map(llmPage) },
    ],
  },
  {
    key: 'generation', title: 'AI generate', icon: 'image',
    groups: [
      { key: 'image', title: 'raw picture', hint: 'submit_image · Vincentian picture / Pictures make pictures, any manufacturer can do it.',
        route: routeSelect('PREFERRED_IMAGE_VENDOR', [
          { value: 'gpt-image-2', label: 'OpenAI gpt-image' },
          { value: 'nano-banana', label: 'Gemini Nano Banana' },
          { value: 'image-01', label: 'MiniMax' },
        ]),
        vendors: [
          { key: 'image/openai', vendor: 'openai', title: 'OpenAI', fields: [
            secret('IMAGE_API_KEY', 'API Key（gpt-image）'),
            text('IMAGE_BASE_URL', 'Base URL', 'Default https://api.openai.com'),
          ] },
          { key: 'image/gemini', vendor: 'gemini', title: 'Google Gemini', fields: [
            secret('GEMINI_API_KEY', 'API Key（Nano Banana）'),
            text('GEMINI_BASE_URL', 'Base URL', 'Default https://generativelanguage.googleapis.com'),
            modelText('GEMINI_IMAGE_MODEL', 'graphical model', 'gemini-3.1-flash-image'),
          ] },
          minimaxPage('image', modelSelect('MINIMAX_IMAGE_MODEL', 'graphical model', 'image-01', ['image-01', 'image-01-live'])),
        ] },
      { key: 'voice', title: 'dubbing / TTS', hint: 'submit_voice · Text to dubbing can be converted from any manufacturer.',
        route: routeSelect('PREFERRED_VOICE_VENDOR', [
          { value: 'elevenlabs', label: 'ElevenLabs' },
          { value: 'doubao', label: 'bean bag' },
          { value: 'minimax', label: 'MiniMax' },
        ]),
        vendors: [
          { key: 'voice/elevenlabs', vendor: 'elevenlabs', title: 'ElevenLabs',
            note: 'Key Also used for sound effect generation (submit_sound）。', fields: [
              secret('ELEVENLABS_API_KEY', 'API Key'),
              text('ELEVENLABS_BASE_URL', 'Base URL', 'Default https://api.elevenlabs.io'),
              modelSelect('ELEVENLABS_TTS_MODEL', 'dubbing model', 'eleven_multilingual_v2',
                ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5']),
              modelText('ELEVENLABS_SOUND_MODEL', 'Sound model', 'eleven_text_to_sound_v2'),
            ] },
          { key: 'voice/doubao', vendor: 'doubao', title: 'bean bag TTS · volcano', fields: [
            secret('DOUBAO_TTS_APP_ID', 'App ID'),
            secret('DOUBAO_TTS_ACCESS_KEY', 'Access Key'),
            text('DOUBAO_TTS_BASE_URL', 'Base URL', 'Default https://openspeech.bytedance.com'),
            modelText('DOUBAO_TTS_RESOURCE_ID', 'Sound resources ID', 'seed-tts-2.0'),
          ] },
          minimaxPage('voice', modelSelect('MINIMAX_TTS_MODEL', 'dubbing model', 'speech-2.6-hd',
            ['speech-2.6-hd', 'speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'])),
        ] },
      { key: 'video', title: 'raw video', hint: 'submit_video · text / Tusheng Video, any manufacturer will do.',
        route: routeSelect('PREFERRED_VIDEO_VENDOR', [
          { value: 'seedance2', label: 'Seedance' },
          { value: 'kling', label: 'Ke Ling' },
          { value: 'hailuo', label: 'MiniMax conch' },
        ]),
        vendors: [
          { key: 'video/seedance', vendor: 'seedance', title: 'Seedance · volcano', fields: [
            secret('SEEDANCE_API_KEY', 'API Key'),
            text('SEEDANCE_BASE_URL', 'Base URL', 'Default https://ark.cn-beijing.volces.com/api/v3'),
            modelText('SEEDANCE_VIDEO_MODEL', 'video model', 'doubao-seedance-2-0-260128'),
          ] },
          { key: 'video/kling', vendor: 'kling', title: 'Ke Ling Kling', fields: [
            secret('KLING_API_KEY', 'API Key'),
            text('KLING_BASE_URL', 'Base URL', 'Default https://api-singapore.klingai.com'),
            modelText('KLING_VIDEO_MODEL', 'video model', 'kling-v3-omni'),
          ] },
          minimaxPage('video', modelSelect('MINIMAX_VIDEO_MODEL', 'video model', 'MiniMax-Hailuo-02',
            ['MiniMax-Hailuo-02', 'MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'S2V-01']), 'MiniMax conch', 'hailuo'),
        ] },
      { key: 'music', title: 'live music', hint: 'submit_music · Text generates music from any manufacturer.',
        route: routeSelect('PREFERRED_MUSIC_VENDOR', [
          { value: 'mureka', label: 'Mureka' },
          { value: 'minimax', label: 'MiniMax' },
        ]),
        vendors: [
          { key: 'music/mureka', vendor: 'mureka', title: 'Mureka', fields: [
            secret('MUREKA_API_KEY', 'API Key'),
            text('MUREKA_BASE_URL', 'Base URL', 'Default https://api.mureka.ai'),
            modelText('MUREKA_MUSIC_MODEL', 'music model', 'auto'),
          ] },
          minimaxPage('music', modelSelect('MINIMAX_MUSIC_MODEL', 'music model', 'music-2.6',
            ['music-3.0', 'music-2.6', 'music-3.0-free', 'music-2.6-free', 'music-cover', 'music-cover-free'])),
        ] },
    ],
  },
  {
    key: 'assets', title: 'Material · Transcribe', icon: 'folder',
    groups: [
      { key: 'stock', title: 'Online gallery', hint: 'search_stock_media · Search for commercially available images / Video footage.',
        vendors: [
          { key: 'stock/pexels', vendor: 'pexels', title: 'Pexels', fields: [secret('PEXELS_API_KEY', 'API Key')] },
          { key: 'stock/pixabay', vendor: 'pixabay', title: 'Pixabay', fields: [secret('PIXABAY_API_KEY', 'API Key')] },
          { key: 'stock/unsplash', vendor: 'unsplash', title: 'Unsplash', fields: [secret('UNSPLASH_ACCESS_KEY', 'Access Key')] },
          { key: 'stock/freesound', vendor: 'freesound', title: 'Freesound', fields: [secret('FREESOUND_API_KEY', 'API Key')] },
        ] },
      { key: 'transcription', title: 'Transcribe / oral clip', hint: 'transcribe_track · Word-level subtitles, mouth clearing, and word deletion.',
        vendors: [
          { key: 'transcription/assemblyai', vendor: 'assemblyai', title: 'AssemblyAI',
            fields: [secret('ASSEMBLYAI_API_KEY', 'API Key')] },
        ] },
    ],
  },
  {
    key: 'cloud', title: 'storage', icon: 'cloud',
    groups: [
      { key: 'storage', title: 'media storage', hint: 'The local saving directory of the material, with optional R2 Cloud backup.',
        vendors: [
          { key: 'storage/local', vendor: 'localdisk', title: 'local disk',
            note: 'The desktop version saves materials to the system application data directory by default, and the browser development version uses it by default. public/media/uploads/。'
              + 'You can choose any local directory or external hard drive; after saving, the materials in the old directory will be copied to the new directory (the original files will be retained).'
              + 'The material address in the project remains unchanged, and preview and rendering export will follow the new directory.',
            fields: [
              directory('MEDIA_DIR', 'Material saving directory', 'System default material directory',
                'Click "Select Directory" on the desktop; you can also manually enter the absolute path in the browser. After clearing, return to the default directory of the current running environment.'),
            ] },
          { key: 'storage/r2', vendor: 'r2', title: 'Cloudflare R2',
            note: 'When not configured, the materials are only stored locally (directory on the "Local Disk" page). After configuration: Synchronous writing for each upload R2(The bucket remains private,'
              + 'Read back to the source via local service,src The path remains unchanged); when the local machine lacks files, it will automatically be retrieved from the cloud. Changes take effect immediately.'
              + 'R2 Console bucket building → R2 API Token（Object Read & Write) to get the following four values.',
            fields: [
              { name: 'R2_ENABLED', label: 'Cloud sync', kind: 'toggle',
                note: 'After deactivating, new uploads will only be saved locally (keys are retained and files uploaded to the cloud are not affected); re-enabling will restore write-through.' },
              secret('R2_ACCOUNT_ID', 'Account ID'),
              secret('R2_ACCESS_KEY_ID', 'Access Key ID'),
              secret('R2_SECRET_ACCESS_KEY', 'Secret Access Key'),
              secret('R2_BUCKET', 'Bucket name'),
            ] },
        ] },
    ],
  },
  {
    key: 'tools', title: 'Enhancement tools', icon: 'sliders',
    groups: [
      { key: 'sandbox', title: 'sandbox execution', hint: 'run_code · Cloud sandbox operation ffmpeg / node / python。',
        vendors: [
          { key: 'sandbox/e2b', vendor: 'e2b', title: 'E2B',
            note: 'Cloud isolation Linux Sandbox, do not touch local files.Agent run with it run_code：ffprobe Detection material duration / '
              + 'size code,ffmpeg Transcode / frame extraction / Process audio and video, execute node / python Skill script, after the results are returned'
              + 'Applied to the timeline by native tools. Not configured only affects these tools, and editing and previewing are not affected.',
            fields: [
              secret('E2B_API_KEY', 'API Key'),
              text('E2B_TEMPLATE', 'Template ID(optional)', undefined,
                'The default template does not include ffmpeg;Transcoding / Frame extraction tasks need to be built by yourself ffmpeg template and fill it in ID。'),
            ] },
        ] },
      { key: 'web', title: 'web scraping', hint: 'web_browser · Crawl web content for Agent Reference.',
        vendors: [
          { key: 'web/firecrawl', vendor: 'firecrawl', title: 'Firecrawl',
            fields: [secret('FIRECRAWL_API_KEY', 'API Key')] },
        ] },
    ],
  },
];

/** Temporary changes:The field name is in map inside = There is temporary storage;'' = Clear explicitly(Model fields return to default)。 */
export type StagedValues = Record<string, string>;

export function omitKey(obj: StagedValues, name: string): StagedValues {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== name));
}

/** '' is an explicit clear,Send as is;non-null value trim Send later;Purely blank input is treated as no change(Prevent misclearing)。 */
export function buildPatch(values: StagedValues): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const [name, raw] of Object.entries(values)) {
    if (raw === '') patch[name] = '';
    else if (raw.trim() !== '') patch[name] = raw.trim();
  }
  return patch;
}

export function savedMessage(): string {
  return t('saved · The tool takes effect immediately,Agent You can sense the next message');
}

/** Whether the field is unencrypted models value channel(Current value echo;Staging baseline = Server current value;Clear = Return to default)。 */
export function isModelField(field: SettingsField): boolean {
  return field.kind === 'select' || field.kind === 'toggle' || field.defaultLabel !== undefined;
}

/** Server current model / routing value('' = Not set = Use default)。 */
export function modelValue(status: KeyStatusResponse | null, name: string): string {
  return status?.models?.[name] ?? '';
}

/** Manufacturer page "Configured":All on page secret all configured(bean bag = double key Qi);
 * None secret the page(local disk)See if any field has a value set. */
export function vendorConfigured(status: KeyStatusResponse | null, page: SettingsVendorPage): boolean {
  if (!status) return false;
  const secrets = page.fields.filter((f) => f.kind === 'secret');
  if (secrets.length === 0) return page.fields.some((f) => Boolean(status.keys[f.name]?.configured));
  return secrets.every((f) => Boolean(status.keys[f.name]?.configured));
}

/** Ability group "already configured" determination:llm Check whether any manufacturer page is fully configured,The rest depends on the server capability Boolean(caps)。 */
export function groupConfigured(status: KeyStatusResponse | null, group: SettingsGroup): boolean {
  if (!status) return false;
  if (group.key === 'llm') return group.vendors.some((page) => vendorConfigured(status, page));
  return Boolean(status.caps[group.key]);
}

/** Classification logo:Number of configured capabilities / Total number of abilities(Ability level count)。 */
export function categoryGroupStats(
  status: KeyStatusResponse | null, category: SettingsCategory,
): { done: number; total: number } {
  return {
    done: category.groups.filter((g) => groupConfigured(status, g)).length,
    total: category.groups.length,
  };
}

/** Left tree selected key → ability group(group key Globally unique);Fallback first group not found. */
export function findGroup(key: string): SettingsGroup {
  return SETTINGS_CATEGORIES.flatMap((c) => c.groups).find((g) => g.key === key)
    ?? SETTINGS_CATEGORIES[0].groups[0];
}

/** select Complete options for rendering:model select Prepend "Default (xxx）」;routing select Comes with "Ask Every Time". */
export function selectOptions(field: SettingsField): readonly SelectOption[] {
  const base = field.options ?? [];
  if (field.defaultLabel === undefined) return base;
  return [{ value: '', label: t('default({name}）', { name: t(field.defaultLabel) }) }, ...base];
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

/** Route drop-down option copy:If the manufacturer does not configure it, add "(not configured)" suffix.,Still available(Agent There is a setback guardrail on the side)。
 * non-routing select(Model drop-down)Return as is. */
export function selectOptionLabel(
  status: KeyStatusResponse | null, field: SettingsField, opt: SelectOption,
): string {
  if (!field.name.startsWith('PREFERRED_') || opt.value === '') return t(opt.label);
  const needs = ROUTE_NEEDS[opt.value];
  const has = (n: string): boolean => Boolean(status?.keys[n]?.configured);
  const ok = Boolean(needs?.some((group) => group.every(has)));
  return ok ? t(opt.label) : t('{name}(not configured)', { name: t(opt.label) });
}

/** Input box placeholder:secret / Ordinary text Never backfill, only describe status;model text Describes the default value. */
export function fieldPlaceholder(field: SettingsField, configured: boolean, stagedClear: boolean): string {
  if (isModelField(field)) {
    if (stagedClear) return t('Restore default · Effective after saving');
    return field.defaultLabel ? t('Default {name}', { name: t(field.defaultLabel) }) : t('Default');
  }
  if (stagedClear) return t('will clear · Effective after saving');
  if (configured) return field.placeholder ? t('Customized · Leave blank to leave unchanged') : t('configured · Leave blank to leave unchanged');
  return field.placeholder ? t(field.placeholder) : t('Not configured · Paste to enable');
}
