import type { MinimaxLanguageBoost } from '../../shared/media-provider-params.ts';

export type VoiceProvider = 'elevenlabs' | 'doubao' | 'minimax';
export type MinimaxVoiceFormat = 'mp3' | 'pcm' | 'flac' | 'wav' | 'pcmu_raw' | 'pcmu_wav' | 'opus';
export type VoiceEffect = 'spacious_echo' | 'auditorium_echo' | 'lofi_telephone' | 'robotic';

export interface VoiceOptions {
  elevenBaseUrl: string;
  elevenApiKey: string;
  elevenModel: string;
  doubaoBaseUrl: string;
  doubaoAppId: string;
  doubaoAccessKey: string;
  doubaoResourceId: string;
  minimaxBaseUrl: string;
  minimaxApiKey: string;
  minimaxModel: string;
}

export interface VoiceRequest {
  provider?: string;
  text?: string;
  voiceId?: string;
  modelId?: string;
  stability?: number;
  speed?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  languageCode?: string;
  seed?: number;
  outputFormat?: string;
  optimizeStreamingLatency?: number;
  enableLogging?: boolean;
  applyTextNormalization?: 'auto' | 'on' | 'off';
  applyLanguageTextNormalization?: boolean;
  pronunciationDictionaryLocators?: Array<{ pronunciationDictionaryId: string; versionId: string }>;
  previousText?: string;
  nextText?: string;
  previousRequestIds?: string[];
  nextRequestIds?: string[];
  speedRatio?: number;
  emotion?: string;
  emotionScale?: number;
  loudnessRatio?: number;
  pitch?: number;
  volume?: number;
  performancePrompt?: string;
  explicitDialect?: string;
  sampleRate?: number;
  bitrate?: number;
  audioFormat?: MinimaxVoiceFormat;
  channel?: 1 | 2;
  forceCbr?: boolean;
  stream?: boolean;
  excludeAggregatedAudio?: boolean;
  languageBoost?: MinimaxLanguageBoost;
  textNormalization?: boolean;
  latexRead?: boolean;
  pronunciations?: string[];
  timbreWeights?: Array<{ voiceId: string; weight: number }>;
  voiceModify?: { pitch?: number; intensity?: number; timbre?: number; effect?: VoiceEffect };
  subtitleEnable?: boolean;
  subtitleType?: 'sentence' | 'word' | 'word_streaming';
}

export interface ValidVoiceRequest extends VoiceRequest {
  provider: VoiceProvider;
  text: string;
  voiceId: string;
  outputFormat: string;
  sampleRate: number;
  bitrate?: number;
  audioFormat: MinimaxVoiceFormat;
  channel: 1 | 2;
}
