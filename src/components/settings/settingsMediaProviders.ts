import {
  modelSelect,
  modelText,
  routeSelect,
  secret,
  text,
  type SettingsField,
  type SettingsGroup,
  type SettingsVendorPage,
} from './settingsFields';

const MINIMAX_NOTE = 'MiniMax 同一个 Key，配置一次全能力（生图 / 配音 / 视频 / 音乐）通用。';

const COMMON_TRANSCRIPTION_FIELDS: readonly SettingsField[] = [
  {
    name: 'TRANSCRIPTION_LANGUAGE',
    label: '转写语言',
    kind: 'select',
    defaultLabel: '中文（zh）',
    options: [
      { value: 'zh', label: '中文（zh）' },
      { value: 'en', label: '英语（en）' },
      { value: 'ja', label: '日语（ja）' },
      { value: 'ko', label: '韩语（ko）' },
      { value: 'es', label: '西班牙语（es）' },
      { value: 'fr', label: '法语（fr）' },
      { value: 'de', label: '德语（de）' },
    ],
  },
  {
    name: 'TRANSCRIPTION_DIARIZATION',
    label: '说话人分离',
    kind: 'select',
    defaultLabel: '启用',
    options: [
      { value: '1', label: '启用' },
      { value: '0', label: '停用' },
    ],
  },
  {
    name: 'AUTO_TRANSCRIBE_INGEST',
    label: '导入后自动转写',
    kind: 'select',
    defaultLabel: '仅本地引擎（免费）',
    note: '素材进入媒体池后是否立即转写。本地 Whisper 免费且在本机运行；云端付费供应商建议保持关闭或手动转写。',
    options: [
      { value: 'off', label: '关闭（手动转写）' },
      { value: 'local', label: '仅本地引擎（免费）' },
      { value: 'all', label: '全部引擎（含云端付费）' },
    ],
  },
];

const transcriptionPage = (
  provider: string,
  vendor: SettingsVendorPage['vendor'],
  title: string,
  fields: readonly SettingsField[],
  note?: string,
): SettingsVendorPage => ({
  key: `transcription/${provider}`,
  vendor,
  title,
  note,
  fields: [...fields, ...COMMON_TRANSCRIPTION_FIELDS],
});

export const localAsrPage = transcriptionPage('local', 'localasr', '本地模型（whisper）', [
  {
    name: 'LOCAL_ASR_MODEL',
    label: '默认模型',
    kind: 'select',
    defaultLabel: '自动（按设备内存选择）',
    note: '选中的模型需已下载；未选择时按设备内存自动挑选（内存 ≥6GB 用 Small，否则 Base）。',
    options: [
      { value: 'tiny', label: 'Whisper Tiny（约 100MB · 最快）' },
      { value: 'base', label: 'Whisper Base（约 80MB · 均衡）' },
      { value: 'small', label: 'Whisper Small（约 250MB · 推荐）' },
      { value: 'medium', label: 'Whisper Medium（约 1.1GB · 精度最高）' },
    ],
  },
], '转写在本机完成：免费、离线、素材不出本机。模型按需下载（见下方列表），自动选择设备优势后端：WebGPU 不可用时回退 CPU。本地转写不含说话人分离（全部归为同一位说话人）。');

export const VOICE_SETTINGS_GROUP: SettingsGroup = {
  key: 'voice',
  title: '配音 / TTS',
  hint: 'submit_voice · 文字转配音，任一厂商即可。',
  route: routeSelect('PREFERRED_VOICE_VENDOR', [
    { value: 'elevenlabs', label: 'ElevenLabs' },
    { value: 'doubao', label: '豆包' },
    { value: 'minimax', label: 'MiniMax' },
    { value: 'inworld', label: 'Inworld' },
    { value: 'fishaudio', label: 'Fish Audio' },
    { value: 'speechify', label: 'Speechify' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'gemini', label: 'Google Gemini' },
    { value: 'mistral', label: 'Mistral Voxtral' },
    { value: 'cartesia', label: 'Cartesia' },
  ]),
  vendors: [
    {
      key: 'voice/elevenlabs', vendor: 'elevenlabs', title: 'ElevenLabs',
      note: 'Key 同时用于音效生成（submit_sound）。',
      fields: [
        secret('ELEVENLABS_API_KEY', 'API Key'),
        text('ELEVENLABS_BASE_URL', 'Base URL', '默认 https://api.elevenlabs.io'),
        modelSelect('ELEVENLABS_TTS_MODEL', '配音模型', 'eleven_multilingual_v2',
          ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5']),
        modelText('ELEVENLABS_SOUND_MODEL', '音效模型', 'eleven_text_to_sound_v2'),
      ],
    },
    {
      key: 'voice/doubao', vendor: 'doubao', title: '豆包 TTS · 火山', fields: [
        secret('DOUBAO_TTS_APP_ID', 'App ID'),
        secret('DOUBAO_TTS_ACCESS_KEY', 'Access Key'),
        text('DOUBAO_TTS_BASE_URL', 'Base URL', '默认 https://openspeech.bytedance.com'),
        modelText('DOUBAO_TTS_RESOURCE_ID', '音色资源 ID', 'seed-tts-2.0'),
      ],
    },
    {
      key: 'voice/minimax', vendor: 'minimax', title: 'MiniMax', note: MINIMAX_NOTE, fields: [
        secret('MINIMAX_API_KEY', 'API Key'),
        text('MINIMAX_BASE_URL', 'Base URL', '默认 https://api.minimaxi.com'),
        modelSelect('MINIMAX_TTS_MODEL', '配音模型', 'speech-2.6-hd',
          ['speech-2.6-hd', 'speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo']),
      ],
    },
    {
      key: 'voice/inworld', vendor: 'inworld', title: 'Inworld', fields: [
        secret('INWORLD_TTS_API_KEY', 'API Key'),
        text('INWORLD_TTS_BASE_URL', 'Base URL', '默认 https://api.inworld.ai'),
        modelText('INWORLD_TTS_MODEL', '配音模型', 'inworld-tts-2'),
      ],
    },
    {
      key: 'voice/fishaudio', vendor: 'fishaudio', title: 'Fish Audio', fields: [
        secret('FISHAUDIO_TTS_API_KEY', 'API Key'),
        text('FISHAUDIO_TTS_BASE_URL', 'Base URL', '默认 https://api.fish.audio'),
        modelText('FISHAUDIO_TTS_MODEL', '配音模型', 's2.1-pro'),
      ],
    },
    {
      key: 'voice/speechify', vendor: 'speechify', title: 'Speechify', fields: [
        secret('SPEECHIFY_TTS_API_KEY', 'API Key'),
        text('SPEECHIFY_TTS_BASE_URL', 'Base URL', '默认 https://api.sws.speechify.com'),
        modelSelect('SPEECHIFY_TTS_MODEL', '配音模型', 'simba-multilingual',
          ['simba-multilingual', 'simba-english', 'simba-3.2']),
      ],
    },
    {
      key: 'voice/openai', vendor: 'openai', title: 'OpenAI', fields: [
        secret('OPENAI_API_KEY', 'API Key'),
        text('IMAGE_BASE_URL', 'Base URL', '默认 https://api.openai.com'),
        modelText('OPENAI_TTS_MODEL', '配音模型', 'gpt-4o-mini-tts'),
      ],
    },
    {
      key: 'voice/gemini', vendor: 'gemini', title: 'Google Gemini', fields: [
        secret('GEMINI_API_KEY', 'API Key'),
        text('GEMINI_BASE_URL', 'Base URL', '默认 https://generativelanguage.googleapis.com'),
        modelText('GEMINI_TTS_MODEL', '配音模型', 'gemini-2.5-flash-preview-tts'),
      ],
    },
    {
      key: 'voice/mistral', vendor: 'mistral', title: 'Mistral Voxtral', fields: [
        secret('LLM_MISTRAL_API_KEY', 'API Key'),
        text('LLM_MISTRAL_BASE_URL', 'Base URL', '默认 https://api.mistral.ai/v1'),
        modelText('MISTRAL_TTS_MODEL', '配音模型', 'voxtral-mini-tts-2603'),
      ],
    },
    {
      key: 'voice/cartesia', vendor: 'cartesia', title: 'Cartesia', fields: [
        secret('CARTESIA_API_KEY', 'API Key'),
        modelText('CARTESIA_TTS_MODEL', '配音模型', 'sonic-3'),
      ],
    },
  ],
};

export const TRANSCRIPTION_SETTINGS_GROUP: SettingsGroup = {
  key: 'transcription',
  title: '转写 / 口播剪辑',
  hint: 'transcribe_track · 词级字幕、清口水、删词。',
  route: routeSelect('PREFERRED_TRANSCRIPTION_PROVIDER', [
    { value: 'assemblyai', label: 'AssemblyAI（云端）' },
    { value: 'local', label: '本地模型（免费 · 离线）' },
    { value: 'openai', label: 'OpenAI（云端）' },
    { value: 'mistral', label: 'Mistral Voxtral（云端）' },
    { value: 'deepgram', label: 'Deepgram（云端）' },
    { value: 'groq', label: 'Groq（云端）' },
    { value: 'elevenlabs', label: 'ElevenLabs Scribe（云端）' },
    { value: 'cartesia', label: 'Cartesia（云端）' },
  ], 'AssemblyAI（默认）'),
  vendors: [
    transcriptionPage('assemblyai', 'assemblyai', 'AssemblyAI', [secret('ASSEMBLYAI_API_KEY', 'API Key')]),
    localAsrPage,
    transcriptionPage('openai', 'openai', 'OpenAI', [
      secret('OPENAI_API_KEY', 'API Key'),
      text('IMAGE_BASE_URL', 'Base URL', '默认 https://api.openai.com'),
      modelText('OPENAI_TRANSCRIPTION_MODEL', '转写模型', 'gpt-4o-mini-transcribe'),
    ]),
    transcriptionPage('mistral', 'mistral', 'Mistral Voxtral', [
      secret('LLM_MISTRAL_API_KEY', 'API Key'),
      text('LLM_MISTRAL_BASE_URL', 'Base URL', '默认 https://api.mistral.ai/v1'),
      modelText('MISTRAL_TRANSCRIPTION_MODEL', '转写模型', 'voxtral-mini-latest'),
    ]),
    transcriptionPage('deepgram', 'deepgram', 'Deepgram', [
      secret('DEEPGRAM_API_KEY', 'API Key'),
      modelText('DEEPGRAM_TRANSCRIPTION_MODEL', '转写模型', 'nova-3'),
    ]),
    transcriptionPage('groq', 'groq', 'Groq', [
      secret('GROQ_API_KEY', 'API Key'),
      text('GROQ_BASE_URL', 'Base URL', '默认 https://api.groq.com/openai/v1'),
      modelText('GROQ_TRANSCRIPTION_MODEL', '转写模型', 'whisper-large-v3-turbo'),
    ]),
    transcriptionPage('elevenlabs', 'elevenlabs', 'ElevenLabs Scribe', [
      secret('ELEVENLABS_API_KEY', 'API Key'),
      modelText('ELEVENLABS_TRANSCRIPTION_MODEL', '转写模型', 'scribe_v2'),
    ]),
    transcriptionPage('cartesia', 'cartesia', 'Cartesia', [
      secret('CARTESIA_API_KEY', 'API Key'),
      modelText('CARTESIA_TRANSCRIPTION_MODEL', '转写模型', 'ink-whisper'),
    ]),
  ],
};

export const ROUTE_NEEDS: Record<string, readonly (readonly string[])[]> = {
  'gpt-image-2': [['IMAGE_API_KEY'], ['OPENAI_API_KEY']],
  'nano-banana': [['GEMINI_API_KEY']],
  'image-01': [['MINIMAX_API_KEY']],
  elevenlabs: [['ELEVENLABS_API_KEY']],
  doubao: [['DOUBAO_TTS_APP_ID', 'DOUBAO_TTS_ACCESS_KEY']],
  minimax: [['MINIMAX_API_KEY']],
  openai: [['OPENAI_API_KEY']],
  gemini: [['GEMINI_API_KEY']],
  mistral: [['LLM_MISTRAL_API_KEY']],
  cartesia: [['CARTESIA_API_KEY']],
  assemblyai: [['ASSEMBLYAI_API_KEY']],
  local: [[]],
  deepgram: [['DEEPGRAM_API_KEY']],
  groq: [['GROQ_API_KEY']],
  seedance2: [['SEEDANCE_API_KEY']],
  kling: [['KLING_API_KEY']],
  hailuo: [['MINIMAX_API_KEY']],
  mureka: [['MUREKA_API_KEY']],
  atlas: [['ATLASCLOUD_API_KEY']],
};
