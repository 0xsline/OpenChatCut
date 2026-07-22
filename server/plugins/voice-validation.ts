import type { ValidVoiceRequest, VoiceRequest } from './voice-types.ts';
import { MINIMAX_LANGUAGE_BOOSTS } from '../../shared/media-provider-params.ts';

const EMOTIONS = new Set(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper']);
const ELEVEN_OUTPUTS = new Set([
  'mp3_22050_32', 'mp3_24000_48', 'mp3_44100_32', 'mp3_44100_64', 'mp3_44100_96', 'mp3_44100_128', 'mp3_44100_192',
  'pcm_8000', 'pcm_16000', 'pcm_22050', 'pcm_24000', 'pcm_32000', 'pcm_44100', 'pcm_48000',
  'ulaw_8000', 'alaw_8000', 'opus_48000_32', 'opus_48000_64', 'opus_48000_96', 'opus_48000_128', 'opus_48000_192',
  'wav_8000', 'wav_16000', 'wav_22050', 'wav_24000', 'wav_32000', 'wav_44100', 'wav_48000',
]);
const MINIMAX_RATES = new Set([8_000, 16_000, 22_050, 24_000, 32_000, 44_100]);
const MINIMAX_BITRATES = new Set([32_000, 64_000, 128_000, 256_000]);
const MINIMAX_FORMATS = new Set(['mp3', 'pcm', 'flac', 'wav', 'pcmu_raw', 'pcmu_wav', 'opus']);
const MINIMAX_LANGUAGES = new Set<string>(MINIMAX_LANGUAGE_BOOSTS);

function range(value: number | undefined, min: number, max: number, name: string): void {
  if (value != null && (!Number.isFinite(value) || value < min || value > max)) throw new Error(`${name} must be between ${min} and ${max}`);
}

function reject(values: unknown[], message: string): void {
  if (values.some((value) => value !== undefined)) throw new Error(message);
}

function validateEleven(input: VoiceRequest): void {
  for (const [value, min, max, name] of [[input.stability, 0, 1, 'stability'], [input.similarityBoost, 0, 1, 'similarityBoost'],
    [input.style, 0, 1, 'style'], [input.speed, 0.7, 1.2, 'speed']] as Array<[number | undefined, number, number, string]>) range(value, min, max, name);
  if (!ELEVEN_OUTPUTS.has(input.outputFormat ?? 'mp3_44100_128')) throw new Error('unsupported ElevenLabs outputFormat');
  if (input.seed != null && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 4_294_967_295)) throw new Error('seed must be an integer from 0 to 4294967295');
  if (input.optimizeStreamingLatency != null && (!Number.isInteger(input.optimizeStreamingLatency) || input.optimizeStreamingLatency < 0 || input.optimizeStreamingLatency > 4)) {
    throw new Error('optimizeStreamingLatency must be an integer from 0 to 4');
  }
  if (input.pronunciationDictionaryLocators && input.pronunciationDictionaryLocators.length > 3) throw new Error('ElevenLabs supports at most 3 pronunciation dictionaries');
  reject([input.speedRatio, input.emotion, input.emotionScale, input.loudnessRatio, input.pitch, input.volume, input.performancePrompt,
    input.explicitDialect, input.sampleRate, input.bitrate, input.audioFormat, input.channel, input.forceCbr, input.languageBoost,
    input.stream, input.excludeAggregatedAudio, input.textNormalization, input.latexRead, input.pronunciations,
    input.timbreWeights, input.voiceModify, input.subtitleEnable, input.subtitleType],
  'ElevenLabs does not accept Doubao/MiniMax-only voice parameters');
}

function validateDoubao(input: VoiceRequest, voiceId: string): void {
  range(input.speedRatio, 0.5, 2, 'speedRatio');
  range(input.emotionScale, 1, 5, 'emotionScale');
  range(input.loudnessRatio, 0.5, 2, 'loudnessRatio');
  range(input.pitch, -12, 12, 'pitch');
  if (input.performancePrompt && input.performancePrompt.length > 200) throw new Error('performancePrompt must be 200 characters or fewer');
  if (input.emotionScale != null && !input.emotion) throw new Error('emotionScale requires emotion');
  if (input.explicitDialect && voiceId !== 'vivi') throw new Error('explicitDialect is only supported by the Vivi preset');
  reject([input.modelId, input.stability, input.speed, input.similarityBoost, input.style, input.useSpeakerBoost, input.languageCode,
    input.seed, input.outputFormat, input.optimizeStreamingLatency, input.enableLogging, input.applyTextNormalization,
    input.applyLanguageTextNormalization, input.pronunciationDictionaryLocators, input.previousText, input.nextText,
    input.previousRequestIds, input.nextRequestIds, input.volume, input.sampleRate, input.bitrate, input.audioFormat, input.channel,
    input.forceCbr, input.stream, input.excludeAggregatedAudio, input.languageBoost, input.textNormalization, input.latexRead,
    input.pronunciations, input.timbreWeights, input.voiceModify, input.subtitleEnable, input.subtitleType],
  'Doubao does not accept ElevenLabs/MiniMax-only voice parameters');
}

function validateMinimax(input: VoiceRequest, text: string): void {
  range(input.speed, 0.5, 2, 'speed');
  if (input.volume != null && (!Number.isFinite(input.volume) || input.volume <= 0 || input.volume > 10)) {
    throw new Error('volume must be greater than 0 and at most 10');
  }
  range(input.pitch, -12, 12, 'pitch');
  if (input.emotion && !EMOTIONS.has(input.emotion)) throw new Error(`MiniMax emotion must be one of: ${[...EMOTIONS].join(', ')}`);
  if (text.length > 10_000) throw new Error('MiniMax text must be at most 10000 characters');
  if (!MINIMAX_RATES.has(input.sampleRate ?? 32_000)) throw new Error('unsupported MiniMax sampleRate');
  const format = input.audioFormat ?? 'mp3';
  if (!MINIMAX_FORMATS.has(format)) throw new Error('unsupported MiniMax audioFormat');
  if (input.bitrate !== undefined && !MINIMAX_BITRATES.has(input.bitrate)) throw new Error('unsupported MiniMax bitrate');
  if (input.bitrate !== undefined && format !== 'mp3') throw new Error('MiniMax bitrate applies to MP3 only');
  if (input.channel != null && input.channel !== 1 && input.channel !== 2) throw new Error('channel must be 1 or 2');
  if (input.forceCbr === true && (input.stream !== true || format !== 'mp3')) throw new Error('MiniMax forceCbr requires stream=true and audioFormat=mp3');
  if (input.excludeAggregatedAudio !== undefined && input.stream !== true) throw new Error('excludeAggregatedAudio requires stream=true');
  if (input.languageBoost && !MINIMAX_LANGUAGES.has(input.languageBoost)) throw new Error('unsupported MiniMax languageBoost');
  if (input.latexRead === true && input.languageBoost && input.languageBoost !== 'Chinese') throw new Error('MiniMax latexRead requires languageBoost=Chinese (or omission)');
  if (input.subtitleType && input.subtitleEnable !== true) throw new Error('subtitleType requires subtitleEnable=true');
  if (input.subtitleType === 'word_streaming' && input.stream !== true) throw new Error('word_streaming subtitleType requires stream=true');
  if (input.pronunciations && input.pronunciations.some((tone) => !tone.trim())) throw new Error('pronunciations cannot contain empty values');
  if (input.timbreWeights && (input.timbreWeights.length < 1 || input.timbreWeights.length > 4
    || input.timbreWeights.some((item) => !item.voiceId.trim() || !Number.isInteger(item.weight) || item.weight < 1 || item.weight > 100))) {
    throw new Error('timbreWeights must contain 1–4 voiceId/weight entries with integer weights 1–100');
  }
  for (const key of ['pitch', 'intensity', 'timbre'] as const) range(input.voiceModify?.[key], -100, 100, `voiceModify.${key}`);
  if (input.voiceModify && (input.stream === true ? format !== 'mp3' : !['mp3', 'wav', 'flac'].includes(format))) {
    throw new Error('MiniMax voiceModify supports non-streaming mp3/wav/flac or streaming mp3 only');
  }
  if (input.timbreWeights?.length && input.voiceId?.trim()) throw new Error('MiniMax timbreWeights require an empty voiceId');
  reject([input.modelId, input.stability, input.similarityBoost, input.style, input.useSpeakerBoost, input.languageCode,
    input.seed, input.outputFormat, input.optimizeStreamingLatency, input.enableLogging, input.applyTextNormalization,
    input.applyLanguageTextNormalization, input.pronunciationDictionaryLocators, input.previousText, input.nextText,
    input.previousRequestIds, input.nextRequestIds, input.speedRatio, input.emotionScale, input.loudnessRatio,
    input.performancePrompt, input.explicitDialect], 'MiniMax does not accept ElevenLabs/Doubao-only voice parameters');
}

export function validateVoiceRequest(input: VoiceRequest): ValidVoiceRequest {
  if (input.provider !== 'elevenlabs' && input.provider !== 'doubao' && input.provider !== 'minimax') throw new Error('provider must be elevenlabs, doubao, or minimax');
  const text = String(input.text ?? '').trim();
  const requestedVoiceId = String(input.voiceId ?? '').trim();
  const voiceId = requestedVoiceId || (input.provider === 'minimax' && !input.timbreWeights?.length ? 'female-yujie' : '');
  if (!text) throw new Error('text is required');
  if (!voiceId && !(input.provider === 'minimax' && input.timbreWeights?.length)) throw new Error('voiceId is required');
  if (input.provider === 'elevenlabs') validateEleven(input);
  else if (input.provider === 'doubao') validateDoubao(input, voiceId);
  else validateMinimax(input, text);
  return { ...input, provider: input.provider, text, voiceId, outputFormat: input.outputFormat ?? 'mp3_44100_128',
    sampleRate: input.sampleRate ?? 32_000,
    bitrate: input.bitrate ?? ((input.audioFormat ?? 'mp3') === 'mp3' ? 128_000 : undefined),
    audioFormat: input.audioFormat ?? 'mp3', channel: input.channel ?? 1 };
}
