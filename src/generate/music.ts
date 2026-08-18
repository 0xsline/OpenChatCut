import type { MediaAsset, TimelineState } from '../editor/types';

export interface SubmitMusicArgs {
  operationId?: string;
  prompt?: string;
  name?: string;
  provider?: 'mureka' | 'minimax' | 'atlas' | 'sonilo';
  mode?: 'instrumental' | 'song' | 'prompt-song' | 'soundtrack' | 'track' | 't2m' | 'cover' | 'v2m';
  lyrics?: string;
  isInstrumental?: boolean;
  lyricsOptimizer?: boolean;
  sampleRate?: number;
  bitrate?: number;
  audioFormat?: 'mp3' | 'wav' | 'pcm' | 'flac';
  /** Project audio asset id for MiniMax music-cover (requires music-cover model in settings). */
  referenceAssetId?: string;
  coverFeatureId?: string;
  count?: number;
  stream?: boolean;
  styles?: Array<'pop' | 'rock' | 'jazz' | 'r&b' | 'edm' | 'ambient' | 'folk' | 'latin' | 'k-pop' | 'j-pop' | 'house' | 'gospel' | 'lo-fi'>;
  gender?: 'female' | 'male';
  referenceId?: string;
  instrumentalId?: string;
  vocalId?: string;
  melodyId?: string;
  /** Mureka soundtrack image/video, track source audio, or Sonilo v2m video (the rendered cut). */
  sourceAssetId?: string;
  audioStartMs?: number;
  audioEndMs?: number;
  songId?: string;
  trackType?: 'Vocals' | 'Instrumental' | 'Drums' | 'Bass' | 'Guitar' | 'Keyboard' | 'Percussion' | 'Strings' | 'Synth' | 'FX' | 'Brass' | 'Woodwinds';
  generateStartMs?: number;
  generateEndMs?: number;
  vocalGender?: 'female' | 'male';
}

interface MusicResponse {
  operationId?: string;
  jobId?: string;
  status?: 'queued';
  provider?: string;
  providerTaskId?: string;
  acceptedAt?: number;
  sourceRevisions?: string[];
  error?: string;
}

export interface MusicGenerationSubmission {
  operationId: string;
  jobId: string;
  status: 'queued';
  provider?: string;
  providerTaskId?: string;
  acceptedAt?: number;
  sourceRevisions?: string[];
}

function resolveAsset(ref: string, state?: TimelineState, kind?: MediaAsset['kind']): MediaAsset {
  if (!state) throw new Error('project state required to resolve music source asset');
  const clean = ref.replace(/^asset:\/\//, '').trim();
  const asset = (state.assets ?? []).find(
    (a) => a.id === clean || a.id.startsWith(clean) || a.name === clean || a.src === clean,
  );
  if (!asset) throw new Error(`music source asset not found: ${ref}`);
  if (kind && asset.kind !== kind) throw new Error(`music source asset is not ${kind}: ${ref}`);
  let pathname = asset.src;
  if (pathname.startsWith('http')) {
    const url = new URL(pathname, location.origin);
    if (url.origin !== location.origin) throw new Error(`external audio URLs are not accepted: ${ref}`);
    pathname = url.pathname;
  }
  if (!pathname.startsWith('/media/uploads/')) throw new Error(`music source must be a project upload: ${ref}`);
  return { ...asset, src: pathname };
}

export async function submitMusic(args: SubmitMusicArgs, state?: TimelineState): Promise<MusicGenerationSubmission> {
  const prompt = args.prompt?.trim() ?? '';
  const referenceAsset = args.referenceAssetId ? resolveAsset(args.referenceAssetId, state, 'audio') : undefined;
  const referenceAudioPath = referenceAsset?.src;
  const sourceAsset = args.sourceAssetId ? resolveAsset(args.sourceAssetId, state) : undefined;
  const sourceRevisions = [...new Set(
    [referenceAsset?.sourceRevision, sourceAsset?.sourceRevision].filter((revision): revision is string => Boolean(revision)),
  )];
  const response = await fetch('/generate/music', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...args,
      prompt,
      referenceAudioPath,
      sourceAssetPath: sourceAsset?.src,
      sourceAssetKind: sourceAsset?.kind,
      sourceRevisions,
      referenceAssetId: undefined,
      sourceAssetId: undefined,
    }),
  });
  const result = await response.json().catch(() => ({})) as MusicResponse;
  if (!response.ok) throw new Error(result.error ?? `music generation failed (${response.status})`);
  if (!result.operationId || !result.jobId || result.status !== 'queued') throw new Error('music generation returned an invalid job submission');
  return {
    operationId: result.operationId,
    jobId: result.jobId,
    status: result.status,
    provider: result.provider,
    providerTaskId: result.providerTaskId,
    acceptedAt: result.acceptedAt,
    sourceRevisions: result.sourceRevisions ?? sourceRevisions,
  };
}
