import type { MediaAsset, TimelineState } from '../editor/types';

export interface SubmitSoundArgs {
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
  path?: string;
  durationSeconds?: number;
  licenseId?: string;
  error?: string;
}

const newId = () => crypto.randomUUID?.() ?? `generated_${Date.now()}_${Math.random().toString(36).slice(2)}`;

function resolveVideoAsset(ref: string, state: TimelineState): MediaAsset {
  const clean = ref.replace(/^asset:\/\//, '').trim();
  const asset = (state.assets ?? []).find(
    (a) => a.id === clean || a.id.startsWith(clean) || a.name === clean || a.src === clean,
  );
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

export async function submitSound(args: SubmitSoundArgs, state: TimelineState): Promise<MediaAsset> {
  const provider = args.provider === 'sonilo' ? 'sonilo' : 'elevenlabs';
  const prompt = args.prompt?.trim() ?? '';
  if (provider === 'elevenlabs' && !prompt) throw new Error('prompt is required');
  const sourceAsset = provider === 'sonilo' && args.sourceAssetId
    ? resolveVideoAsset(args.sourceAssetId, state)
    : undefined;
  const response = await fetch('/generate/sound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...args,
      provider,
      prompt,
      sourceAssetPath: sourceAsset?.src,
      sourceAssetKind: sourceAsset?.kind,
      sourceAssetId: undefined,
    }),
  });
  const result = await response.json().catch(() => ({})) as SoundResponse;
  if (!response.ok) throw new Error(result.error ?? `sound generation failed (${response.status})`);
  if (!result.path || !result.durationSeconds) throw new Error('sound generation returned invalid audio');
  const fallbackName = provider === 'sonilo'
    ? `SFX · ${(sourceAsset?.name ?? 'cut').slice(0, 36)}`
    : `Sound · ${prompt.slice(0, 36)}`;
  return {
    id: newId(),
    name: args.name?.trim() || fallbackName,
    kind: 'audio',
    src: result.path,
    durationInFrames: Math.max(1, Math.round(result.durationSeconds * state.fps)),
  };
}
