import type { TimelineState } from '../editor/types';

export interface SubmitMusicArgs {
  prompt: string;
  name?: string;
  provider?: 'mureka' | 'minimax';
  lyrics?: string;
  isInstrumental?: boolean;
  lyricsOptimizer?: boolean;
  sampleRate?: number;
  bitrate?: number;
  audioFormat?: 'mp3' | 'wav' | 'pcm';
  /** Project audio asset id for MiniMax music-cover (requires music-cover model in settings). */
  referenceAssetId?: string;
}

interface MusicResponse {
  jobId?: string;
  status?: 'queued';
  error?: string;
}

export interface MusicGenerationSubmission {
  jobId: string;
  status: 'queued';
}

function resolveAudioSrc(ref: string, state?: TimelineState): string {
  if (!state) throw new Error('project state required to resolve reference audio');
  const clean = ref.replace(/^asset:\/\//, '').trim();
  const asset = (state.assets ?? []).find(
    (a) => a.id === clean || a.id.startsWith(clean) || a.name === clean || a.src === clean,
  );
  if (!asset) throw new Error(`reference audio asset not found: ${ref}`);
  if (asset.kind !== 'audio') throw new Error(`reference asset is not audio: ${ref}`);
  let pathname = asset.src;
  if (pathname.startsWith('http')) {
    const url = new URL(pathname, location.origin);
    if (url.origin !== location.origin) throw new Error(`external audio URLs are not accepted: ${ref}`);
    pathname = url.pathname;
  }
  if (!pathname.startsWith('/media/uploads/')) {
    throw new Error(`reference audio must be a project upload: ${ref}`);
  }
  return pathname;
}

export async function submitMusic(args: SubmitMusicArgs, state?: TimelineState): Promise<MusicGenerationSubmission> {
  const prompt = args.prompt.trim();
  if (!prompt) throw new Error('prompt is required');
  const referenceAudioPath = args.referenceAssetId
    ? resolveAudioSrc(args.referenceAssetId, state)
    : undefined;
  const response = await fetch('/generate/music', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      name: args.name,
      provider: args.provider,
      lyrics: args.lyrics,
      isInstrumental: args.isInstrumental,
      lyricsOptimizer: args.lyricsOptimizer,
      sampleRate: args.sampleRate,
      bitrate: args.bitrate,
      audioFormat: args.audioFormat,
      referenceAudioPath,
    }),
  });
  const result = await response.json().catch(() => ({})) as MusicResponse;
  if (!response.ok) throw new Error(result.error ?? `music generation failed (${response.status})`);
  if (!result.jobId || result.status !== 'queued') throw new Error('music generation returned an invalid job submission');
  return { jobId: result.jobId, status: result.status };
}
