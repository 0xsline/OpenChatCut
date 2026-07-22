import type { MediaAsset, TimelineState } from '../editor/types';
import type { MinimaxLanguageBoost } from '../../shared/media-provider-params';

export interface SubmitVoiceArgs {
  provider: 'elevenlabs' | 'doubao' | 'minimax';
  text: string;
  voiceId: string;
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
  /** MiniMax only: voice_setting.vol 0–10. */
  volume?: number;
  performancePrompt?: string;
  explicitDialect?: 'dongbei' | 'shaanxi' | 'sichuan';
  sampleRate?: number;
  bitrate?: number;
  audioFormat?: 'mp3' | 'pcm' | 'flac' | 'wav' | 'pcmu_raw' | 'pcmu_wav' | 'opus';
  channel?: 1 | 2;
  forceCbr?: boolean;
  stream?: boolean;
  excludeAggregatedAudio?: boolean;
  languageBoost?: MinimaxLanguageBoost;
  textNormalization?: boolean;
  latexRead?: boolean;
  pronunciations?: string[];
  timbreWeights?: Array<{ voiceId: string; weight: number }>;
  voiceModify?: { pitch?: number; intensity?: number; timbre?: number; effect?: 'spacious_echo' | 'auditorium_echo' | 'lofi_telephone' | 'robotic' };
  subtitleEnable?: boolean;
  subtitleType?: 'sentence' | 'word' | 'word_streaming';
  name?: string;
}

interface VoiceResponse {
  path?: string;
  subtitlePath?: string;
  durationSeconds?: number;
  error?: string;
}

const newId = () => crypto.randomUUID?.() ?? `generated_${Date.now()}_${Math.random().toString(36).slice(2)}`;

function probeAudio(src: string, fps: number): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const fallback = window.setTimeout(() => resolve(Math.round(fps * 5)), 10_000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      window.clearTimeout(fallback);
      resolve(Math.max(1, Math.round((audio.duration || 5) * fps)));
    };
    audio.onerror = () => {
      window.clearTimeout(fallback);
      resolve(Math.round(fps * 5));
    };
    audio.src = src;
  });
}

export async function submitVoice(args: SubmitVoiceArgs, state: TimelineState): Promise<MediaAsset> {
  const text = args.text.trim();
  const voiceId = args.voiceId.trim();
  if (!text) throw new Error('text is required');
  if (!voiceId && !args.timbreWeights?.length) throw new Error('voiceId is required unless MiniMax timbreWeights are provided');
  const response = await fetch('/generate/voice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...args, text, voiceId }),
  });
  const result = await response.json().catch(() => ({})) as VoiceResponse;
  if (!response.ok) throw new Error(result.error ?? `voice generation failed (${response.status})`);
  if (!result.path) throw new Error('voice generation returned no audio asset');
  const durationInFrames = result.durationSeconds && Number.isFinite(result.durationSeconds)
    ? Math.max(1, Math.round(result.durationSeconds * state.fps))
    : await probeAudio(result.path, state.fps);
  const props = result.subtitlePath ? { minimaxSubtitlePath: result.subtitlePath, minimaxSubtitleType: args.subtitleType ?? 'sentence' } : undefined;
  return {
    id: newId(),
    name: args.name?.trim() || `Voice · ${voiceId}`,
    kind: 'audio',
    src: result.path,
    durationInFrames,
    props,
  };
}
