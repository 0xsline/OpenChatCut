import type { MediaAsset, TimelineItem, TimelineState } from '../editor/types';
import { sourceWindowForTimelineRange } from '../editor/sourceLimit';

export interface SubmitVideoArgs {
  operationId?: string;
  model: 'seedance2' | 'kling' | 'hailuo' | 'byteplus';
  prompt?: string;
  name?: string;
  durationSeconds?: number | string;
  ratio?: string;
  resolution?: '480p' | '512p' | '720p' | '1080p' | '4k';
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
  /** Seedance-only provider controls. */
  generateAudio?: boolean;
  seed?: number;
  cameraFixed?: boolean;
  watermark?: boolean;
  returnLastFrame?: boolean;
  executionExpiresAfter?: number;
  priority?: number;
  multiPrompts?: Array<{ prompt: string; duration: number | string; index: number }>;
  shotType?: 'customize' | 'intelligence';
}

export type GenerationReferenceRole = 'first-frame' | 'last-frame' | 'reference-image' | 'reference-video' | 'reference-audio';

interface GenerationReferenceBase {
  role: GenerationReferenceRole;
  assetId: string;
  path: string;
  sourceRevision?: string;
}

export interface AssetMasterGenerationReference extends GenerationReferenceBase {
  kind: 'asset-master';
}

export interface TimelineSliceGenerationReference extends GenerationReferenceBase {
  kind: 'timeline-slice';
  itemId: string;
  srcInFrame: number;
  srcOutFrame: number;
  playbackRate: number;
  timelineDurationInFrames: number;
  fps: number;
}

export type GenerationReference = AssetMasterGenerationReference | TimelineSliceGenerationReference;

export interface GenerationReferencePreflightIssue {
  code: string;
  model: SubmitVideoArgs['model'];
  role?: GenerationReferenceRole;
  message: string;
}

export class GenerationReferencePreflightError extends Error {
  readonly code = 'generation_reference_preflight';
  readonly issues: GenerationReferencePreflightIssue[];

  constructor(issues: GenerationReferencePreflightIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'GenerationReferencePreflightError';
    this.issues = issues;
  }
}

interface VideoResponse {
  operationId?: string;
  jobId?: string;
  status?: 'queued';
  provider?: string;
  providerTaskId?: string;
  acceptedAt?: number;
  sourceRevisions?: string[];
  error?: string;
  code?: string;
  issues?: GenerationReferencePreflightIssue[];
}

export interface VideoGenerationSubmission {
  operationId: string;
  jobId: string;
  status: 'queued';
  provider?: string;
  providerTaskId?: string;
  acceptedAt?: number;
  sourceRevisions?: string[];
}

function sameOriginUploadPath(rawPath: string, ref: string): string {
  let pathname = rawPath;
  if (rawPath.startsWith('http')) {
    const url = new URL(rawPath, location.origin);
    if (url.origin !== location.origin) throw new Error(`external asset URLs are not accepted: ${ref}`);
    pathname = url.pathname;
  }
  if (!pathname.startsWith('/media/uploads/')) throw new Error(`generation reference must be a project upload: ${ref}`);
  return pathname;
}

function resolveAssetForReference(ref: string, state: TimelineState, kind: MediaAsset['kind'], item?: TimelineItem): MediaAsset {
  const cleanRef = ref.replace(/^asset:\/\//, '');
  const path = item?.src ? sameOriginUploadPath(item.src, ref) : cleanRef;
  const all = state.assets ?? [];
  const exact = all.filter((asset) => asset.id === cleanRef || asset.name === cleanRef || asset.src === path);
  const candidates = exact.length ? exact : all.filter((asset) => asset.id.startsWith(cleanRef));
  if (candidates.length !== 1) throw new Error(candidates.length ? `asset reference is ambiguous: ${ref}` : `asset not found: ${ref}`);
  if (candidates[0].kind !== kind) throw new Error(`asset is not ${kind}: ${ref}`);
  return candidates[0];
}

function resolveReference(
  ref: string,
  state: TimelineState,
  kind: MediaAsset['kind'],
  role: GenerationReferenceRole,
): GenerationReference {
  const cleanRef = ref.replace(/^asset:\/\//, '');
  const item = state.items.find((candidate) => candidate.id === cleanRef || candidate.name === cleanRef);
  if (item && item.kind !== kind) throw new Error(`timeline reference is not ${kind}: ${ref}`);
  const asset = resolveAssetForReference(ref, state, kind, item);
  const path = sameOriginUploadPath(item?.src ?? asset.src, ref);
  const sourceRevision = item?.sourceRevision ?? asset.sourceRevision;
  if (!item || (kind !== 'video' && kind !== 'audio')) {
    return { kind: 'asset-master', role, assetId: asset.id, path, sourceRevision };
  }
  const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  const sourceLimit = asset.durationInFrames > 0 ? asset.durationInFrames : Number.POSITIVE_INFINITY;
  const srcInFrame = Math.min(sourceLimit, window.startFrame);
  const srcOutFrame = Math.max(srcInFrame, Math.min(sourceLimit, window.endFrame));
  return {
    kind: 'timeline-slice',
    role,
    assetId: asset.id,
    itemId: item.id,
    path,
    sourceRevision,
    srcInFrame,
    srcOutFrame,
    playbackRate: Math.max(0.01, item.playbackRate ?? 1),
    timelineDurationInFrames: item.durationInFrames,
    fps: state.fps,
  };
}

/** Provider/model/role validation before a paid provider request is submitted. */
export function preflightGenerationReferences(
  model: SubmitVideoArgs['model'],
  references: readonly GenerationReference[],
): void {
  const issues: GenerationReferencePreflightIssue[] = [];
  const count = (role: GenerationReferenceRole) => references.filter((reference) => reference.role === role).length;
  const firstFrames = count('first-frame');
  const lastFrames = count('last-frame');
  const images = count('reference-image');
  const videos = count('reference-video');
  const audios = count('reference-audio');

  for (const reference of references) {
    const expected = reference.role === 'reference-video' ? 'video'
      : reference.role === 'reference-audio' ? 'audio' : 'image';
    if (reference.kind === 'timeline-slice' && expected === 'image') {
      issues.push({ code: 'role_slice_unsupported', model, role: reference.role, message: `${model} ${reference.role} must use an image asset master, not a timeline slice` });
    }
    if (reference.kind === 'timeline-slice' && !(reference.srcOutFrame > reference.srcInFrame)) {
      issues.push({ code: 'empty_timeline_slice', model, role: reference.role, message: `${model} ${reference.role} timeline slice is empty` });
    }
  }
  if (lastFrames && !firstFrames) {
    issues.push({ code: 'last_frame_requires_first', model, role: 'last-frame', message: `${model} lastFrame requires firstFrame` });
  }
  if (model === 'hailuo' && (images || videos || audios)) {
    issues.push({ code: 'hailuo_reference_role', model, message: 'hailuo does not support reference arrays; use firstFrame and optional lastFrame' });
  }
  if (model === 'seedance2' || model === 'byteplus') {
    if (lastFrames && (images || videos || audios)) {
      issues.push({ code: 'seedance_last_frame_conflict', model, role: 'last-frame', message: `${model} lastFrame cannot be combined with reference arrays` });
    }
    if (images > 9 || videos > 3 || audios > 3) {
      issues.push({ code: 'seedance_reference_limit', model, message: `${model} supports at most 9 images, 3 videos, and 3 audio references` });
    }
    if (audios && !firstFrames && !images && !videos) {
      issues.push({ code: 'seedance_audio_requires_visual', model, role: 'reference-audio', message: `${model} audio references require a visual reference` });
    }
  }
  if (model === 'kling') {
    if (audios) issues.push({ code: 'kling_audio_unsupported', model, role: 'reference-audio', message: 'kling does not support audio references' });
    if (videos > 1) issues.push({ code: 'kling_video_limit', model, role: 'reference-video', message: 'kling accepts at most one reference video' });
    const imageCount = firstFrames + lastFrames + images;
    const maxImages = videos ? 4 : 7;
    if (imageCount > maxImages) {
      issues.push({ code: 'kling_image_limit', model, role: 'reference-image', message: `kling accepts at most ${maxImages} total image references for this request` });
    }
  }
  if (issues.length) throw new GenerationReferencePreflightError(issues);
}

export async function submitVideo(args: SubmitVideoArgs, state: TimelineState): Promise<VideoGenerationSubmission> {
  const firstFrame = args.firstFrame ? resolveReference(args.firstFrame, state, 'image', 'first-frame') : undefined;
  const lastFrame = args.lastFrame ? resolveReference(args.lastFrame, state, 'image', 'last-frame') : undefined;
  const refImages = (args.refImages ?? []).map((ref) => resolveReference(ref, state, 'image', 'reference-image'));
  const refVideos = (args.refVideos ?? []).map((ref) => resolveReference(ref, state, 'video', 'reference-video'));
  const refAudios = (args.refAudios ?? []).map((ref) => resolveReference(ref, state, 'audio', 'reference-audio'));
  const references = [firstFrame, lastFrame, ...refImages, ...refVideos, ...refAudios]
    .filter((reference): reference is GenerationReference => reference !== undefined);
  preflightGenerationReferences(args.model, references);
  const sourceRevisions = [...new Set(references.map((reference) => reference.sourceRevision).filter((revision): revision is string => Boolean(revision)))];
  const response = await fetch('/generate/video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...args,
      generationReferences: references,
      sourceRevisions,
      firstFramePath: firstFrame?.path,
      lastFramePath: lastFrame?.path,
      refImagePaths: refImages.map((reference) => reference.path),
      refVideoPaths: refVideos.map((reference) => reference.path),
      refAudioPaths: refAudios.map((reference) => reference.path),
    }),
  });
  const result = await response.json().catch(() => ({})) as VideoResponse;
  if (!response.ok) {
    if (result.code === 'generation_reference_preflight' && result.issues?.length) {
      throw new GenerationReferencePreflightError(result.issues);
    }
    throw new Error(result.error ?? `video generation failed (${response.status})`);
  }
  if (!result.operationId || !result.jobId || result.status !== 'queued') throw new Error('video generation returned an invalid job submission');
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
