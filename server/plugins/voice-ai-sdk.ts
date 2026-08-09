import { generateSpeech, type SpeechResult } from 'ai';
import { createCartesia } from '@ai-sdk/cartesia';
import { createGoogle } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';

import { versionedApiBaseUrl } from './media-provider-config.ts';

import type { ValidVoiceRequest, VoiceOptions, VoiceProvider } from './voice-types.ts';

export type AiVoiceProvider = Extract<VoiceProvider, 'openai' | 'gemini' | 'mistral' | 'cartesia'>;

export interface AiVoiceAudio {
  bytes: Buffer;
  codec: string;
  sampleRate: number;
}

export function isAiVoiceProvider(provider: VoiceProvider): provider is AiVoiceProvider {
  return provider === 'openai' || provider === 'gemini' || provider === 'mistral' || provider === 'cartesia';
}

function requireProviderKey(options: VoiceOptions, provider: AiVoiceProvider): string {
  const key = provider === 'openai' ? options.ai.openaiApiKey
    : provider === 'gemini' ? options.ai.geminiApiKey
    : provider === 'mistral' ? options.ai.mistralApiKey
    : options.ai.cartesiaApiKey;
  if (key) return key;
  const label = provider === 'openai' ? 'OpenAI' : provider[0]!.toUpperCase() + provider.slice(1);
  throw new Error(`${label} API key is not configured`);
}

function cartesiaProviderOptions(input: ValidVoiceRequest) {
  const format = input.outputFormat.toLowerCase().split('_')[0];
  if (format !== 'pcm' && format !== 'raw') return undefined;
  const requestedRate = Number(input.outputFormat.match(/_(\d{4,6})(?:_|$)/)?.[1]);
  const sampleRate = [8_000, 16_000, 22_050, 24_000, 44_100, 48_000].includes(requestedRate)
    ? requestedRate
    : input.sampleRate;
  return { cartesia: { encoding: 'pcm_s16le', sampleRate } } as const;
}

async function runAiProvider(
  options: VoiceOptions,
  input: ValidVoiceRequest,
  provider: AiVoiceProvider,
): Promise<SpeechResult> {
  const apiKey = requireProviderKey(options, provider);
  const common = { text: input.text, voice: input.voiceId, outputFormat: input.outputFormat } as const;
  if (provider === 'openai') return generateSpeech({ ...common,
    model: createOpenAI({ apiKey, baseURL: versionedApiBaseUrl(options.ai.openaiBaseUrl, 'v1') }).speech(input.modelId || options.ai.openaiModel),
    instructions: input.instructions, speed: input.speed,
  });
  if (provider === 'gemini') return generateSpeech({ ...common,
    model: createGoogle({ apiKey, baseURL: versionedApiBaseUrl(options.ai.geminiBaseUrl, 'v1beta') }).speech(input.modelId || options.ai.geminiModel),
    instructions: input.instructions,
  });
  if (provider === 'mistral') return generateSpeech({ ...common,
    model: createMistral({ apiKey, baseURL: versionedApiBaseUrl(options.ai.mistralBaseUrl, 'v1') }).speech(input.modelId || options.ai.mistralModel),
  });
  return generateSpeech({ ...common,
    model: createCartesia({ apiKey }).speech(input.modelId || options.ai.cartesiaModel),
    speed: input.speed, language: input.languageCode, providerOptions: cartesiaProviderOptions(input),
  });
}

function outputSampleRate(result: SpeechResult, input: ValidVoiceRequest): number {
  const metadataValue = result.providerMetadata['google']?.['sampleRate'];
  if (typeof metadataValue === 'number' && Number.isFinite(metadataValue)) return metadataValue;
  const format = input.outputFormat.toLowerCase().split('_')[0];
  if (format === 'alaw' || format === 'mulaw') return 8_000;
  const suffix = input.outputFormat.match(/_(\d{4,6})(?:_|$)/)?.[1];
  return suffix ? Number(suffix) : input.sampleRate;
}

function outputCodec(result: SpeechResult, input: ValidVoiceRequest): string {
  const requested = input.outputFormat.toLowerCase().split('_')[0]!;
  if (requested === 'pcm' || requested === 'raw') return 'pcm';
  if (requested === 'alaw') return 'alaw';
  if (requested === 'mulaw') return 'ulaw';
  const mediaType = result.audio.mediaType.toLowerCase();
  if (mediaType.includes('wav')) return 'wav';
  if (mediaType.includes('flac')) return 'flac';
  if (mediaType.includes('opus') || mediaType.includes('ogg')) return 'opus';
  if (mediaType.includes('aac') || mediaType.includes('mp4')) return 'aac';
  if (mediaType.includes('pcm') || mediaType.includes('l16')) return 'pcm';
  return ['wav', 'flac', 'opus', 'aac'].includes(requested) ? requested : 'mp3';
}

export async function generateAiVoice(options: VoiceOptions, input: ValidVoiceRequest): Promise<AiVoiceAudio> {
  if (!isAiVoiceProvider(input.provider)) throw new Error(`unsupported AI SDK voice provider: ${input.provider}`);
  const result = await runAiProvider(options, input, input.provider);
  return {
    bytes: Buffer.from(result.audio.uint8Array),
    codec: outputCodec(result, input),
    sampleRate: outputSampleRate(result, input),
  };
}
