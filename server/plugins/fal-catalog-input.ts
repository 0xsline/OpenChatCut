import {
  getFalModel,
  type FalModelDefinition,
} from '../../shared/fal-models.ts';

export interface FalCatalogInput {
  falModel: string;
  prompt: string;
  count?: number;
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
  firstFrame?: string;
  lastFrame?: string;
  generateAudio?: boolean;
}

export interface FalRequest {
  endpoint: string;
  input: Record<string, unknown>;
}

function requireModel(id: string, kind: 'image' | 'video'): FalModelDefinition {
  const model = getFalModel(id);
  if (!model) throw new Error(`Unknown Fal model: ${id || '(missing)'}`);
  if (model.kind !== kind) throw new Error(`${model.label} is not a Fal ${kind} model`);
  return model;
}

function requirePrompt(prompt: string): string {
  if (typeof prompt !== 'string') throw new Error('Fal generation requires a non-empty prompt');
  const value = prompt.trim();
  if (!value) throw new Error('Fal generation requires a non-empty prompt');
  return value;
}

function requireChoice(name: string, value: string, allowed?: readonly string[]): string {
  if (!allowed?.includes(value)) {
    throw new Error(`Fal model does not support ${name} ${value}; allowed: ${allowed?.join(', ') || 'none'}`);
  }
  return value;
}

function requireUrls(name: string, values: string[] | undefined): string[] {
  if (values !== undefined && !Array.isArray(values)) throw new Error(`${name} must be an array of uploaded URLs`);
  const urls = values ?? [];
  if (urls.some((url) => typeof url !== 'string' || !url.trim())) {
    throw new Error(`${name} must contain non-empty uploaded URLs`);
  }
  return urls;
}

function requireOptionalUrl(name: string, value: string | undefined): void {
  if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
    throw new Error(`${name} must be a non-empty uploaded URL`);
  }
}

function requireCount(model: FalModelDefinition, count: number | undefined): number {
  const value = count ?? model.defaults.count ?? 1;
  const limit = model.constraints.count;
  if (!Number.isInteger(value) || !limit || value < limit.min || value > limit.max) {
    throw new Error(`${model.label} supports at most ${limit?.max ?? 1} images per request`);
  }
  return value;
}

function imageSizePreset(aspectRatio: string, resolution: string): string {
  if (aspectRatio === 'auto') return 'auto';
  const suffix = resolution === '0.5K' && aspectRatio === '1:1' ? '' : '_hd';
  if (aspectRatio === '1:1') return `square${suffix}`;
  const presets: Record<string, string> = {
    '4:3': 'landscape_4_3', '3:4': 'portrait_4_3',
    '16:9': 'landscape_16_9', '9:16': 'portrait_16_9',
  };
  const preset = presets[aspectRatio];
  if (!preset) throw new Error(`Fal preset-based image models do not support aspect ratio ${aspectRatio}`);
  return preset;
}

function seedreamImageSize(aspectRatio: string, resolution: string): string | { width: number; height: number } {
  if (aspectRatio === 'auto') return `auto_${resolution}`;
  // Generic presets may resolve to 2K; use explicit dimensions for the chosen tier.
  // Non-square 1K sizes retain the ratio and satisfy Fal's 1024² minimum area.
  const sizes: Record<string, { width: number; height: number }> = resolution === '1K' ? {
    '1:1': { width: 1024, height: 1024 },
    '16:9': { width: 1408, height: 792 },
    '9:16': { width: 792, height: 1408 },
    '4:3': { width: 1216, height: 912 },
    '3:4': { width: 912, height: 1216 },
  } : {
    '1:1': { width: 2048, height: 2048 },
    '16:9': { width: 2048, height: 1152 },
    '9:16': { width: 1152, height: 2048 },
    '4:3': { width: 2048, height: 1536 },
    '3:4': { width: 1536, height: 2048 },
  };
  const size = sizes[aspectRatio];
  if (!size) throw new Error(`Seedream 5.0 Pro does not support aspect ratio ${aspectRatio} at ${resolution}`);
  return size;
}

function rejectVideoFields(body: FalCatalogInput): void {
  if (body.duration !== undefined || body.firstFrame || body.lastFrame || body.generateAudio !== undefined
    || body.videoUrls?.length || body.audioUrls?.length) {
    throw new Error('Fal image models do not accept video-generation fields');
  }
}

function validateReferenceLimits(model: FalModelDefinition, images: string[], videos: string[], audio: string[]): void {
  const { constraints } = model;
  if (images.length > (constraints.maxImageReferences ?? 0)) {
    throw new Error(`${model.label} supports at most ${constraints.maxImageReferences ?? 0} image references`);
  }
  if (videos.length > (constraints.maxVideoReferences ?? 0)) {
    throw new Error(`${model.label} supports at most ${constraints.maxVideoReferences ?? 0} video references`);
  }
  if (audio.length > (constraints.maxAudioReferences ?? 0)) {
    throw new Error(`${model.label} supports at most ${constraints.maxAudioReferences ?? 0} audio references`);
  }
  if (constraints.maxReferences !== undefined && images.length + videos.length + audio.length > constraints.maxReferences) {
    throw new Error(`${model.label} supports at most ${constraints.maxReferences} reference files in total`);
  }
}

export function buildFalCatalogImageRequest(body: FalCatalogInput): FalRequest {
  const model = requireModel(body.falModel, 'image');
  const prompt = requirePrompt(body.prompt);
  rejectVideoFields(body);
  const imageUrls = requireUrls('imageUrls', body.imageUrls);
  if (imageUrls.length && !model.endpoints.edit) throw new Error(`${model.label} does not support reference images`);
  validateReferenceLimits(model, imageUrls, [], []);
  const count = requireCount(model, body.count);
  const aspectRatio = requireChoice('aspect ratio', body.aspectRatio ?? model.defaults.aspectRatio ?? '1:1', model.constraints.aspectRatios);
  const resolution = requireChoice('resolution', body.resolution ?? model.defaults.resolution ?? '1K', model.constraints.resolutions);
  const endpoint = imageUrls.length ? model.endpoints.edit! : model.endpoints.text;

  if (model.id === 'nano-banana-2' || model.id === 'nano-banana-pro') {
    return {
      endpoint,
      input: {
        prompt, num_images: count, aspect_ratio: aspectRatio, resolution,
        output_format: 'png',
        ...(model.id === 'nano-banana-2' ? { limit_generations: true } : {}),
        ...(imageUrls.length ? { image_urls: imageUrls } : {}),
      },
    };
  }

  if (model.id === 'seedream-5-pro') {
    const imageSize = seedreamImageSize(aspectRatio, resolution);
    return {
      endpoint,
      input: {
        prompt, image_size: imageSize, num_images: count, output_format: 'png',
        ...(imageUrls.length ? { image_urls: imageUrls } : {}),
      },
    };
  }

  const imageSize = imageSizePreset(aspectRatio, resolution);
  if (model.id === 'gpt-image-2') {
    return {
      endpoint,
      input: { prompt, image_size: imageSize, quality: 'high', num_images: count, output_format: 'png', ...(imageUrls.length ? { image_urls: imageUrls } : {}) },
    };
  }
  if (model.id === 'flux-2') {
    return { endpoint, input: { prompt, image_size: imageSize, num_images: count, output_format: 'png' } };
  }
  if (model.id === 'flux-2-pro') {
    return { endpoint, input: { prompt, image_size: imageSize, output_format: 'png', ...(imageUrls.length ? { image_urls: imageUrls } : {}) } };
  }
  if (model.id === 'ideogram-4') {
    return { endpoint, input: { prompt, image_size: imageSize, num_images: count, output_format: 'png' } };
  }
  if (model.id === 'qwen-image-3') {
    return { endpoint, input: { prompt, image_size: imageSize, num_images: count, output_format: 'png' } };
  }
  if (model.id === 'recraft-v3') {
    return {
      endpoint,
      input: { prompt, image_size: imageSize, style: 'realistic_image', ...(imageUrls.length ? { image_url: imageUrls[0] } : {}) },
    };
  }
  throw new Error(`Fal image adapter is missing for ${model.id}`);
}

function resolveVideoOptions(model: FalModelDefinition, body: FalCatalogInput): {
  prompt: string; duration: number; resolution: string; aspectRatio: string;
  imageUrls: string[]; videoUrls: string[]; audioUrls: string[]; generateAudio: boolean | undefined;
} {
  if (body.count !== undefined) throw new Error('Fal video models do not accept an image count');
  const prompt = requirePrompt(body.prompt);
  const duration = body.duration ?? model.defaults.duration ?? 5;
  if (!Number.isInteger(duration) || !model.constraints.durations?.includes(duration)) {
    throw new Error(`${model.label} does not support duration ${duration}s; allowed: ${model.constraints.durations?.join(', ')}`);
  }
  const resolution = requireChoice('resolution', body.resolution ?? model.defaults.resolution ?? '720p', model.constraints.resolutions);
  const aspectRatio = requireChoice('aspect ratio', body.aspectRatio ?? model.defaults.aspectRatio ?? '16:9', model.constraints.aspectRatios);
  const imageUrls = requireUrls('imageUrls', body.imageUrls);
  const videoUrls = requireUrls('videoUrls', body.videoUrls);
  const audioUrls = requireUrls('audioUrls', body.audioUrls);
  requireOptionalUrl('firstFrame', body.firstFrame);
  requireOptionalUrl('lastFrame', body.lastFrame);
  validateReferenceLimits(model, imageUrls, videoUrls, audioUrls);
  if (body.firstFrame && (imageUrls.length || videoUrls.length || audioUrls.length)) {
    throw new Error(`${model.label} cannot combine a first frame with reference inputs`);
  }
  if (body.lastFrame && !body.firstFrame) throw new Error(`${model.label} requires a first frame when a last frame is provided`);
  if (body.firstFrame && !model.constraints.supportsFirstFrame) throw new Error(`${model.label} does not support a first frame`);
  if (body.lastFrame && !model.constraints.supportsLastFrame) throw new Error(`${model.label} does not support a last frame`);
  if ((videoUrls.length || audioUrls.length || imageUrls.length) && !model.endpoints.reference) {
    throw new Error(`${model.label} does not support these reference inputs`);
  }
  if (audioUrls.length && !imageUrls.length && !videoUrls.length && model.id === 'minimax-h3-max') {
    throw new Error('MiniMax H3 Max audio references require an image or video reference');
  }
  if (body.generateAudio !== undefined && typeof body.generateAudio !== 'boolean') {
    throw new Error('generateAudio must be a boolean');
  }
  const generateAudio = body.generateAudio ?? model.defaults.generateAudio;
  if (generateAudio !== undefined && !model.constraints.supportsAudio) {
    throw new Error(`${model.label} does not expose audio generation control`);
  }
  return { prompt, duration, resolution, aspectRatio, imageUrls, videoUrls, audioUrls, generateAudio };
}

export function buildFalCatalogVideoRequest(body: FalCatalogInput): FalRequest {
  const model = requireModel(body.falModel, 'video');
  const options = resolveVideoOptions(model, body);
  const { prompt, duration, resolution, aspectRatio, imageUrls, videoUrls, audioUrls, generateAudio } = options;
  const hasReferences = Boolean(imageUrls.length || videoUrls.length || audioUrls.length);
  const endpoint = hasReferences
    ? model.endpoints.reference!
    : body.firstFrame
      ? model.endpoints.image!
      : model.endpoints.text;

  if (model.id === 'seedance-2.5' || model.id === 'seedance-2.0') {
    return {
      endpoint,
      input: {
        prompt, duration: String(duration), resolution, aspect_ratio: aspectRatio,
        generate_audio: generateAudio,
        ...(body.firstFrame ? { image_url: body.firstFrame } : {}),
        ...(body.lastFrame ? { end_image_url: body.lastFrame } : {}),
        ...(imageUrls.length ? { image_urls: imageUrls } : {}),
        ...(videoUrls.length ? { video_urls: videoUrls } : {}),
        ...(audioUrls.length ? { audio_urls: audioUrls } : {}),
      },
    };
  }

  if (model.id.startsWith('kling-v3-')) {
    return {
      endpoint,
      input: {
        prompt, duration: String(duration), generate_audio: generateAudio,
        ...(!body.firstFrame ? { aspect_ratio: aspectRatio } : {}),
        ...(body.firstFrame ? { start_image_url: body.firstFrame } : {}),
        ...(body.lastFrame ? { end_image_url: body.lastFrame } : {}),
      },
    };
  }
  if (model.id.startsWith('kling-o3-')) {
    return {
      endpoint,
      input: {
        prompt, duration: String(duration), aspect_ratio: aspectRatio, generate_audio: generateAudio,
        ...(imageUrls.length ? { image_urls: imageUrls } : {}),
      },
    };
  }
  if (model.id === 'veo-3.1' || model.id === 'veo-3.1-fast') {
    const veoAspectRatio = body.firstFrame && body.aspectRatio === undefined ? 'auto' : aspectRatio;
    return {
      endpoint,
      input: {
        prompt, duration: `${duration}s`, resolution, aspect_ratio: veoAspectRatio, generate_audio: generateAudio,
        ...(body.firstFrame ? { image_url: body.firstFrame } : {}),
      },
    };
  }
  if (model.id === 'wan-3.0') {
    return {
      endpoint,
      input: {
        prompt, duration, resolution, aspect_ratio: aspectRatio, audio: generateAudio,
        ...(body.firstFrame ? { start_image_url: body.firstFrame } : {}),
        ...(body.lastFrame ? { end_image_url: body.lastFrame } : {}),
      },
    };
  }
  if (model.id === 'minimax-h3-max') {
    return {
      endpoint,
      input: {
        prompt, duration, resolution: resolution.toUpperCase(), aspect_ratio: aspectRatio,
        prompt_expansion_mode: 'balanced',
        ...(imageUrls.length ? { reference_image_urls: imageUrls } : {}),
        ...(videoUrls.length ? { reference_video_urls: videoUrls } : {}),
        ...(audioUrls.length ? { reference_audio_urls: audioUrls } : {}),
      },
    };
  }
  if (model.id === 'pixverse-v6') {
    return {
      endpoint,
      input: {
        prompt, duration, resolution,
        ...(!body.firstFrame ? { aspect_ratio: aspectRatio } : {}),
        ...(generateAudio !== undefined ? { generate_audio_switch: generateAudio } : {}),
        ...(body.firstFrame ? { image_url: body.firstFrame } : {}),
      },
    };
  }
  throw new Error(`Fal video adapter is missing for ${model.id}`);
}
