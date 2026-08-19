import type { MediaAsset, TimelineState } from '../editor/types';
import { findAssetByReference } from './asset-reference';

export interface SubmitSoundArgs {
  operationId?: string;
  provider?: 'elevenlabs' | 'sonilo';
  prompt?: string;
  durationSeconds?: number;
  promptInfluence?: number;
  loop?: boolean;
  outputFormat?: string;
  /** Sonilo only: project video asset (the rendered cut) the SFX are generated from. */
  sourceAssetId?: string;
  name?: string;
}

interface SoundResponse {
  operationId?: string;
  jobId?: string;
  status?: 'queued';
  provider?: string;
  providerTaskId?: string;
  acceptedAt?: number;
  sourceRevisions?: string[];
  path?: string;
  durationSeconds?: number;
  licenseId?: string;
  error?: string;
}

export interface SoundGenerationSubmission {
  operationId: string;
  jobId: string;
  status: 'queued';
  provider?: string;
  providerTaskId?: string;
  acceptedAt?: number;
  sourceRevisions?: string[];
}

const newId = () => crypto.randomUUID?.() ?? `generated_${Date.now()}_${Math.random().toString(36).slice(2)}`;

function resolveVideoAsset(ref: string, state: TimelineState): MediaAsset {
  const asset = findAssetByReference(ref, state.assets ?? []);
  if (!asset) throw new Error(`sound source asset not found: ${ref}`);
  if (asset.kind !== 'video') throw new Error(`sound source asset is not video: ${ref}`);
  let pathname = asset.src;
  if (pathname.startsWith('http')) {
    const url = new URL(pathname, location.origin);
    if (url.origin !== location.origin) throw new Error(`external video URLs are not accepted: ${ref}`);
    pathname = url.pathname;
  }
  if (!pathname.startsWith('/media/uploads/')) throw new Error(`sound source must be a project upload: ${ref}`);
  return { ...asset, src: pathname };
}

export async function submitSound(
  args: SubmitSoundArgs,
  state: TimelineState,
): Promise<MediaAsset | SoundGenerationSubmission> {
  const provider = args.provider === 'sonilo' ? 'sonilo' : 'elevenlabs';
  const prompt = args.prompt?.trim() ?? '';
  if (provider === 'elevenlabs' && !prompt) throw new Error('prompt is required');
  const sourceAsset = provider === 'sonilo' && args.sourceAssetId
    ? resolveVideoAsset(args.sourceAssetId, state)
    : undefined;
  const fallbackName = provider === 'sonilo'
    ? `SFX · ${(sourceAsset?.name ?? 'cut').slice(0, 36)}`
    : `Sound · ${prompt.slice(0, 36)}`;
  const name = args.name?.trim() || fallbackName;
  const sourceRevisions = sourceAsset?.sourceRevision ? [sourceAsset.sourceRevision] : [];
  const response = await fetch('/generate/sound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...args,
      provider,
      prompt,
      name,
      sourceRevisions,
      sourceAssetPath: sourceAsset?.src,
      sourceAssetKind: sourceAsset?.kind,
      sourceAssetId: undefined,
    }),
  });
  const result = await response.json().catch(() => ({})) as SoundResponse;
  if (!response.ok) throw new Error(result.error ?? `sound generation failed (${response.status})`);
  if (provider === 'sonilo') {
    if (!result.operationId || !result.jobId || result.status !== 'queued') {
      throw new Error('sound generation returned an invalid job submission');
    }
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
  if (!result.path || !result.durationSeconds) throw new Error('sound generation returned invalid audio');
  return {
    id: newId(),
    name,
    kind: 'audio',
    src: result.path,
    durationInFrames: Math.max(1, Math.round(result.durationSeconds * state.fps)),
  };
}
