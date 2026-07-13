import type { MediaAsset, TimelineState } from '../editor/types';

export interface SubmitSoundArgs {
  prompt: string;
  durationSeconds?: number;
  promptInfluence?: number;
  name?: string;
}

interface SoundResponse {
  path?: string;
  durationSeconds?: number;
  error?: string;
}

const newId = () => crypto.randomUUID?.() ?? `generated_${Date.now()}_${Math.random().toString(36).slice(2)}`;

export async function submitSound(args: SubmitSoundArgs, state: TimelineState): Promise<MediaAsset> {
  const prompt = args.prompt.trim();
  if (!prompt) throw new Error('prompt is required');
  const response = await fetch('/generate/sound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...args, prompt }),
  });
  const result = await response.json().catch(() => ({})) as SoundResponse;
  if (!response.ok) throw new Error(result.error ?? `sound generation failed (${response.status})`);
  if (!result.path || !result.durationSeconds) throw new Error('sound generation returned invalid audio');
  return {
    id: newId(),
    name: args.name?.trim() || `Sound · ${prompt.slice(0, 36)}`,
    kind: 'audio',
    src: result.path,
    durationInFrames: Math.max(1, Math.round(result.durationSeconds * state.fps)),
  };
}
