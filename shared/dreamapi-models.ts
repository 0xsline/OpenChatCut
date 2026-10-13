// DreamAPI catalog. Endpoints and limits follow dreamfaceapp/skill scripts.
// A model id is the only way to reach an endpoint; unknown ids never receive the key.

export type DreamApiKind = 'image' | 'video' | 'voice';
export type DreamApiFieldKind = 'string' | 'number' | 'boolean' | 'strings' | 'media' | 'mediaList';

export interface DreamApiField {
  key: string;
  json?: string;
  kind: DreamApiFieldKind;
  required?: boolean;
  choices?: readonly string[];
  min?: number;
  max?: number;
  maxItems?: number;
  maxLength?: number;
  multipleOf?: number;
}

export interface DreamApiModel {
  id: string;
  label: string;
  kind: DreamApiKind;
  endpoint: string;
  note: string;
  fields: readonly DreamApiField[];
  constants?: Record<string, unknown>;
  shape?: 'outpaint' | 'lipsync' | 'lipsync2';
}

const prompt = (max = 4000): DreamApiField => ({ key: 'prompt', kind: 'string', required: true, maxLength: max });
const media = (key: string, json?: string, required = false): DreamApiField => ({ key, json, kind: 'media', required });
const mediaList = (key: string, json: string | undefined, maxItems: number, required = false): DreamApiField => ({
  key, json, kind: 'mediaList', maxItems, required,
});

const SEEDANCE_SHARED: DreamApiField[] = [
  mediaList('images', 'images', 9),
  media('imageUrl', 'imageUrl'),
  media('endImageUrl', 'endImageUrl'),
  { key: 'ratio', kind: 'string' },
  { key: 'seed', kind: 'number' },
  { key: 'generateAudio', kind: 'boolean' },
];

export const DREAMAPI_MODELS: readonly DreamApiModel[] = [
  {
    id: 'dreamvideo-3-text', label: 'DreamAPI · DreamVideo 3.0 文生视频', kind: 'video',
    endpoint: '/api/async/dreamvideo_3.0/text_to_video', note: '时长 3–15 秒，分辨率 480P/720P。',
    fields: [prompt(), { key: 'duration', kind: 'number', min: 3, max: 15 }, { key: 'resolution', kind: 'string', choices: ['480P', '720P'] }, { key: 'aspectRatio', kind: 'string', choices: ['auto', '9:16', '3:4', '1:1', '4:3', '16:9'] }, { key: 'seed', kind: 'number' }],
  },
  {
    id: 'dreamvideo-3-image', label: 'DreamAPI · DreamVideo 3.0 图生视频', kind: 'video',
    endpoint: '/api/async/dreamvideo_3.0/image_to_video', note: '1 张图为图生视频，2 张图为首尾帧。',
    fields: [prompt(), mediaList('images', 'images', 9, true), { key: 'duration', kind: 'number', min: 3, max: 15 }, { key: 'resolution', kind: 'string', choices: ['480P', '720P'] }, { key: 'aspectRatio', kind: 'string', choices: ['auto', '9:16', '3:4', '1:1', '4:3', '16:9'] }, { key: 'seed', kind: 'number' }],
  },
  {
    id: 'wan-2.1-text', label: 'DreamAPI · Wan2.1 文生视频', kind: 'video',
    endpoint: '/api/async/wan/text_to_video/2.1', note: '提示词最长 1500 字。',
    fields: [prompt(1500), { key: 'resolution', kind: 'string', choices: ['480p', '720p'] }],
  },
  {
    id: 'wan-2.1-image', label: 'DreamAPI · Wan2.1 图生视频', kind: 'video',
    endpoint: '/api/async/wan/image_to_video/2.1', note: '需要一张参考图。',
    fields: [prompt(1500), media('image', 'image', true), { key: 'resolution', kind: 'string', choices: ['480p', '720p'] }],
  },
  {
    id: 'wan-2.1-head-tail', label: 'DreamAPI · Wan2.1 首尾帧', kind: 'video',
    endpoint: '/api/async/wan/head_tail_to_video/2.1', note: '首帧和尾帧都必填。',
    fields: [prompt(1500), media('first', 'firstImage', true), media('last', 'lastImage', true)],
  },
  {
    id: 'seedance-2.5', label: 'DreamAPI · Seedance 2.5', kind: 'video',
    endpoint: '/api/async/seedance_2.5', note: '时长 4–30 秒。带参考视频时可指定 reference/edit/extend。',
    constants: { model: 'seedance-2.5' },
    fields: [prompt(1500), { key: 'resolution', kind: 'string', required: true, choices: ['480p', '720p', '1080p'] }, { key: 'duration', kind: 'number', required: true, min: 4, max: 30 }, ...SEEDANCE_SHARED, mediaList('videos', 'videos', 10), mediaList('audios', 'audios', 3), { key: 'omniReferenceTaskType', kind: 'string', choices: ['reference', 'edit', 'extend'] }],
  },
  {
    id: 'seedance-2.0', label: 'DreamAPI · Seedance 2.0', kind: 'video',
    endpoint: '/api/async/seedance_2.0', note: '时长 4–15 秒，分辨率可到 4k。',
    constants: { model: 'seedance-2.0' },
    fields: [prompt(1500), { key: 'resolution', kind: 'string', required: true, choices: ['480p', '720p', '1080p', '4k'] }, { key: 'duration', kind: 'number', required: true, min: 4, max: 15 }, ...SEEDANCE_SHARED, mediaList('videos', 'videos', 3), mediaList('audios', 'audios', 3)],
  },
  {
    id: 'seedance-2.0-mini', label: 'DreamAPI · Seedance 2.0 Mini', kind: 'video',
    endpoint: '/api/async/seedance_2.0', note: '时长 4–15 秒，分辨率只有 480p/720p。',
    constants: { model: 'seedance-2.0-mini' },
    fields: [prompt(1500), { key: 'resolution', kind: 'string', required: true, choices: ['480p', '720p'] }, { key: 'duration', kind: 'number', required: true, min: 4, max: 15 }, ...SEEDANCE_SHARED, mediaList('videos', 'videos', 3), mediaList('audios', 'audios', 3)],
  },
  {
    id: 'dreamimage-2', label: 'DreamAPI · DreamImage 2.0', kind: 'image',
    endpoint: '/api/async/dreamimage_2.0', note: '必须提供输入图和提示词。',
    fields: [prompt(), media('image', 'image', true)],
  },
  {
    id: 'flux-text', label: 'DreamAPI · Flux 文生图', kind: 'image',
    endpoint: '/api/async/flux_text2image', note: '宽高为 16 的倍数，最大 1600。',
    fields: [prompt(), { key: 'width', kind: 'number', min: 16, max: 1600, multipleOf: 16 }, { key: 'height', kind: 'number', min: 16, max: 1600, multipleOf: 16 }, { key: 'num', kind: 'number', min: 1, max: 10 }, { key: 'seed', kind: 'number' }],
  },
  {
    id: 'flux-image', label: 'DreamAPI · Flux 图生图', kind: 'image',
    endpoint: '/api/async/flux_image2image', note: '限 1 张参考图。',
    fields: [prompt(), media('image', 'imageUrl', true), { key: 'width', kind: 'number', min: 16, max: 1600, multipleOf: 16 }, { key: 'height', kind: 'number', min: 16, max: 1600, multipleOf: 16 }, { key: 'num', kind: 'number', min: 1, max: 10 }, { key: 'seed', kind: 'number' }],
  },
  {
    id: 'seedream', label: 'DreamAPI · Seedream', kind: 'image',
    endpoint: '/api/async/seedream', note: '用 seedreamModel 选择 4.0 / 4.5 / 5.0 Lite / 5.0 Pro。',
    fields: [{ key: 'seedreamModel', json: 'model', kind: 'string', choices: ['seedream-5.0-pro', 'seedream-5.0-lite', 'seedream-4.5', 'seedream-4.0'] }, prompt(), mediaList('images', 'image', 10), { key: 'size', kind: 'string' }, { key: 'seed', kind: 'number' }],
  },
  {
    id: 'nano-banana-2', label: 'DreamAPI · Nano Banana 2', kind: 'image',
    endpoint: '/api/async/google_gemini_image', note: '分辨率 512/1K/2K/4K。',
    constants: { model: 'gemini-3.1-flash-image-preview' },
    fields: [{ key: 'text', kind: 'string', required: true }, { key: 'imageSize', kind: 'string', choices: ['512', '1K', '2K', '4K'] }, { key: 'aspectRatio', kind: 'string' }, mediaList('images', 'images', 14)],
  },
  {
    id: 'nano-banana-pro', label: 'DreamAPI · Nano Banana Pro', kind: 'image',
    endpoint: '/api/async/google_gemini_image', note: '分辨率只有 1K/2K。',
    constants: { model: 'gemini-3-pro-image-preview' },
    fields: [{ key: 'text', kind: 'string', required: true }, { key: 'imageSize', kind: 'string', choices: ['1K', '2K'] }, { key: 'aspectRatio', kind: 'string' }, mediaList('images', 'images', 14)],
  },
  {
    id: 'gpt-image-2', label: 'DreamAPI · GPT Image 2', kind: 'image',
    endpoint: '/api/async/gpt_image', note: '参考图最多 4 张。',
    fields: [prompt(), { key: 'width', kind: 'number', min: 16, max: 3840, multipleOf: 16 }, { key: 'height', kind: 'number', min: 16, max: 3840, multipleOf: 16 }, { key: 'quality', kind: 'string', choices: ['low', 'medium', 'high'] }, { key: 'n', kind: 'number', min: 1, max: 10 }, mediaList('images', 'images', 4)],
  },
  {
    id: 'gpt-image-2.5-flare-text', label: 'DreamAPI · GPT Image 2.5 Flare 文生图', kind: 'image',
    endpoint: '/api/async/gpt_image_2.5/flare/text_to_image', note: '质量含 xhigh 与 max。',
    fields: [prompt(), { key: 'width', kind: 'number', min: 16, max: 3840, multipleOf: 16 }, { key: 'height', kind: 'number', min: 16, max: 3840, multipleOf: 16 }, { key: 'quality', kind: 'string', choices: ['low', 'medium', 'high', 'xhigh', 'max'] }, { key: 'n', kind: 'number', min: 1, max: 10 }],
  },
  {
    id: 'gpt-image-2.5-flare-image', label: 'DreamAPI · GPT Image 2.5 Flare 图生图', kind: 'image',
    endpoint: '/api/async/gpt_image_2.5/flare/image_to_image', note: '参考图 1–4 张。',
    fields: [prompt(), { key: 'width', kind: 'number', min: 16, max: 3840, multipleOf: 16 }, { key: 'height', kind: 'number', min: 16, max: 3840, multipleOf: 16 }, { key: 'quality', kind: 'string', choices: ['low', 'medium', 'high', 'xhigh', 'max'] }, { key: 'n', kind: 'number', min: 1, max: 10 }, mediaList('images', 'images', 4, true)],
  },
  {
    id: 'gpt-image-2.5-sunburst-text', label: 'DreamAPI · GPT Image 2.5 Sunburst 文生图', kind: 'image',
    endpoint: '/api/async/gpt_image_2.5/sunburst/text_to_image', note: '与 Flare 文生图同一套限制。',
    fields: [prompt(), { key: 'width', kind: 'number', min: 16, max: 3840, multipleOf: 16 }, { key: 'height', kind: 'number', min: 16, max: 3840, multipleOf: 16 }, { key: 'quality', kind: 'string', choices: ['low', 'medium', 'high', 'xhigh', 'max'] }, { key: 'n', kind: 'number', min: 1, max: 10 }],
  },
  {
    id: 'gpt-image-2.5-sunburst-image', label: 'DreamAPI · GPT Image 2.5 Sunburst 图生图', kind: 'image',
    endpoint: '/api/async/gpt_image_2.5/sunburst/image_to_image', note: '参考图 1–4 张。',
    fields: [prompt(), { key: 'width', kind: 'number', min: 16, max: 3840, multipleOf: 16 }, { key: 'height', kind: 'number', min: 16, max: 3840, multipleOf: 16 }, { key: 'quality', kind: 'string', choices: ['low', 'medium', 'high', 'xhigh', 'max'] }, { key: 'n', kind: 'number', min: 1, max: 10 }, mediaList('images', 'images', 4, true)],
  },
  {
    id: 'colorize', label: 'DreamAPI · 黑白上色', kind: 'image',
    endpoint: '/api/async/colorize', note: '一张含人脸的图片。',
    fields: [media('url', 'url', true)],
  },
  {
    id: 'enhance', label: 'DreamAPI · 图像增强', kind: 'image',
    endpoint: '/api/async/enhance', note: '一张输入图。',
    fields: [media('image', 'imageUrl', true)],
  },
  {
    id: 'outpainting', label: 'DreamAPI · 扩图', kind: 'image',
    endpoint: '/api/async/outpainting', note: '按像素向四周扩展。', shape: 'outpaint',
    fields: [media('url', 'url', true), { key: 'left', kind: 'number', min: 0 }, { key: 'right', kind: 'number', min: 0 }, { key: 'top', kind: 'number', min: 0 }, { key: 'bottom', kind: 'number', min: 0 }],
  },
  {
    id: 'swap-face', label: 'DreamAPI · 图片换脸', kind: 'image',
    endpoint: '/api/async/swap_face', note: '目标图加人脸图。',
    fields: [media('url', 'url', true), media('face', 'faceImgUrl', true)],
  },
  {
    id: 'remove-background', label: 'DreamAPI · 去背景', kind: 'image',
    endpoint: '/api/async/remove_background', note: '一张输入图。',
    fields: [media('url', 'url', true)],
  },
  {
    id: 'try-on', label: 'DreamAPI · 虚拟试衣', kind: 'image',
    endpoint: '/api/async/tryon_clothes', note: '模特图必填，上装、下装、连体衣至少一张。',
    fields: [media('modelImage', 'modelImage', true), media('upper', 'upperClothes'), media('lower', 'lowerClothes'), media('overall', 'overallClothes'), { key: 'prompt', kind: 'string' }, { key: 'enableShoes', kind: 'boolean' }, { key: 'width', kind: 'number', min: 1 }, { key: 'height', kind: 'number', min: 1 }],
  },
  {
    id: 'lipsync', label: 'DreamAPI · LipSync', kind: 'video',
    endpoint: '/api/async/lipsync', note: '原视频和驱动音频。', shape: 'lipsync',
    fields: [media('srcVideo', 'srcVideoUrl', true), media('audio', 'audioUrl', true), { key: 'videoWidth', kind: 'number', min: 0 }, { key: 'videoHeight', kind: 'number', min: 0 }, { key: 'videoEnhance', kind: 'boolean' }],
  },
  {
    id: 'lipsync-2', label: 'DreamAPI · LipSync 2.0', kind: 'video',
    endpoint: '/api/async/lipsync/2.0', note: '可另传干声音频。设置里的默认视频模型建议用这个。', shape: 'lipsync2',
    fields: [media('srcVideo', 'srcVideoUrl', true), media('audio', 'audioUrl', true), media('vocalAudio', 'vocalAudioUrl'), { key: 'videoWidth', kind: 'number', min: 0 }, { key: 'videoHeight', kind: 'number', min: 0 }, { key: 'videoEnhance', kind: 'number', min: 0, max: 1 }, { key: 'fps', kind: 'string' }],
  },
  {
    id: 'dreamavatar-3-fast', label: 'DreamAPI · DreamAvatar 3.0 Fast', kind: 'video',
    endpoint: '/api/async/dreamavatar/image_to_video/3.0fast', note: '人像、音频和提示词。音频请控制在 3 分钟内。',
    fields: [media('image', 'image', true), media('audio', 'audio', true), prompt(), { key: 'resolution', kind: 'string', choices: ['480p', '720p'] }],
  },
  {
    id: 'dreamact', label: 'DreamAPI · Dreamact', kind: 'video',
    endpoint: '/api/async/wan/dreamact/2.1', note: '驱动视频最长 1 分钟。',
    fields: [media('video', 'video', true), mediaList('images', 'images', 8, true), { key: 'seed', kind: 'number' }, { key: 'resolution', kind: 'string', choices: ['480P', '720P'] }, { key: 'taskMode', kind: 'string', choices: ['replace_body', 'pose2v'] }, { key: 'qualityMode', kind: 'string', choices: ['high', 'base'] }],
  },
  {
    id: 'video-translate-2', label: 'DreamAPI · 视频翻译 2.0', kind: 'video',
    endpoint: '/api/async/video_translate/2.0', note: '语言只允许 en、zh、es。',
    fields: [media('video', 'videoUrl', true), { key: 'sourceLanguage', kind: 'string', required: true, choices: ['en', 'zh', 'es'] }, { key: 'targetLanguage', kind: 'string', required: true, choices: ['en', 'zh', 'es'] }, { key: 'enableLipSync', kind: 'boolean' }],
  },
  {
    id: 'swap-face-video', label: 'DreamAPI · 视频换脸', kind: 'video',
    endpoint: '/api/async/swap_face_for_video', note: '原视频请控制在 5 分钟内。',
    fields: [media('srcVideo', 'srcVideoUrl', true), media('face', 'srcImgUrl', true)],
  },
  {
    id: 'video-matting', label: 'DreamAPI · 视频抠像', kind: 'video',
    endpoint: '/api/async/image_matting_process_video', note: '只接受 MP4。成片和 alpha 都会返回。',
    fields: [media('srcFile', 'srcFileUrl', true), { key: 'bitRate', kind: 'string' }, { key: 'removeColorSpill', kind: 'boolean' }],
  },
  {
    id: 'matting-composite', label: 'DreamAPI · 抠像合成', kind: 'video',
    endpoint: '/api/async/image_matting_composite_video', note: '背景类型为 color、image 或 video。',
    fields: [media('srcFile', 'srcFileUrl', true), media('alpha', 'mattingAlphaFileUrl', true), { key: 'backgroundType', kind: 'string', required: true, choices: ['color', 'image', 'video'] }, { key: 'backgroundColor', kind: 'string' }, media('backgroundUrl', 'backgroundUrl')],
  },
  {
    id: 'watermark-remover', label: 'DreamAPI · 去水印', kind: 'video',
    endpoint: '/api/async/video_watermark_remover', note: '视频最长 120 秒、最高 2K。',
    fields: [media('video', 'video', true), { key: 'prompt', kind: 'string' }, { key: 'seed', kind: 'number' }],
  },
  {
    id: 'video-enhance', label: 'DreamAPI · 视频增强', kind: 'video',
    endpoint: '/api/async/video_super_resolution', note: '一条原视频。',
    fields: [media('srcVideo', 'srcVideoUrl', true)],
  },
  {
    id: 'voice-clone', label: 'DreamAPI · 声音克隆', kind: 'voice',
    endpoint: '/api/async/voice_clone', note: '返回 cloneId，供克隆音色配音使用。',
    fields: [media('voiceUrl', 'voiceUrl', true)],
  },
  {
    id: 'tts-clone', label: 'DreamAPI · 克隆音色配音', kind: 'voice',
    endpoint: '/api/async/do_tts_clone', note: '需要已保存的 cloneId。',
    fields: [{ key: 'cloneId', kind: 'string', required: true }, { key: 'text', kind: 'string', required: true }, { key: 'lang', json: 'lan', kind: 'string', required: true }],
  },
  {
    id: 'tts-common', label: 'DreamAPI · 普通配音', kind: 'voice',
    endpoint: '/api/async/do_tts_common', note: '音色 audioId 来自 DreamAPI 音色列表。',
    fields: [{ key: 'audioId', kind: 'string', required: true }, { key: 'text', kind: 'string', required: true }, { key: 'lang', json: 'lan', kind: 'string', required: true }],
  },
  {
    id: 'tts-pro', label: 'DreamAPI · 高级配音', kind: 'voice',
    endpoint: '/api/async/do_tts_pro', note: '音色 audioId 来自 Pro 列表。',
    fields: [{ key: 'audioId', kind: 'string', required: true }, { key: 'text', kind: 'string', required: true }, { key: 'lang', json: 'lan', kind: 'string', required: true }],
  },
];

export const DREAMAPI_MODEL_IDS = DREAMAPI_MODELS.map((model) => model.id);

export function dreamApiModel(id: string | undefined): DreamApiModel | undefined {
  const trimmed = id?.trim();
  if (!trimmed) return undefined;
  return DREAMAPI_MODELS.find((model) => model.id === trimmed);
}

export function dreamApiModelsByKind(kind: DreamApiKind): DreamApiModel[] {
  return DREAMAPI_MODELS.filter((model) => model.kind === kind);
}

/** Copy catalog fields from a tool argument bag. Explicit `dreamapi` wins over top-level copies. */
export function dreamApiInputFromArgs(modelId: string | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const model = dreamApiModel(modelId);
  const nested = args.dreamapi;
  const bag: Record<string, unknown> = nested && typeof nested === 'object' ? { ...nested as Record<string, unknown> } : {};
  if (!model) return bag;
  for (const field of model.fields) {
    if (bag[field.key] === undefined && args[field.key] !== undefined) bag[field.key] = args[field.key];
  }
  return bag;
}

const SEEDREAM_LIMITS: Record<string, { min: number; max: number; tiers: ReadonlySet<string> }> = {
  'seedream-5.0-pro': { min: 921600, max: 4624220, tiers: new Set(['1K', '1.5K', '2K']) },
  'seedream-5.0-lite': { min: 3686400, max: 16777216, tiers: new Set(['2K', '3K', '4K']) },
  'seedream-4.5': { min: 3686400, max: 16777216, tiers: new Set(['2K', '4K']) },
  'seedream-4.0': { min: 921600, max: 16777216, tiers: new Set(['1K', '2K', '4K']) },
};

function seedreamSizeError(model: string, size: string): string | undefined {
  const limits = SEEDREAM_LIMITS[model];
  if (!limits) return `Unknown Seedream model: ${model}`;
  const normalized = size.trim().toUpperCase().replace(/ /g, '');
  if (limits.tiers.has(normalized)) return undefined;
  const parts = normalized.toLowerCase().replace('*', 'x').split('x');
  if (parts.length !== 2) return `Invalid size ${size} for ${model}`;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return `Invalid size ${size}`;
  }
  const total = width * height;
  if (total < limits.min || total > limits.max) return `size ${size} is outside ${model} pixel range`;
  if (width * 16 < height || height * 16 < width) return `size ${size} aspect ratio is outside 1:16 to 16:1`;
  return undefined;
}

export interface DreamApiCall {
  model: DreamApiModel;
  body: Record<string, unknown>;
}

function readField(field: DreamApiField, value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (field.kind === 'string' || field.kind === 'media') {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field.key} must be a non-empty string`);
    const text = value.trim();
    if (field.choices && !field.choices.includes(text)) throw new Error(`${field.key} must be one of ${field.choices.join(', ')}`);
    if (field.maxLength !== undefined && text.length > field.maxLength) throw new Error(`${field.key} must be at most ${field.maxLength} characters`);
    return text;
  }
  if (field.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field.key} must be a number`);
    if (field.min !== undefined && value < field.min) throw new Error(`${field.key} must be at least ${field.min}`);
    if (field.max !== undefined && value > field.max) throw new Error(`${field.key} must be at most ${field.max}`);
    if (field.multipleOf !== undefined && value % field.multipleOf !== 0) throw new Error(`${field.key} must be a multiple of ${field.multipleOf}`);
    return value;
  }
  if (field.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${field.key} must be a boolean`);
    return value;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field.key} must be an array of strings`);
  }
  const items = value.map((item) => item.trim());
  if (field.required && items.length === 0) throw new Error(`${field.key} is required`);
  if (field.maxItems !== undefined && items.length > field.maxItems) throw new Error(`${field.key} accepts at most ${field.maxItems} items`);
  return items;
}

function shapeBody(model: DreamApiModel, flat: Record<string, unknown>): Record<string, unknown> {
  if (model.shape === 'outpaint') {
    return {
      url: flat.url,
      outPaintSize: { left: flat.left ?? 0, right: flat.right ?? 0, top: flat.top ?? 0, bottom: flat.bottom ?? 0 },
    };
  }
  if (model.shape === 'lipsync' || model.shape === 'lipsync2') {
    const body: Record<string, unknown> = {
      srcVideoUrl: flat.srcVideoUrl,
      audioUrl: flat.audioUrl,
      videoParams: {
        video_width: flat.videoWidth ?? 0,
        video_height: flat.videoHeight ?? 0,
        video_enhance: model.shape === 'lipsync' ? flat.videoEnhance === true : (flat.videoEnhance ?? 1),
      },
    };
    if (flat.vocalAudioUrl) body.vocalAudioUrl = flat.vocalAudioUrl;
    if (flat.fps) body.fps = flat.fps;
    return body;
  }
  return flat;
}

/** Validate one catalog id and build the DreamAPI JSON body. Does not touch the network. */
export function buildDreamApiCall(modelId: string | undefined, input: Record<string, unknown>): DreamApiCall {
  const model = dreamApiModel(modelId);
  if (!model) throw new Error('Choose a DreamAPI model in Settings or specify dreamapiModel');
  const allowed = new Set(model.fields.map((field) => field.key));
  for (const key of Object.keys(input)) {
    if (input[key] !== undefined && !allowed.has(key)) throw new Error(`${key} is not supported by DreamAPI model ${model.id}`);
  }
  const flat: Record<string, unknown> = { ...model.constants };
  for (const field of model.fields) {
    const value = readField(field, input[field.key]);
    if (value === undefined) {
      if (field.required) throw new Error(`${field.key} is required for DreamAPI model ${model.id}`);
      continue;
    }
    flat[field.json ?? field.key] = value;
  }
  if (model.id === 'try-on' && !flat.upperClothes && !flat.lowerClothes && !flat.overallClothes) {
    throw new Error('try-on requires upper, lower, or overall');
  }
  if (flat.endImageUrl && !flat.imageUrl) throw new Error('endImageUrl requires imageUrl');
  if (typeof flat.size === 'string') {
    const seedream = String(flat.model ?? 'seedream-5.0-pro');
    const sizeError = seedreamSizeError(seedream, flat.size);
    if (sizeError) throw new Error(sizeError);
  }
  if (model.id === 'video-translate-2' && flat.sourceLanguage === flat.targetLanguage) {
    throw new Error('sourceLanguage and targetLanguage must differ');
  }
  return { model, body: shapeBody(model, flat) };
}
