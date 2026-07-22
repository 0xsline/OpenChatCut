import type { MusicMode, MusicRequest, MurekaStyle, ValidMusicRequest } from './music-types.ts';

const SAMPLE_RATES = new Set([16_000, 24_000, 32_000, 44_100]);
const BITRATES = new Set([32_000, 64_000, 128_000, 256_000]);
const STYLES = new Set<MurekaStyle>(['pop', 'rock', 'jazz', 'r&b', 'edm', 'ambient', 'folk', 'latin', 'k-pop', 'j-pop', 'house', 'gospel', 'lo-fi']);
const MUREKA_MODES = new Set<MusicMode>(['instrumental', 'song', 'prompt-song', 'soundtrack', 'track']);

function optionalText(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

function validateRange(start: number | undefined, end: number | undefined, label: string): void {
  if (start !== undefined && (!Number.isInteger(start) || start < 0)) throw new Error(`${label} start must be a non-negative integer`);
  if (end !== undefined && (!Number.isInteger(end) || end < 0)) throw new Error(`${label} end must be a non-negative integer`);
  if (start !== undefined && end !== undefined && end <= start) throw new Error(`${label} end must be after start`);
}

function validateMurekaMode(input: MusicRequest, mode: MusicMode, prompt: string, lyrics?: string): void {
  if (mode === 'instrumental') {
    if (Boolean(prompt) === Boolean(optionalText(input.instrumentalId))) throw new Error('mureka instrumental requires exactly one of prompt or instrumentalId');
    if (prompt.length > 1024) throw new Error('mureka instrumental prompt must be at most 1024 characters');
  } else if (mode === 'song') {
    if (!lyrics) throw new Error('mureka song mode requires lyrics');
    if (lyrics.length > 5000) throw new Error('mureka lyrics must be at most 5000 characters');
    if (prompt.length > 1024) throw new Error('mureka song prompt must be at most 1024 characters');
    const melody = optionalText(input.melodyId);
    if (melody && (prompt || input.referenceId || input.vocalId)) throw new Error('mureka melodyId cannot be combined with prompt/referenceId/vocalId');
  } else if (mode === 'prompt-song') {
    if (!prompt && !input.referenceId && !input.vocalId && !input.styles?.length) throw new Error('mureka prompt-song requires prompt, styles, referenceId, or vocalId');
    if (prompt.length > 2000) throw new Error('mureka prompt-song prompt must be at most 2000 characters');
    if (input.styles?.some((style) => !STYLES.has(style))) throw new Error('mureka styles contains an unsupported value');
  } else if (mode === 'soundtrack') {
    if (!input.sourceAssetPath || (input.sourceAssetKind !== 'image' && input.sourceAssetKind !== 'video')) {
      throw new Error('mureka soundtrack requires an image or video sourceAssetId');
    }
    if (prompt.length > 1024) throw new Error('mureka soundtrack prompt must be at most 1024 characters');
    validateRange(input.audioStartMs, input.audioEndMs, 'soundtrack audio range');
    if (input.audioStartMs !== undefined && input.audioEndMs !== undefined && input.audioEndMs - input.audioStartMs < 3000) {
      throw new Error('mureka soundtrack audio range must be at least 3000ms');
    }
  } else {
    if (Boolean(optionalText(input.songId)) === Boolean(input.sourceAssetPath)) throw new Error('mureka track requires exactly one of songId or sourceAssetId');
    if (input.sourceAssetPath && input.sourceAssetKind !== 'audio') throw new Error('mureka track sourceAssetId must be audio');
    if (!input.trackType) throw new Error('mureka track requires trackType');
    if (!prompt || prompt.length > 1024) throw new Error('mureka track prompt is required and must be at most 1024 characters');
    if (lyrics && lyrics.length > 5000) throw new Error('mureka track lyrics must be at most 5000 characters');
    if (input.vocalGender && input.trackType !== 'Vocals') throw new Error('vocalGender is supported for the Vocals trackType only');
    validateRange(input.generateStartMs, input.generateEndMs, 'track generation range');
  }
}

function rejectMurekaOnly(input: MusicRequest): void {
  const values = [input.count, input.styles, input.gender, input.referenceId, input.instrumentalId, input.vocalId, input.melodyId,
    input.sourceAssetPath, input.sourceAssetKind, input.audioStartMs, input.audioEndMs, input.songId, input.trackType,
    input.generateStartMs, input.generateEndMs, input.vocalGender, input.stream];
  if (values.some((value) => value !== undefined)) throw new Error('Mureka generation controls are supported by the mureka provider only');
}

function validateMinimax(input: MusicRequest, mode: MusicMode, prompt: string, lyrics?: string): void {
  if (mode !== 't2m' && mode !== 'cover') throw new Error('minimax mode must be t2m or cover');
  rejectMurekaOnly(input);
  const cover = mode === 'cover';
  if (cover) {
    if (prompt.length < 10 || prompt.length > 300) throw new Error('music-cover prompt must be 10–300 characters');
    if (Boolean(input.referenceAudioPath) === Boolean(optionalText(input.coverFeatureId))) {
      throw new Error('music-cover requires exactly one of referenceAssetId or coverFeatureId');
    }
    if (lyrics && (lyrics.length < 10 || lyrics.length > 1000)) throw new Error('music-cover lyrics must be 10–1000 characters');
    if (input.coverFeatureId && !lyrics) throw new Error('coverFeatureId requires lyrics');
    if (input.lyricsOptimizer || input.isInstrumental) throw new Error('lyricsOptimizer/isInstrumental are not used for music-cover');
  } else {
    if (prompt.length > 2000) throw new Error('MiniMax prompt must be at most 2000 characters');
    const instrumental = input.isInstrumental ?? (!lyrics && !input.lyricsOptimizer);
    if (instrumental && !prompt) throw new Error('MiniMax instrumental generation requires prompt');
    if (instrumental && (lyrics || input.lyricsOptimizer)) throw new Error('isInstrumental cannot be combined with lyrics/lyricsOptimizer');
    if (!instrumental && !lyrics && !input.lyricsOptimizer) throw new Error('MiniMax vocals require lyrics or lyricsOptimizer:true');
    if (lyrics && lyrics.length > 3500) throw new Error('MiniMax lyrics must be at most 3500 characters');
  }
  if (!SAMPLE_RATES.has(input.sampleRate ?? 44_100)) throw new Error('sampleRate must be 16000, 24000, 32000, or 44100');
  if (!BITRATES.has(input.bitrate ?? 256_000)) throw new Error('bitrate must be 32000, 64000, 128000, or 256000');
  if (input.audioFormat && !['mp3', 'wav', 'pcm'].includes(input.audioFormat)) throw new Error('MiniMax audioFormat must be mp3, wav, or pcm');
}

export function validateMusicRequest(input: MusicRequest): ValidMusicRequest {
  const provider = String(input.provider ?? 'mureka');
  if (provider !== 'mureka' && provider !== 'minimax') throw new Error('provider must be mureka or minimax');
  const inferredMode: MusicMode = provider === 'mureka' ? 'instrumental' : input.referenceAudioPath || input.coverFeatureId ? 'cover' : 't2m';
  const mode = input.mode ?? inferredMode;
  const prompt = optionalText(input.prompt) ?? '';
  const lyrics = optionalText(input.lyrics);
  if (provider === 'mureka') {
    if (!MUREKA_MODES.has(mode)) throw new Error('mureka mode must be instrumental, song, prompt-song, soundtrack, or track');
    if (input.referenceAudioPath || input.coverFeatureId || input.lyricsOptimizer !== undefined || input.isInstrumental !== undefined
      || input.sampleRate !== undefined || input.bitrate !== undefined) throw new Error('MiniMax-only controls are not supported by mureka');
    const count = input.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('mureka count must be an integer from 1 to 3');
    if (input.audioFormat && !['mp3', 'wav', 'flac'].includes(input.audioFormat)) throw new Error('Mureka audioFormat must be mp3, wav, or flac');
    validateMurekaMode(input, mode, prompt, lyrics);
  } else validateMinimax(input, mode, prompt, lyrics);
  const name = optionalText(input.name) ?? `Music · ${(prompt || mode).slice(0, 36)}`;
  return {
    ...input, provider, mode, prompt, lyrics, name,
    isInstrumental: provider === 'mureka'
      ? mode === 'instrumental'
      : input.isInstrumental ?? (mode === 't2m' && !lyrics && !input.lyricsOptimizer),
    lyricsOptimizer: input.lyricsOptimizer === true,
    sampleRate: input.sampleRate ?? 44_100,
    bitrate: input.bitrate ?? 256_000,
    audioFormat: input.audioFormat ?? 'mp3',
    count: input.count ?? 1,
    stream: input.stream === true,
    coverMode: mode === 'cover',
  };
}
