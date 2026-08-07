import { editorCredentialHeaders } from '../editor-credential';
import { createMediaSourceRevision } from '../../editor/mediaSourceRevision';
import type { MediaAsset } from '../../editor/types';
import { safeSourceFilename } from '../../media/sourceFilename';
import { extractAudioForAsr } from '../../transcript/assemblyai';
import { enqueueTranscription, shouldTranscribe } from '../../transcript/transcribe-jobs';
import { hasOperationalTranscript } from '../../transcript/types';
import type { AgentContext } from '../context';
import {
  findUploadAsset,
  isUploadSourceType,
  mapUploadKind,
} from './upload-handoff-tools';

type Args = Record<string, unknown>;

interface FinalizeInput {
  sessionId: string;
  assetId: string;
  fileKey: string;
  filename: string;
  readUrl: string;
  size: number;
  type: string;
  sourceContentHash?: string;
}

interface FinalizedSource {
  src: string;
  width?: number;
  height?: number;
  finalSize: number;
  durationInFrames: number;
  normalized: boolean;
  sourceRevision: string;
}

interface FinalizeContext {
  input: FinalizeInput;
  kind: MediaAsset['kind'];
  source: FinalizedSource;
  hasAudio: boolean;
  projectId?: string;
  asrPath: Promise<string | null>;
  ctx: AgentContext;
}

async function resolveFinalizeInput(args: Args, ctx: AgentContext): Promise<FinalizeInput | { error: string }> {
  const receipt = typeof args.receipt === 'string' ? args.receipt.trim() : '';
  if (!receipt) return { error: 'receipt is required' };
  const projectId = ctx.getProjectId?.();
  if (!projectId) return { error: 'a persisted project is required to finalize an upload receipt' };
  const response = await fetch('/api/external-agent/upload-receipt', {
    method: 'POST',
    headers: await editorCredentialHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ receipt, projectId }),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'upload receipt is invalid, expired, consumed, or outside this project' };
  }
  const record = value as Record<string, unknown>;
  const filename = safeSourceFilename(record.filename);
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const assetId = typeof record.assetId === 'string' ? record.assetId : '';
  const fileKey = typeof record.fileKey === 'string' ? record.fileKey : '';
  const readUrl = typeof record.readUrl === 'string' ? record.readUrl : '';
  const size = typeof record.size === 'number' ? record.size : NaN;
  const sourceContentHash = typeof record.contentHash === 'string'
    && /^[a-f0-9]{64}$/.test(record.contentHash) ? record.contentHash : null;
  if (!/^sess_[A-Za-z0-9_-]+$/.test(sessionId) || !assetId || !filename
    || !/^uploads\/[A-Za-z0-9._-]+$/.test(fileKey)
    || readUrl !== `/media/${fileKey}` || !Number.isSafeInteger(size) || size <= 0
    || !isUploadSourceType(record.type) || !sourceContentHash) {
    return { error: 'trusted upload receipt returned invalid media identity' };
  }
  return {
    sessionId, assetId, fileKey, filename, readUrl, size,
    type: record.type, sourceContentHash,
  };
}

function durationForFinalize(args: Args, kind: MediaAsset['kind'], type: string, fps: number): number | null {
  if (kind === 'image' && type !== 'gif') return Math.round(3 * fps);
  if (typeof args.durationInSeconds === 'number' && args.durationInSeconds > 0) {
    return Math.max(1, Math.round(args.durationInSeconds * fps));
  }
  if (kind === 'image') return Math.round(3 * fps);
  return null;
}

/** Server-side video compatibility normalization (same as UI importMedia). */
async function normalizeVideoSrc(src: string): Promise<{
  src: string; width?: number; height?: number; bytes?: number;
  normalized?: boolean; durationSeconds?: number;
}> {
  if (!src.startsWith('/media/uploads/')) return { src };
  try {
    const response = await fetch('/api/normalize-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ src }),
    });
    const data = (await response.json()) as {
      path?: string; width?: number; height?: number; bytes?: number;
      normalized?: boolean; durationSeconds?: number; error?: string;
    };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (!data.path?.startsWith('/media/uploads/')) throw new Error('server returned no media path');
    return {
      src: data.path,
      width: typeof data.width === 'number' ? data.width : undefined,
      height: typeof data.height === 'number' ? data.height : undefined,
      bytes: typeof data.bytes === 'number' ? data.bytes : undefined,
      normalized: data.normalized,
      durationSeconds: typeof data.durationSeconds === 'number' ? data.durationSeconds : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Video compatibility processing failed: ${message}`);
  }
}

async function finalizedSource(
  input: FinalizeInput,
  args: Args,
  kind: MediaAsset['kind'],
  fps: number,
  durationInFrames: number,
): Promise<FinalizedSource> {
  let src = input.readUrl;
  let width = typeof args.width === 'number' && args.width > 0 ? args.width : undefined;
  let height = typeof args.height === 'number' && args.height > 0 ? args.height : undefined;
  let finalSize = input.size;
  let normalized = false;
  if (kind === 'video' && input.readUrl.startsWith('/media/uploads/')) {
    const result = await normalizeVideoSrc(input.readUrl);
    src = result.src;
    width = result.width ?? width;
    height = result.height ?? height;
    finalSize = result.bytes ?? finalSize;
    normalized = Boolean(result.normalized);
    if (result.durationSeconds && result.durationSeconds > 0) {
      durationInFrames = Math.max(1, Math.round(result.durationSeconds * fps));
    }
  }
  const sourceRevision = input.sourceContentHash
    ? createMediaSourceRevision({ src: input.readUrl, sourceContentHash: input.sourceContentHash })
    : createMediaSourceRevision({
      src, name: input.filename, kind, sourceSize: finalSize,
      durationInFrames, width, height,
    });
  return { src, width, height, finalSize, durationInFrames, normalized, sourceRevision };
}

function enqueueFinalizeTranscription(finalize: FinalizeContext, asset: MediaAsset): void {
  finalize.ctx.commands.setAssetTranscription(asset.id, {
    transcribeStatus: 'running',
    transcribeError: undefined,
  });
  enqueueTranscription(finalize.projectId!, asset, { asrPath: finalize.asrPath });
}

function existingFinalizeResult(
  finalize: FinalizeContext,
  existing: MediaAsset,
  needsAsr: boolean,
): Record<string, unknown> {
  const { input, kind, source } = finalize;
  return {
    ok: true,
    sessionId: input.sessionId,
    alreadyRegistered: true,
    replacedExistingAsset: true,
    assetId: existing.id,
    name: input.filename,
    type: kind,
    src: source.src,
    fileKey: source.src.startsWith('/media/uploads/')
      ? `uploads/${source.src.slice('/media/uploads/'.length)}`
      : input.fileKey,
    size: source.finalSize,
    contentHash: input.sourceContentHash,
    sourceRevision: source.sourceRevision,
    sourceContentHash: input.sourceContentHash,
    normalized: source.normalized || undefined,
    durationInFrames: source.durationInFrames,
    width: source.width ?? existing.width,
    height: source.height ?? existing.height,
    transcription: needsAsr ? 'started' : existing.transcribeStatus === 'done' ? 'ready' : undefined,
    next: needsAsr
      ? `ASR started. Call track_progress action=wait target=transcription assetIds=${existing.id} before transcript tools.`
      : undefined,
    note: 'Existing asset replaced from a verified import receipt.',
  };
}

function finalizeExisting(finalize: FinalizeContext, existing: MediaAsset): Record<string, unknown> {
  const { ctx, input, kind, source } = finalize;
  const relink = source.src !== existing.src || source.width !== existing.width
    || source.height !== existing.height || source.durationInFrames !== existing.durationInFrames
    || input.filename !== existing.name || input.filename !== existing.sourceFilename
    || existing.originalFilePath !== undefined || source.sourceRevision !== existing.sourceRevision
    || input.sourceContentHash !== existing.sourceContentHash;
  if (relink) {
    ctx.commands.relinkMediaAsset(existing.id, {
      src: source.src,
      name: input.filename,
      sourceFilename: input.filename,
      originalFilePath: undefined,
      durationInFrames: source.durationInFrames,
      width: source.width ?? existing.width,
      height: source.height ?? existing.height,
      kind,
      sourceRevision: source.sourceRevision,
      sourceContentHash: input.sourceContentHash,
      sourceSize: source.finalSize,
    });
  }
  const needsAsr = finalize.hasAudio && (
    source.sourceRevision !== existing.sourceRevision
    || existing.transcribeStatus !== 'done'
    || !hasOperationalTranscript(existing)
  );
  if (needsAsr) enqueueFinalizeTranscription(finalize, {
    ...existing,
    src: source.src,
    name: input.filename,
    kind,
    sourceRevision: source.sourceRevision,
    sourceContentHash: input.sourceContentHash,
    sourceSize: source.finalSize,
    durationInFrames: source.durationInFrames,
    width: source.width,
    height: source.height,
  });
  return existingFinalizeResult(finalize, existing, needsAsr);
}

function newFinalizeResult(finalize: FinalizeContext, asset: MediaAsset): Record<string, unknown> {
  const { input, kind, source } = finalize;
  return {
    ok: true,
    sessionId: input.sessionId,
    assetId: asset.id,
    name: asset.name,
    type: kind,
    sourceType: input.type,
    src: asset.src,
    fileKey: source.src.startsWith('/media/uploads/')
      ? `uploads/${source.src.slice('/media/uploads/'.length)}`
      : input.fileKey,
    size: source.finalSize,
    contentHash: input.sourceContentHash,
    sourceRevision: source.sourceRevision,
    sourceContentHash: input.sourceContentHash,
    normalized: source.normalized || undefined,
    durationInFrames: asset.durationInFrames,
    width: asset.width,
    height: asset.height,
    transcription: finalize.hasAudio ? 'started' : undefined,
    next: finalize.hasAudio
      ? `ASR started (上传即转写). Call track_progress action=wait target=transcription assetIds=${asset.id} before find_transcript / clean_script / delete_text / edit_captions / apply_script.`
      : undefined,
    note: 'Asset registered in media pool (local-dev finalize).',
  };
}

function finalizeNew(finalize: FinalizeContext): Record<string, unknown> {
  const { ctx, input, kind, source } = finalize;
  const asset: MediaAsset = {
    id: input.assetId,
    name: input.filename,
    sourceFilename: input.filename,
    kind,
    src: source.src,
    durationInFrames: source.durationInFrames,
    sourceRevision: source.sourceRevision,
    sourceContentHash: input.sourceContentHash,
    sourceSize: source.finalSize,
    width: source.width,
    height: source.height,
    transcribeStatus: finalize.hasAudio ? 'running' : undefined,
  };
  ctx.commands.addAsset(asset);
  if (finalize.hasAudio) enqueueTranscription(finalize.projectId!, asset, { asrPath: finalize.asrPath });
  return newFinalizeResult(finalize, asset);
}

export async function execFinalizeUpload(
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  const input = await resolveFinalizeInput(args, ctx);
  if ('error' in input) return input;
  const kind = mapUploadKind(input.type);
  if (!kind) return { error: `unsupported type ${input.type}` };
  const fps = ctx.getState().fps || 30;
  const durationInFrames = durationForFinalize(args, kind, input.type, fps);
  if (durationInFrames === null) return { error: 'durationInSeconds is required for audio/video/gif' };
  const hasAudio = shouldTranscribe(
    kind,
    typeof args.hasAudioTrack === 'boolean' ? args.hasAudioTrack : undefined,
  );
  const projectId = ctx.getProjectId?.();
  if (hasAudio && !projectId) return { error: 'transcription requires a persisted project id' };
  const contentRevision = input.sourceContentHash
    ? createMediaSourceRevision({ src: input.readUrl, sourceContentHash: input.sourceContentHash })
    : undefined;
  const asrPath = hasAudio && input.readUrl.startsWith('/media/uploads/')
    ? extractAudioForAsr(input.readUrl).catch(() => null)
    : Promise.resolve(null);
  const source = await finalizedSource(input, args, kind, fps, durationInFrames);
  if (contentRevision && source.sourceRevision !== contentRevision) {
    throw new Error('content-derived source revision changed during finalize');
  }
  const finalize = { input, kind, source, hasAudio, projectId, asrPath, ctx };
  const existing = findUploadAsset(ctx, input.assetId);
  return existing ? finalizeExisting(finalize, existing) : finalizeNew(finalize);
}
