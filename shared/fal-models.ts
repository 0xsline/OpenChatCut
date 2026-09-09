export type FalModelKind = 'image' | 'video';

export interface FalModelEndpoints {
  text: string;
  edit?: string;
  image?: string;
  reference?: string;
}

export interface FalModelConstraints {
  count?: { min: number; max: number };
  aspectRatios?: readonly string[];
  resolutions?: readonly string[];
  durations?: readonly number[];
  maxImageReferences?: number;
  maxVideoReferences?: number;
  maxAudioReferences?: number;
  maxReferences?: number;
  supportsFirstFrame?: boolean;
  supportsLastFrame?: boolean;
  supportsAudio?: boolean;
}

export interface FalModelDefaults {
  count?: number;
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  generateAudio?: boolean;
}

export interface FalModelDefinition {
  id: string;
  label: string;
  kind: FalModelKind;
  description: string;
  docsUrl: string;
  endpoints: FalModelEndpoints;
  constraints: FalModelConstraints;
  defaults: FalModelDefaults;
}

const COMMON_IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
const COMMON_VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;
const KLING_DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
const SEEDANCE_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] as const;
const H3_DURATIONS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
const PIXVERSE_DURATIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

// Curated rather than scraped: every endpoint and exposed field below is checked
// against the linked official fal schema. Updating the catalog is an explicit,
// reviewable change, so a renamed vendor endpoint cannot receive FAL_KEY by accident.
export const FAL_IMAGE_MODELS = [
  {
    id: 'nano-banana-2', label: 'Nano Banana 2', kind: 'image',
    description: 'Fast Google image generation and multi-image editing, up to 4K.',
    docsUrl: 'https://fal.ai/models/fal-ai/nano-banana-2/api',
    endpoints: { text: 'fal-ai/nano-banana-2', edit: 'fal-ai/nano-banana-2/edit' },
    constraints: {
      count: { min: 1, max: 4 },
      aspectRatios: ['auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4', '8:1', '1:8'],
      resolutions: ['0.5K', '1K', '2K', '4K'], maxImageReferences: 14,
    },
    defaults: { count: 1, aspectRatio: 'auto', resolution: '1K' },
  },
  {
    id: 'nano-banana-pro', label: 'Nano Banana Pro', kind: 'image',
    description: 'High-quality Google image generation and multi-image editing.',
    docsUrl: 'https://fal.ai/docs/model-api-reference/image-generation-api/nano-banana-pro',
    endpoints: { text: 'fal-ai/nano-banana-pro', edit: 'fal-ai/nano-banana-pro/edit' },
    constraints: {
      count: { min: 1, max: 4 },
      aspectRatios: ['auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'],
      resolutions: ['1K', '2K', '4K'], maxImageReferences: 14,
    },
    defaults: { count: 1, aspectRatio: 'auto', resolution: '1K' },
  },
  {
    id: 'gpt-image-2', label: 'GPT Image 2', kind: 'image',
    description: 'OpenAI image generation with strong typography and reference editing.',
    docsUrl: 'https://fal.ai/models/openai/gpt-image-2/api',
    endpoints: { text: 'openai/gpt-image-2', edit: 'openai/gpt-image-2/edit' },
    constraints: { count: { min: 1, max: 4 }, aspectRatios: ['auto', ...COMMON_IMAGE_RATIOS], resolutions: ['1K'], maxImageReferences: 16 },
    defaults: { count: 1, aspectRatio: '4:3', resolution: '1K' },
  },
  {
    id: 'flux-2', label: 'FLUX.2', kind: 'image',
    description: 'Open-weight FLUX.2 generation with crisp text and strong realism.',
    docsUrl: 'https://fal.ai/models/fal-ai/flux-2/api',
    endpoints: { text: 'fal-ai/flux-2' },
    constraints: { count: { min: 1, max: 4 }, aspectRatios: COMMON_IMAGE_RATIOS, resolutions: ['1K'] },
    defaults: { count: 1, aspectRatio: '4:3', resolution: '1K' },
  },
  {
    id: 'flux-2-pro', label: 'FLUX.2 Pro', kind: 'image',
    description: 'Hosted FLUX.2 Pro generation and reference editing.',
    docsUrl: 'https://fal.ai/models/fal-ai/flux-2-pro/api',
    endpoints: { text: 'fal-ai/flux-2-pro', edit: 'fal-ai/flux-2-pro/edit' },
    constraints: { count: { min: 1, max: 1 }, aspectRatios: COMMON_IMAGE_RATIOS, resolutions: ['1K'], maxImageReferences: 4 },
    defaults: { count: 1, aspectRatio: '4:3', resolution: '1K' },
  },
  {
    id: 'seedream-5-pro', label: 'Seedream 5.0 Pro', kind: 'image',
    description: 'ByteDance flagship image generation and precise multi-image editing.',
    docsUrl: 'https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image/api',
    endpoints: { text: 'bytedance/seedream/v5/pro/text-to-image', edit: 'bytedance/seedream/v5/pro/edit' },
    constraints: { count: { min: 1, max: 1 }, aspectRatios: ['auto', ...COMMON_IMAGE_RATIOS], resolutions: ['1K', '2K'], maxImageReferences: 10 },
    defaults: { count: 1, aspectRatio: 'auto', resolution: '2K' },
  },
  {
    id: 'ideogram-4', label: 'Ideogram 4', kind: 'image',
    description: 'Latest Ideogram generation for posters, logos, and accurate text.',
    docsUrl: 'https://fal.ai/models/ideogram/v4/api',
    endpoints: { text: 'ideogram/v4' },
    constraints: { count: { min: 1, max: 4 }, aspectRatios: COMMON_IMAGE_RATIOS, resolutions: ['1K'] },
    defaults: { count: 1, aspectRatio: '1:1', resolution: '1K' },
  },
  {
    id: 'qwen-image-3', label: 'Qwen Image 3', kind: 'image',
    description: 'Qwen generation with precise prompt following and complex text rendering.',
    docsUrl: 'https://fal.ai/models/alibaba/qwen-image-3/text-to-image/api',
    endpoints: { text: 'alibaba/qwen-image-3/text-to-image' },
    constraints: { count: { min: 1, max: 4 }, aspectRatios: COMMON_IMAGE_RATIOS, resolutions: ['1K'] },
    defaults: { count: 1, aspectRatio: '1:1', resolution: '1K' },
  },
  {
    id: 'recraft-v3', label: 'Recraft V3', kind: 'image',
    description: 'Commercial image and vector-oriented generation with single-image editing.',
    docsUrl: 'https://fal.ai/models/fal-ai/recraft/v3/text-to-image/api',
    endpoints: { text: 'fal-ai/recraft/v3/text-to-image', edit: 'fal-ai/recraft/v3/image-to-image' },
    constraints: { count: { min: 1, max: 1 }, aspectRatios: COMMON_IMAGE_RATIOS, resolutions: ['1K'], maxImageReferences: 1 },
    defaults: { count: 1, aspectRatio: '1:1', resolution: '1K' },
  },
] as const satisfies readonly FalModelDefinition[];

export const FAL_VIDEO_MODELS = [
  {
    id: 'seedance-2.5', label: 'Seedance 2.5', kind: 'video',
    description: 'ByteDance multimodal video with native audio and clips up to 30 seconds.',
    docsUrl: 'https://fal.ai/models/bytedance/seedance-2.5/text-to-video/api',
    endpoints: {
      text: 'bytedance/seedance-2.5/text-to-video', image: 'bytedance/seedance-2.5/image-to-video',
      reference: 'bytedance/seedance-2.5/reference-to-video',
    },
    constraints: {
      aspectRatios: ['auto', ...COMMON_VIDEO_RATIOS], resolutions: ['480p', '720p'], durations: SEEDANCE_DURATIONS,
      maxImageReferences: 30, maxVideoReferences: 10, maxAudioReferences: 10, maxReferences: 50,
      supportsFirstFrame: true, supportsLastFrame: true, supportsAudio: true,
    },
    defaults: { aspectRatio: 'auto', resolution: '720p', duration: 5, generateAudio: true },
  },
  {
    id: 'seedance-2.0', label: 'Seedance 2.0', kind: 'video',
    description: 'Previous Seedance release with multimodal references and native audio.',
    docsUrl: 'https://fal.ai/models/bytedance/seedance-2.0/text-to-video/api',
    endpoints: {
      text: 'bytedance/seedance-2.0/text-to-video', image: 'bytedance/seedance-2.0/image-to-video',
      reference: 'bytedance/seedance-2.0/reference-to-video',
    },
    constraints: {
      aspectRatios: ['auto', ...COMMON_VIDEO_RATIOS], resolutions: ['480p', '720p', '1080p', '4k'],
      durations: KLING_DURATIONS.slice(1), maxImageReferences: 9, maxVideoReferences: 3,
      maxAudioReferences: 3, maxReferences: 12, supportsFirstFrame: true,
      supportsLastFrame: true, supportsAudio: true,
    },
    defaults: { aspectRatio: 'auto', resolution: '720p', duration: 5, generateAudio: true },
  },
  {
    id: 'kling-v3-standard', label: 'Kling 3.0 Standard', kind: 'video',
    description: 'Kling 3.0 at standard quality with native audio and first/last-frame control.',
    docsUrl: 'https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video/api',
    endpoints: { text: 'fal-ai/kling-video/v3/standard/text-to-video', image: 'fal-ai/kling-video/v3/standard/image-to-video' },
    constraints: { aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['720p'], durations: KLING_DURATIONS, supportsFirstFrame: true, supportsLastFrame: true, supportsAudio: true },
    defaults: { aspectRatio: '16:9', resolution: '720p', duration: 5, generateAudio: true },
  },
  {
    id: 'kling-v3-pro', label: 'Kling 3.0 Pro', kind: 'video',
    description: 'Kling 3.0 at pro quality with native audio and first/last-frame control.',
    docsUrl: 'https://fal.ai/models/fal-ai/kling-video/v3/pro/text-to-video/api',
    endpoints: { text: 'fal-ai/kling-video/v3/pro/text-to-video', image: 'fal-ai/kling-video/v3/pro/image-to-video' },
    constraints: { aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['1080p'], durations: KLING_DURATIONS, supportsFirstFrame: true, supportsLastFrame: true, supportsAudio: true },
    defaults: { aspectRatio: '16:9', resolution: '1080p', duration: 5, generateAudio: true },
  },
  {
    id: 'kling-o3-standard', label: 'Kling O3 Standard', kind: 'video',
    description: 'Kling O3 generation with multi-image reference consistency.',
    docsUrl: 'https://fal.ai/models/fal-ai/kling-video/o3/standard/reference-to-video/api',
    endpoints: { text: 'fal-ai/kling-video/o3/standard/text-to-video', reference: 'fal-ai/kling-video/o3/standard/reference-to-video' },
    constraints: { aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['720p'], durations: KLING_DURATIONS, maxImageReferences: 4, maxReferences: 4, supportsAudio: true },
    defaults: { aspectRatio: '16:9', resolution: '720p', duration: 5, generateAudio: true },
  },
  {
    id: 'kling-o3-pro', label: 'Kling O3 Pro', kind: 'video',
    description: 'Kling O3 pro-quality generation with multi-image reference consistency.',
    docsUrl: 'https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video/api',
    endpoints: { text: 'fal-ai/kling-video/o3/pro/text-to-video', reference: 'fal-ai/kling-video/o3/pro/reference-to-video' },
    constraints: { aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['1080p'], durations: KLING_DURATIONS, maxImageReferences: 4, maxReferences: 4, supportsAudio: true },
    defaults: { aspectRatio: '16:9', resolution: '1080p', duration: 5, generateAudio: true },
  },
  {
    id: 'veo-3.1', label: 'Veo 3.1', kind: 'video',
    description: 'Google Veo video generation with native audio and image animation.',
    docsUrl: 'https://fal.ai/models/fal-ai/veo3.1/api',
    endpoints: { text: 'fal-ai/veo3.1', image: 'fal-ai/veo3.1/image-to-video' },
    constraints: { aspectRatios: ['16:9', '9:16'], resolutions: ['720p', '1080p', '4k'], durations: [4, 6, 8], supportsFirstFrame: true, supportsAudio: true },
    defaults: { aspectRatio: '16:9', resolution: '720p', duration: 8, generateAudio: true },
  },
  {
    id: 'veo-3.1-fast', label: 'Veo 3.1 Fast', kind: 'video',
    description: 'Faster Veo 3.1 generation and image animation with native audio.',
    docsUrl: 'https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video/api',
    endpoints: { text: 'fal-ai/veo3.1/fast', image: 'fal-ai/veo3.1/fast/image-to-video' },
    constraints: { aspectRatios: ['16:9', '9:16'], resolutions: ['720p', '1080p', '4k'], durations: [4, 6, 8], supportsFirstFrame: true, supportsAudio: true },
    defaults: { aspectRatio: '16:9', resolution: '720p', duration: 8, generateAudio: true },
  },
  {
    id: 'wan-3.0', label: 'Wan 3.0', kind: 'video',
    description: 'Alibaba Wan 3.0 text and first/last-frame video with generated audio.',
    docsUrl: 'https://fal.ai/models/alibaba/wan-3.0/text-to-video/api',
    endpoints: { text: 'alibaba/wan-3.0/text-to-video', image: 'alibaba/wan-3.0/image-to-video' },
    constraints: { aspectRatios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'], resolutions: ['480p', '720p', '1080p'], durations: [5, 10], supportsFirstFrame: true, supportsLastFrame: true, supportsAudio: true },
    defaults: { aspectRatio: 'adaptive', resolution: '1080p', duration: 5, generateAudio: true },
  },
  {
    id: 'minimax-h3-max', label: 'MiniMax H3 Max', kind: 'video',
    description: 'Fast MiniMax H3 variant with multimodal reference generation.',
    docsUrl: 'https://fal.ai/models/minimax/h3-max/text-to-video/api',
    endpoints: { text: 'minimax/h3-max/text-to-video', reference: 'minimax/h3-max/reference-to-video' },
    constraints: { aspectRatios: ['adaptive', ...COMMON_VIDEO_RATIOS], resolutions: ['480p', '768p', '1080p'], durations: H3_DURATIONS, maxImageReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3, maxReferences: 12 },
    defaults: { aspectRatio: '16:9', resolution: '768p', duration: 5 },
  },
  {
    id: 'pixverse-v6', label: 'PixVerse V6', kind: 'video',
    description: 'PixVerse V6 text and image animation with flexible duration and resolution.',
    docsUrl: 'https://fal.ai/models/fal-ai/pixverse/v6/text-to-video/api',
    endpoints: { text: 'fal-ai/pixverse/v6/text-to-video', image: 'fal-ai/pixverse/v6/image-to-video' },
    constraints: { aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '2:3', '3:2', '21:9'], resolutions: ['360p', '540p', '720p', '1080p'], durations: PIXVERSE_DURATIONS, supportsFirstFrame: true, supportsAudio: true },
    defaults: { aspectRatio: '16:9', resolution: '720p', duration: 5, generateAudio: false },
  },
] as const satisfies readonly FalModelDefinition[];

export const FAL_MODELS = [...FAL_IMAGE_MODELS, ...FAL_VIDEO_MODELS] as const;
export type FalImageModelId = typeof FAL_IMAGE_MODELS[number]['id'];
export type FalVideoModelId = typeof FAL_VIDEO_MODELS[number]['id'];
export type FalModelId = FalImageModelId | FalVideoModelId;

export const DEFAULT_FAL_IMAGE_MODEL_ID: FalImageModelId = 'nano-banana-2';
export const DEFAULT_FAL_VIDEO_MODEL_ID: FalVideoModelId = 'seedance-2.5';

export function getFalModel(id: string): FalModelDefinition | undefined {
  return FAL_MODELS.find((model) => model.id === id);
}

export function isFalImageModelId(id: string): id is FalImageModelId {
  return FAL_IMAGE_MODELS.some((model) => model.id === id);
}

export function isFalVideoModelId(id: string): id is FalVideoModelId {
  return FAL_VIDEO_MODELS.some((model) => model.id === id);
}

const FAL_ENDPOINTS = new Set<string>(FAL_MODELS.flatMap((model) => Object.values(model.endpoints)));

export function isFalEndpoint(endpoint: string): boolean {
  return FAL_ENDPOINTS.has(endpoint);
}

export function falModelSummary(modelOrId: FalModelDefinition | string): string {
  const model = typeof modelOrId === 'string' ? getFalModel(modelOrId) : modelOrId;
  if (!model) return `Unknown Fal model (${String(modelOrId)})`;
  const details: string[] = [];
  if (model.constraints.count) details.push(`count ${model.constraints.count.min}–${model.constraints.count.max}`);
  if (model.kind === 'video') details.push(model.constraints.supportsAudio ? 'audio toggle supported' : 'no audio toggle');
  if (model.constraints.resolutions?.length) details.push(`resolutions ${model.constraints.resolutions.join('/')}`);
  if (model.constraints.durations?.length) {
    const values = model.constraints.durations;
    const contiguous = values.every((value, index) => index === 0 || value === values[index - 1] + 1);
    details.push(contiguous ? `durations ${values[0]}–${values[values.length - 1]}s` : `durations ${values.join('/')}s`);
  }
  if (model.constraints.maxImageReferences) details.push(`up to ${model.constraints.maxImageReferences} image refs`);
  if (model.constraints.maxVideoReferences) details.push(`up to ${model.constraints.maxVideoReferences} video refs`);
  if (model.constraints.maxAudioReferences) details.push(`up to ${model.constraints.maxAudioReferences} audio refs`);
  const modes = [
    model.constraints.supportsFirstFrame ? 'first frame' : '',
    model.constraints.supportsLastFrame ? 'last frame' : '',
    model.endpoints.reference ? 'reference mode' : '',
    model.endpoints.edit ? 'image editing' : '',
  ].filter(Boolean);
  if (modes.length) details.push(modes.join('/'));
  const defaults: string[] = [];
  if (model.defaults.resolution) defaults.push(model.defaults.resolution);
  if (model.defaults.duration) defaults.push(`${model.defaults.duration}s`);
  if (model.defaults.aspectRatio) defaults.push(model.defaults.aspectRatio);
  if (defaults.length) details.push(`default ${defaults.join('/')}`);
  return `${model.label}${details.length ? ` — ${details.join(', ')}` : ''}`;
}
