import type { SubmitImageArgs } from '../../generate/image';
import type { SubmitMusicArgs } from '../../generate/music';
import type { SubmitSoundArgs } from '../../generate/sound';
import type { SubmitVideoArgs } from '../../generate/video';
import type { SubmitVoiceArgs } from '../../generate/voice';

export type GenerateArgs = Record<string, unknown>;
export const shouldAddImageToTimeline = (args: GenerateArgs): boolean => args.addToTimeline !== false;

const str = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};
const num = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined;
const bool = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;
const list = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(String).map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
};

export function buildSubmitImageArgs(args: GenerateArgs): SubmitImageArgs {
  const model = args.model as SubmitImageArgs['model'];
  const references = list(args.referenceAssetIds);
  const aspectRatio = args.aspectRatio as SubmitImageArgs['aspectRatio'];
  const width = aspectRatio === undefined ? num(args.width) : undefined;
  const height = aspectRatio === undefined ? num(args.height) : undefined;
  const shared: SubmitImageArgs = {
    model, prompt: String(args.prompt ?? ''), name: String(args.name ?? ''), aspectRatio,
    referenceAssetIds: references, count: num(args.count),
  };
  if (model === 'image-01') {
    return { ...shared, width, height, seed: num(args.seed), promptOptimizer: bool(args.promptOptimizer) };
  }
  if (model === 'nano-banana') return { ...shared, imageSize: args.imageSize as SubmitImageArgs['imageSize'] };
  const outputFormat = args.outputFormat as SubmitImageArgs['outputFormat'];
  return {
    ...shared, imageSize: args.imageSize as SubmitImageArgs['imageSize'], width, height,
    quality: args.quality as SubmitImageArgs['quality'], maskAssetId: str(args.maskAssetId),
    background: args.background as SubmitImageArgs['background'], moderation: args.moderation as SubmitImageArgs['moderation'],
    inputFidelity: references?.length ? args.inputFidelity as SubmitImageArgs['inputFidelity'] : undefined,
    outputFormat,
    outputCompression: (outputFormat === 'jpeg' || outputFormat === 'webp') ? num(args.outputCompression) : undefined,
  };
}

const voiceBase = (args: GenerateArgs, provider: SubmitVoiceArgs['provider']): SubmitVoiceArgs => ({
  provider, text: String(args.text ?? ''), voiceId: str(args.voiceId) ?? '', name: str(args.name),
});

function elevenVoice(args: GenerateArgs): SubmitVoiceArgs {
  const dictionaries = Array.isArray(args.pronunciationDictionaryLocators)
    ? args.pronunciationDictionaryLocators.filter((item) => item && typeof item === 'object') as SubmitVoiceArgs['pronunciationDictionaryLocators']
    : undefined;
  return {
    ...voiceBase(args, 'elevenlabs'), modelId: str(args.modelId), stability: num(args.stability), speed: num(args.speed),
    similarityBoost: num(args.similarityBoost), style: num(args.style), useSpeakerBoost: bool(args.useSpeakerBoost),
    languageCode: str(args.languageCode), seed: num(args.seed), outputFormat: str(args.outputFormat),
    optimizeStreamingLatency: num(args.optimizeStreamingLatency), enableLogging: bool(args.enableLogging),
    applyTextNormalization: args.applyTextNormalization as SubmitVoiceArgs['applyTextNormalization'],
    applyLanguageTextNormalization: bool(args.applyLanguageTextNormalization),
    pronunciationDictionaryLocators: dictionaries?.length ? dictionaries : undefined,
    previousText: str(args.previousText), nextText: str(args.nextText),
    previousRequestIds: list(args.previousRequestIds), nextRequestIds: list(args.nextRequestIds),
  };
}

const doubaoVoice = (args: GenerateArgs): SubmitVoiceArgs => ({
  ...voiceBase(args, 'doubao'), speedRatio: num(args.speedRatio), emotion: str(args.emotion),
  emotionScale: num(args.emotionScale), loudnessRatio: num(args.loudnessRatio), pitch: num(args.pitch),
  performancePrompt: str(args.performancePrompt), explicitDialect: args.explicitDialect as SubmitVoiceArgs['explicitDialect'],
});

function minimaxVoice(args: GenerateArgs): SubmitVoiceArgs {
  const stream = bool(args.stream);
  const audioFormat = args.audioFormat as SubmitVoiceArgs['audioFormat'];
  const subtitleEnable = bool(args.subtitleEnable);
  return {
    ...voiceBase(args, 'minimax'), speed: num(args.speed), emotion: str(args.emotion), pitch: num(args.pitch),
    volume: num(args.volume), sampleRate: num(args.sampleRate),
    bitrate: audioFormat === undefined || audioFormat === 'mp3' ? num(args.bitrate) : undefined,
    audioFormat, channel: args.channel === 1 || args.channel === 2 ? args.channel : undefined,
    forceCbr: stream === true && (audioFormat === undefined || audioFormat === 'mp3') ? bool(args.forceCbr) : undefined,
    stream, excludeAggregatedAudio: stream === true ? bool(args.excludeAggregatedAudio) : undefined,
    languageBoost: args.languageBoost as SubmitVoiceArgs['languageBoost'], textNormalization: bool(args.textNormalization),
    latexRead: bool(args.latexRead), pronunciations: list(args.pronunciations),
    timbreWeights: !str(args.voiceId) && Array.isArray(args.timbreWeights) && args.timbreWeights.length
      ? args.timbreWeights as SubmitVoiceArgs['timbreWeights'] : undefined,
    voiceModify: args.voiceModify && typeof args.voiceModify === 'object' ? args.voiceModify as SubmitVoiceArgs['voiceModify'] : undefined,
    subtitleEnable, subtitleType: subtitleEnable === true ? args.subtitleType as SubmitVoiceArgs['subtitleType'] : undefined,
  };
}

const VOICE_STRATEGIES = { elevenlabs: elevenVoice, doubao: doubaoVoice, minimax: minimaxVoice } as const;
export function buildSubmitVoiceArgs(args: GenerateArgs): SubmitVoiceArgs {
  const provider = args.provider === 'doubao' || args.provider === 'minimax' ? args.provider : 'elevenlabs';
  return VOICE_STRATEGIES[provider](args);
}

type MusicMode = NonNullable<SubmitMusicArgs['mode']>;
const musicBase = (args: GenerateArgs, provider: NonNullable<SubmitMusicArgs['provider']>, mode: MusicMode): SubmitMusicArgs => ({
  provider, mode, prompt: str(args.prompt), lyrics: str(args.lyrics),
  audioFormat: args.audioFormat as SubmitMusicArgs['audioFormat'], name: str(args.name),
});

function minimaxMusic(args: GenerateArgs): SubmitMusicArgs {
  const mode = args.mode === 'cover' ? 'cover' : 't2m';
  return {
    ...musicBase(args, 'minimax', mode), isInstrumental: mode === 't2m' ? bool(args.isInstrumental) : undefined,
    lyricsOptimizer: mode === 't2m' ? bool(args.lyricsOptimizer) : undefined,
    sampleRate: num(args.sampleRate), bitrate: num(args.bitrate),
    referenceAssetId: mode === 'cover' ? str(args.referenceAssetId) : undefined,
    coverFeatureId: mode === 'cover' ? str(args.coverFeatureId) : undefined,
  };
}

function murekaMusic(args: GenerateArgs): SubmitMusicArgs {
  const allowed = new Set<MusicMode>(['instrumental', 'song', 'prompt-song', 'soundtrack', 'track']);
  const mode = allowed.has(args.mode as MusicMode) ? args.mode as MusicMode : 'instrumental';
  const common = { ...musicBase(args, 'mureka', mode), count: num(args.count), stream: bool(args.stream) };
  if (mode === 'instrumental') return { ...common, instrumentalId: str(args.instrumentalId) };
  if (mode === 'song') return { ...common, gender: args.gender as SubmitMusicArgs['gender'], referenceId: str(args.referenceId), vocalId: str(args.vocalId), melodyId: str(args.melodyId) };
  if (mode === 'prompt-song') return { ...common, styles: list(args.styles) as SubmitMusicArgs['styles'], referenceId: str(args.referenceId), vocalId: str(args.vocalId) };
  if (mode === 'soundtrack') return { ...common, sourceAssetId: str(args.sourceAssetId), audioStartMs: num(args.audioStartMs), audioEndMs: num(args.audioEndMs) };
  return {
    ...common, sourceAssetId: str(args.sourceAssetId), songId: str(args.songId),
    trackType: args.trackType as SubmitMusicArgs['trackType'], generateStartMs: num(args.generateStartMs),
    generateEndMs: num(args.generateEndMs), vocalGender: args.vocalGender as SubmitMusicArgs['vocalGender'],
  };
}

const MUSIC_STRATEGIES = { mureka: murekaMusic, minimax: minimaxMusic } as const;
export function buildSubmitMusicArgs(args: GenerateArgs): SubmitMusicArgs {
  return MUSIC_STRATEGIES[args.provider === 'minimax' ? 'minimax' : 'mureka'](args);
}

const videoBase = (args: GenerateArgs, model: SubmitVideoArgs['model']): SubmitVideoArgs => ({
  model, prompt: str(args.prompt), name: str(args.name),
  durationSeconds: typeof args.durationSeconds === 'number' || typeof args.durationSeconds === 'string' ? args.durationSeconds : undefined,
  resolution: args.resolution as SubmitVideoArgs['resolution'], firstFrame: str(args.firstFrame), lastFrame: str(args.lastFrame),
});

const seedanceVideo = (args: GenerateArgs): SubmitVideoArgs => ({
  ...videoBase(args, 'seedance2'), ratio: str(args.ratio), refImages: list(args.refImages), refVideos: list(args.refVideos),
  refAudios: list(args.refAudios), generateAudio: bool(args.generateAudio), seed: num(args.seed),
  cameraFixed: bool(args.cameraFixed), watermark: bool(args.watermark), returnLastFrame: bool(args.returnLastFrame),
  executionExpiresAfter: num(args.executionExpiresAfter), priority: num(args.priority),
});
const klingVideo = (args: GenerateArgs): SubmitVideoArgs => ({
  ...videoBase(args, 'kling'), ratio: str(args.ratio), mode: args.mode as SubmitVideoArgs['mode'],
  refImages: list(args.refImages), refVideos: list(args.refVideos),
  refVideoMode: args.refVideoMode === 'base' || args.refVideoMode === 'feature' ? args.refVideoMode : undefined,
  multiPrompts: Array.isArray(args.multiPrompts) && args.multiPrompts.length ? args.multiPrompts as SubmitVideoArgs['multiPrompts'] : undefined,
  shotType: args.shotType as SubmitVideoArgs['shotType'],
});
const hailuoVideo = (args: GenerateArgs): SubmitVideoArgs => ({
  ...videoBase(args, 'hailuo'), promptOptimizer: bool(args.promptOptimizer), fastPretreatment: bool(args.fastPretreatment),
});

const VIDEO_STRATEGIES = { seedance2: seedanceVideo, kling: klingVideo, hailuo: hailuoVideo } as const;
export function buildSubmitVideoArgs(args: GenerateArgs): SubmitVideoArgs {
  const model = args.model === 'kling' || args.model === 'hailuo' ? args.model : 'seedance2';
  return VIDEO_STRATEGIES[model](args);
}

export const buildSubmitSoundArgs = (args: GenerateArgs): SubmitSoundArgs => ({
  prompt: String(args.prompt ?? ''), durationSeconds: num(args.durationSeconds), promptInfluence: num(args.promptInfluence),
  loop: bool(args.loop), outputFormat: str(args.outputFormat), name: str(args.name),
});
