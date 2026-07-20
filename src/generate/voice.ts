import type { MediaAsset, TimelineState } from '../editor/types';

export interface SubmitVoiceArgs {
  provider: 'elevenlabs' | 'doubao' | 'minimax';
  text: string;
  voiceId: string;
  modelId?: string;
  stability?: number;
  speed?: number;
  speedRatio?: number;
  emotion?: string;
  emotionScale?: number;
  loudnessRatio?: number;
  pitch?: number;
  /** MiniMax only: voice_setting.vol 0–10. */
  volume?: number;
  performancePrompt?: string;
  explicitDialect?: 'dongbei' | 'shaanxi' | 'sichuan';
  name?: string;
}

interface VoiceResponse {
  path?: string;
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
  if (!voiceId) throw new Error('voiceId is required');
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
  return {
    id: newId(),
    name: args.name?.trim() || `Voice · ${voiceId}`,
    kind: 'audio',
    src: result.path,
    durationInFrames,
  };
}
