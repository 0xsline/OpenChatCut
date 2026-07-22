export interface MultiPrompt { prompt: string; duration: number | string; index: number }
export type VideoResolution = '480p' | '512p' | '720p' | '1080p' | '4k';
export type KlingVideoReferType = 'feature' | 'base';

export interface VideoRequest {
  model?: 'seedance2' | 'kling' | 'hailuo';
  prompt?: string;
  name?: string;
  durationSeconds?: number | string;
  ratio?: string;
  resolution?: VideoResolution;
  mode?: 'std' | 'pro';
  firstFramePath?: string;
  lastFramePath?: string;
  refImagePaths?: string[];
  refVideoPaths?: string[];
  refAudioPaths?: string[];
  refVideoMode?: KlingVideoReferType;
  promptOptimizer?: boolean;
  fastPretreatment?: boolean;
  generateAudio?: boolean;
  seed?: number;
  cameraFixed?: boolean;
  watermark?: boolean;
  returnLastFrame?: boolean;
  executionExpiresAfter?: number;
  priority?: number;
  multiPrompts?: MultiPrompt[];
  shotType?: 'customize' | 'intelligence';
}

export interface ValidVideoRequest extends Omit<VideoRequest, 'model' | 'prompt' | 'durationSeconds' | 'ratio' | 'refImagePaths' | 'refVideoPaths' | 'refAudioPaths'> {
  model: 'seedance2' | 'kling' | 'hailuo';
  prompt: string;
  durationSeconds: number;
  durationSpecified: boolean;
  ratio: string;
  refImagePaths: string[];
  refVideoPaths: string[];
  refAudioPaths: string[];
}

export function videoSeconds(value: number | string | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value.trim().replace(/s$/i, '')) : value ?? fallback;
  if (!Number.isInteger(parsed)) throw new Error('durationSeconds must be an integer');
  return parsed;
}

export function hailuoApiResolution(resolution?: VideoResolution): '512P' | '768P' | '1080P' {
  if (resolution === '512p') return '512P';
  return resolution === '1080p' ? '1080P' : '768P';
}

export function seedanceApiResolution(resolution?: VideoResolution): '480p' | '720p' | '1080p' | '4k' {
  if (resolution === '480p' || resolution === '1080p' || resolution === '4k') return resolution;
  return '720p';
}

const SEEDANCE_KEYS = ['generateAudio', 'seed', 'cameraFixed', 'watermark', 'returnLastFrame', 'executionExpiresAfter', 'priority'] as const;

function rejectSeedanceOptions(input: VideoRequest): void {
  if (SEEDANCE_KEYS.some((key) => input[key] !== undefined)) {
    throw new Error('generateAudio/seed/cameraFixed/watermark/returnLastFrame/executionExpiresAfter/priority are supported by seedance2 only');
  }
}

function validateSeedanceOptions(input: VideoRequest): void {
  for (const key of ['generateAudio', 'cameraFixed', 'watermark', 'returnLastFrame'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  }
  if (input.seed !== undefined && !Number.isSafeInteger(input.seed)) throw new Error('seed must be a safe integer');
  if (input.executionExpiresAfter !== undefined
    && (!Number.isInteger(input.executionExpiresAfter) || input.executionExpiresAfter < 3600 || input.executionExpiresAfter > 259200)) {
    throw new Error('executionExpiresAfter must be an integer from 3600 to 259200');
  }
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 9)) {
    throw new Error('priority must be an integer from 0 to 9');
  }
}

function common(input: VideoRequest, model: ValidVideoRequest['model']): ValidVideoRequest {
  return {
    ...input, model, prompt: String(input.prompt ?? '').trim(), ratio: String(input.ratio ?? '16:9'),
    durationSeconds: videoSeconds(input.durationSeconds, model === 'hailuo' ? 6 : 5),
    durationSpecified: input.durationSeconds !== undefined,
    refImagePaths: input.refImagePaths ?? [], refVideoPaths: input.refVideoPaths ?? [], refAudioPaths: input.refAudioPaths ?? [],
  };
}

function validateHailuo(input: ValidVideoRequest): ValidVideoRequest {
  if (!input.prompt || input.prompt.length > 2000) throw new Error('hailuo prompt is required and must be at most 2000 characters');
  if (input.durationSeconds !== 6 && input.durationSeconds !== 10) throw new Error('hailuo durationSeconds must be 6 or 10');
  if (input.lastFramePath && !input.firstFramePath) throw new Error('lastFrame requires firstFrame');
  if (input.refImagePaths.length || input.refVideoPaths.length || input.refAudioPaths.length) {
    throw new Error('hailuo does not support refImages/refVideos/refAudios; use firstFrame (and optional lastFrame) only');
  }
  if (input.mode || input.shotType || input.multiPrompts?.length) throw new Error('mode and multi-shot parameters are supported by kling only');
  if (input.resolution && !['512p', '720p', '1080p'].includes(input.resolution)) throw new Error('hailuo resolution must be 512p, 720p, or 1080p');
  if (input.resolution === '512p' && !input.firstFramePath) throw new Error('hailuo 512p is supported for image-to-video only');
  if (input.resolution === '512p' && input.lastFramePath) throw new Error('hailuo first-and-last-frame mode does not support 512p');
  if ((input.resolution ?? '720p') === '1080p' && input.durationSeconds === 10) throw new Error('hailuo 1080p only supports durationSeconds 6; use 720p for 10s or set durationSeconds to 6');
  if (input.refVideoMode) throw new Error('refVideoMode is supported by kling only');
  rejectSeedanceOptions(input);
  if (input.promptOptimizer !== undefined && typeof input.promptOptimizer !== 'boolean') throw new Error('promptOptimizer must be a boolean');
  if (input.fastPretreatment !== undefined && typeof input.fastPretreatment !== 'boolean') throw new Error('fastPretreatment must be a boolean');
  if (input.fastPretreatment === true && input.promptOptimizer === false) throw new Error('fastPretreatment requires promptOptimizer to be true (or omitted)');
  return input;
}

function validateSeedance(input: ValidVideoRequest): ValidVideoRequest {
  if (!input.prompt) throw new Error('prompt is required');
  if (input.durationSeconds < 2 || input.durationSeconds > 15) throw new Error('seedance2 durationSeconds must be between 2 and 15');
  if (!['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'].includes(input.ratio)) throw new Error(`seedance2 does not support ratio ${input.ratio}`);
  if (input.resolution && !['480p', '720p', '1080p', '4k'].includes(input.resolution)) throw new Error('seedance2 resolution must be 480p, 720p, 1080p, or 4k');
  if (input.lastFramePath && !input.firstFramePath) throw new Error('lastFrame requires firstFrame');
  if (input.lastFramePath && (input.refImagePaths.length || input.refVideoPaths.length || input.refAudioPaths.length)) throw new Error('seedance2 lastFrame mode cannot be combined with references');
  if (input.refImagePaths.length > 9 || input.refVideoPaths.length > 3 || input.refAudioPaths.length > 3) throw new Error('seedance2 reference limit exceeded');
  if (input.refAudioPaths.length && !input.firstFramePath && !input.refImagePaths.length && !input.refVideoPaths.length) throw new Error('seedance2 audio references require a visual reference');
  if (input.shotType || input.multiPrompts?.length) throw new Error('multi-shot parameters are supported by kling only');
  if (input.refVideoMode) throw new Error('refVideoMode is supported by kling only');
  if (input.promptOptimizer !== undefined || input.fastPretreatment !== undefined) throw new Error('promptOptimizer/fastPretreatment are supported by hailuo only');
  validateSeedanceOptions(input);
  return input;
}

function validateKlingShots(input: ValidVideoRequest): void {
  if (input.shotType !== 'customize') {
    if (input.multiPrompts?.length) throw new Error('kling multiPrompts require shotType=customize');
    if (!input.prompt) throw new Error('prompt is required');
    return;
  }
  if (input.prompt) throw new Error('omit prompt for kling customize; use multiPrompts');
  const shots = input.multiPrompts ?? [];
  if (shots.length < 2 || shots.length > 6) throw new Error('kling customize requires 2 to 6 multiPrompts');
  let total = 0;
  shots.forEach((shot, index) => {
    const duration = videoSeconds(shot.duration, 0);
    if (shot.index !== index + 1) throw new Error('kling multiPrompt indexes must be consecutive from 1');
    if (!shot.prompt?.trim() || shot.prompt.length > 512) throw new Error('each kling multiPrompt requires a prompt of at most 512 characters');
    if (duration < 1) throw new Error('each kling multiPrompt duration must be at least 1 second');
    total += duration;
  });
  if (total !== input.durationSeconds) throw new Error('kling multiPrompt durations must sum to durationSeconds');
}

function validateKling(input: ValidVideoRequest): ValidVideoRequest {
  if (input.durationSeconds < 3 || input.durationSeconds > 15) throw new Error('kling durationSeconds must be between 3 and 15');
  if (!['16:9', '9:16', '1:1'].includes(input.ratio)) throw new Error(`kling does not support ratio ${input.ratio}`);
  if (input.lastFramePath && !input.firstFramePath) throw new Error('lastFrame requires firstFrame');
  if (input.refAudioPaths.length) throw new Error('kling does not support refAudios');
  if (input.refVideoPaths.length > 1) throw new Error('kling accepts at most 1 reference video');
  if (input.refVideoMode && input.refVideoMode !== 'feature' && input.refVideoMode !== 'base') {
    throw new Error('kling refVideoMode must be feature or base');
  }
  if (input.refVideoMode && !input.refVideoPaths.length) throw new Error('refVideoMode requires refVideos');
  const imageCount = Number(Boolean(input.firstFramePath)) + Number(Boolean(input.lastFramePath)) + input.refImagePaths.length;
  const maxImages = input.refVideoPaths.length ? 4 : 7;
  if (imageCount > maxImages) throw new Error(input.refVideoPaths.length ? 'kling with refVideos accepts at most 4 images total (first/last/refImages)' : 'kling accepts at most 7 images');
  if (input.resolution && !['720p', '1080p'].includes(input.resolution)) throw new Error('kling resolution must be 720p or 1080p when set');
  if (input.mode && input.resolution && (input.mode === 'pro') !== (input.resolution === '1080p')) throw new Error('kling mode and resolution conflict');
  if (input.promptOptimizer !== undefined || input.fastPretreatment !== undefined) throw new Error('promptOptimizer/fastPretreatment are supported by hailuo only');
  rejectSeedanceOptions(input);
  validateKlingShots(input);
  if (input.prompt.length > 2500) throw new Error('kling prompt must be at most 2500 characters');
  return input;
}

export function validateVideoRequest(input: VideoRequest): ValidVideoRequest {
  if (input.model !== 'seedance2' && input.model !== 'kling' && input.model !== 'hailuo') throw new Error('model must be seedance2, kling, or hailuo');
  if (input.model === 'hailuo' && input.ratio !== undefined) throw new Error('hailuo does not accept ratio; framing follows the first frame when present');
  const normalized = common(input, input.model);
  if (normalized.model === 'hailuo') return validateHailuo(normalized);
  return normalized.model === 'seedance2' ? validateSeedance(normalized) : validateKling(normalized);
}
