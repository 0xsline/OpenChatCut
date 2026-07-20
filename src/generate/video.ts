import type { MediaAsset, TimelineState } from '../editor/types';

export interface SubmitVideoArgs {
  model: 'seedance2' | 'kling' | 'hailuo';
  prompt?: string;
  name?: string;
  durationSeconds?: number | string;
  ratio?: string;
  resolution?: '480p' | '720p' | '1080p' | '4k';
  mode?: 'std' | 'pro';
  firstFrame?: string;
  lastFrame?: string;
  refImages?: string[];
  refVideos?: string[];
  refAudios?: string[];
  /** Kling only: feature (default) = motion/style ref; base = video to edit. */
  refVideoMode?: 'feature' | 'base';
  /** Hailuo only: MiniMax prompt optimizer (default true). */
  promptOptimizer?: boolean;
  /** Hailuo only: faster pretreatment when optimizer is on. */
  fastPretreatment?: boolean;
  multiPrompts?: Array<{ prompt: string; duration: number | string; index: number }>;
  shotType?: 'customize' | 'intelligence';
}

interface VideoResponse {
  jobId?: string;
  status?: 'queued';
  error?: string;
}

export interface VideoGenerationSubmission {
  jobId: string;
  status: 'queued';
}

function resolveAsset(ref: string, state: TimelineState, kind: MediaAsset['kind']): MediaAsset {
  const cleanRef = ref.replace(/^asset:\/\//, '');
  const timelineItem = state.items.find((item) => item.id === cleanRef || item.name === cleanRef);
  const rawPath = timelineItem?.src ?? cleanRef;
  let pathname = rawPath;
  if (rawPath.startsWith('http')) {
    const url = new URL(rawPath, location.origin);
    if (url.origin !== location.origin) throw new Error(`external asset URLs are not accepted: ${ref}`);
    pathname = url.pathname;
  }
  const candidates = (state.assets ?? []).filter((asset) => asset.id === cleanRef || asset.id.startsWith(cleanRef) || asset.name === cleanRef || asset.src === pathname);
  if (candidates.length !== 1) throw new Error(candidates.length ? `asset reference is ambiguous: ${ref}` : `asset not found: ${ref}`);
  if (candidates[0].kind !== kind) throw new Error(`asset is not ${kind}: ${ref}`);
  return candidates[0];
}

export async function submitVideo(args: SubmitVideoArgs, state: TimelineState): Promise<VideoGenerationSubmission> {
  const firstFramePath = args.firstFrame ? resolveAsset(args.firstFrame, state, 'image').src : undefined;
  const lastFramePath = args.lastFrame ? resolveAsset(args.lastFrame, state, 'image').src : undefined;
  const refImagePaths = (args.refImages ?? []).map((ref) => resolveAsset(ref, state, 'image').src);
  const refVideoPaths = (args.refVideos ?? []).map((ref) => resolveAsset(ref, state, 'video').src);
  const refAudioPaths = (args.refAudios ?? []).map((ref) => resolveAsset(ref, state, 'audio').src);
  const response = await fetch('/generate/video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...args, firstFramePath, lastFramePath, refImagePaths, refVideoPaths, refAudioPaths }),
  });
  const result = await response.json().catch(() => ({})) as VideoResponse;
  if (!response.ok) throw new Error(result.error ?? `video generation failed (${response.status})`);
  if (!result.jobId || result.status !== 'queued') throw new Error('video generation returned an invalid job submission');
  return { jobId: result.jobId, status: result.status };
}
