import { createMediaSourceRevision } from '../../editor/mediaSourceRevision';
import type { MediaAsset } from '../../editor/types';
import { safeSourceFilename } from '../../media/sourceFilename';
import {
  saveUploadFinalizeJournal,
  type UploadFinalizeAsset,
  type UploadFinalizeIdentity,
  type UploadFinalizeJournal,
} from '../../persist/uploadFinalizeStore';
import type { AgentContext } from '../context';
import {
  findUploadAsset,
  isUploadSourceType,
  mapUploadKind,
} from './upload-handoff-tools';
import {
  applyJournalMutation,
  confirmReceiptCommit,
  createFinalizeJournal,
  mutationMatchesProject,
  postReceiptAction,
  receiptCommitKey,
  receiptCommitResult,
  renewFinalizeClaim,
  resumeReceiptCommit,
  scheduleReceiptReconciliation,
  settleReceipt,
  withReceiptCommitLock,
  type PreparedFinalize,
} from './upload-finalize-journal';

type Args = Record<string, unknown>;

type FinalizeInput = UploadFinalizeIdentity;

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
  offersTranscription: boolean;
  ctx: AgentContext;
}

function validateFinalizeArgs(args: Args): { receipt: string; error?: string } {
  const receipt = typeof args.receipt === 'string' ? args.receipt.trim() : '';
  if (!receipt) return { receipt, error: 'receipt is required' };
  if (!isUploadSourceType(args.assetType)) {
    return { receipt, error: 'assetType must be audio, gif, image, svg, or video' };
  }
  const needsDuration = args.assetType === 'audio' || args.assetType === 'gif' || args.assetType === 'video';
  if (needsDuration && (
    typeof args.durationInSeconds !== 'number'
    || !Number.isFinite(args.durationInSeconds)
    || args.durationInSeconds <= 0
  )) {
    return { receipt, error: 'durationInSeconds is required for audio/video/gif and must be positive' };
  }
  for (const field of ['durationInSeconds', 'width', 'height', 'fps'] as const) {
    const value = args[field];
    if (value !== undefined && (
      typeof value !== 'number' || !Number.isFinite(value) || value <= 0
    )) {
      return { receipt, error: `${field} must be a positive finite number` };
    }
  }
  return { receipt };
}

async function claimFinalizeInput(
  receipt: string,
  projectId: string,
): Promise<FinalizeInput | { error: string }> {
  const requestedClaimId = (
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `claim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  ).padEnd(32, '_').slice(0, 64);
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
    try {
      response = await postReceiptAction({
        action: 'claim',
        receipt,
        projectId,
        claimId: requestedClaimId,
      });
    } catch {
      // Retrying the same claim id is server-idempotent.
    }
  }
  if (!response) {
    await postReceiptAction({
      action: 'abort',
      receipt,
      projectId,
      claimId: requestedClaimId,
    }).catch(() => null);
    return { error: 'upload receipt claim request failed' };
  }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value)) {
    await postReceiptAction({
      action: 'abort',
      receipt,
      projectId,
      claimId: requestedClaimId,
    }).catch(() => null);
    const message = value && typeof value === 'object' && !Array.isArray(value)
      && typeof (value as Record<string, unknown>).error === 'string'
      ? (value as Record<string, unknown>).error as string
      : 'upload receipt is invalid, expired, consumed, or outside this project';
    return { error: message };
  }
  const record = value as Record<string, unknown>;
  const filename = safeSourceFilename(record.filename);
  const claimId = typeof record.claimId === 'string' ? record.claimId : '';
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const assetId = typeof record.assetId === 'string' ? record.assetId : '';
  const fileKey = typeof record.fileKey === 'string' ? record.fileKey : '';
  const readUrl = typeof record.readUrl === 'string' ? record.readUrl : '';
  const size = typeof record.size === 'number' ? record.size : NaN;
  const sourceContentHash = typeof record.contentHash === 'string'
    && /^[a-f0-9]{64}$/.test(record.contentHash) ? record.contentHash : null;
  const type = isUploadSourceType(record.type) ? record.type : null;
  const validClaimId = /^[A-Za-z0-9_-]{32,64}$/.test(claimId) && claimId === requestedClaimId;
  const claimExpiresAt = typeof record.claimExpiresAt === 'number' ? record.claimExpiresAt : NaN;
  if (!validClaimId
    || !/^sess_[A-Za-z0-9_-]+$/.test(sessionId)
    || !/^[A-Za-z0-9_-]{1,80}$/.test(assetId)
    || !filename || filename !== record.filename || record.projectId !== projectId
    || !/^uploads\/[A-Za-z0-9._-]+$/.test(fileKey)
    || readUrl !== `/media/${fileKey}` || !Number.isSafeInteger(size) || size <= 0
    || !Number.isFinite(claimExpiresAt) || claimExpiresAt <= Date.now()
    || !type || !sourceContentHash) {
    await postReceiptAction({
      action: 'abort',
      receipt,
      projectId,
      claimId: requestedClaimId,
    }).catch(() => null);
    return { error: 'trusted upload receipt returned invalid media identity' };
  }
  return {
    receipt, claimId, claimExpiresAt, projectId, sessionId, assetId, fileKey, filename, readUrl, size,
    type, sourceContentHash,
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

function finalizeAsset(finalize: FinalizeContext, existing?: MediaAsset): UploadFinalizeAsset {
  const { input, kind, source } = finalize;
  return {
    id: input.assetId,
    name: input.filename,
    sourceFilename: input.filename,
    kind,
    src: source.src,
    durationInFrames: source.durationInFrames,
    sourceRevision: source.sourceRevision,
    sourceContentHash: input.sourceContentHash,
    sourceSize: source.finalSize,
    width: source.width ?? existing?.width,
    height: source.height ?? existing?.height,
  };
}

function existingFinalizeResult(
  finalize: FinalizeContext,
  asset: UploadFinalizeAsset,
): Record<string, unknown> {
  const { input, source } = finalize;
  return {
    ok: true, sessionId: input.sessionId, alreadyRegistered: true,
    replacedExistingAsset: true, assetId: asset.id, name: asset.name, type: asset.kind,
    src: asset.src, fileKey: `uploads/${asset.src.slice('/media/uploads/'.length)}`,
    size: asset.sourceSize, contentHash: input.sourceContentHash,
    sourceRevision: asset.sourceRevision, sourceContentHash: input.sourceContentHash,
    normalized: source.normalized || undefined, durationInFrames: asset.durationInFrames,
    width: asset.width, height: asset.height,
    transcription: finalize.offersTranscription ? 'not_started' : undefined,
    next: finalize.offersTranscription
      ? `No transcription was started. If transcription is desired, place asset ${asset.id} on an audio/video track and invoke transcribe_track for that track.`
      : undefined,
    note: 'Existing asset replaced from a verified import receipt.',
  };
}

function newFinalizeResult(
  finalize: FinalizeContext,
  asset: UploadFinalizeAsset,
): Record<string, unknown> {
  const { input, source } = finalize;
  return {
    ok: true, sessionId: input.sessionId, assetId: asset.id, name: asset.name,
    type: asset.kind, sourceType: input.type, src: asset.src,
    fileKey: `uploads/${asset.src.slice('/media/uploads/'.length)}`,
    size: asset.sourceSize, contentHash: input.sourceContentHash,
    sourceRevision: asset.sourceRevision, sourceContentHash: input.sourceContentHash,
    normalized: source.normalized || undefined, durationInFrames: asset.durationInFrames,
    width: asset.width, height: asset.height,
    transcription: finalize.offersTranscription ? 'not_started' : undefined,
    next: finalize.offersTranscription
      ? `No transcription was started. If transcription is desired, place asset ${asset.id} on an audio/video track and invoke transcribe_track for that track.`
      : undefined,
    note: 'Asset registered in media pool (local-dev finalize).',
  };
}

function prepareFinalize(finalize: FinalizeContext, existing: MediaAsset | null): PreparedFinalize {
  const asset = finalizeAsset(finalize, existing ?? undefined);
  if (!existing) {
    return { mutation: { type: 'add', asset }, result: newFinalizeResult(finalize, asset) };
  }
  const relink = asset.src !== existing.src || asset.width !== existing.width
    || asset.height !== existing.height || asset.durationInFrames !== existing.durationInFrames
    || asset.name !== existing.name || asset.sourceFilename !== existing.sourceFilename
    || existing.originalFilePath !== undefined || asset.sourceRevision !== existing.sourceRevision
    || asset.sourceContentHash !== existing.sourceContentHash
    || asset.sourceSize !== existing.sourceSize || asset.kind !== existing.kind;
  return {
    mutation: { type: relink ? 'relink' : 'none', asset },
    result: existingFinalizeResult(finalize, asset),
  };
}

async function prepareClaimedFinalize(
  args: Args,
  ctx: AgentContext,
  input: FinalizeInput,
): Promise<UploadFinalizeJournal> {
  if (args.assetType !== input.type) {
    throw new Error(`assetType does not match the trusted upload receipt (${input.type})`);
  }
  const kind = mapUploadKind(input.type);
  if (!kind) throw new Error(`unsupported type ${input.type}`);
  const fps = ctx.getState().fps || 30;
  const durationInFrames = durationForFinalize(args, kind, input.type, fps);
  if (durationInFrames === null) throw new Error('durationInSeconds is required for audio/video/gif');
  const source = await finalizedSource(input, args, kind, fps, durationInFrames);
  const expectedRevision = createMediaSourceRevision({
    src: input.readUrl, sourceContentHash: input.sourceContentHash,
  });
  if (source.sourceRevision !== expectedRevision) {
    throw new Error('content-derived source revision changed during finalize');
  }
  const claimExpiresAt = await renewFinalizeClaim(input);
  if (claimExpiresAt === null) {
    throw new Error('upload receipt claim expired or was superseded before asset commit');
  }
  const renewedInput = { ...input, claimExpiresAt };
  const offersTranscription = kind === 'audio'
    || (kind === 'video' && args.hasAudioTrack !== false);
  const finalize = { input: renewedInput, kind, source, offersTranscription, ctx };
  return createFinalizeJournal(renewedInput, prepareFinalize(
    finalize,
    findUploadAsset(ctx, input.assetId),
  ));
}

async function executeClaimedFinalize(
  args: Args,
  ctx: AgentContext,
  input: FinalizeInput,
): Promise<Record<string, unknown>> {
  let journal: UploadFinalizeJournal | null = null;
  let journalSaved = false;
  try {
    journal = await prepareClaimedFinalize(args, ctx, input);
    await saveUploadFinalizeJournal(journal);
    journalSaved = true;
    const applied = await applyJournalMutation(journal, ctx);
    const confirmation = await confirmReceiptCommit(applied, false);
    if (!confirmation.committed) scheduleReceiptReconciliation(confirmation.journal, ctx);
    return receiptCommitResult(applied.result, confirmation.committed
      ? 'committed' : 'reconciliation_pending');
  } catch (error) {
    if (journalSaved && journal && mutationMatchesProject(journal.mutation, ctx)) {
      scheduleReceiptReconciliation(journal, ctx);
      return receiptCommitResult(journal.result, 'reconciliation_pending');
    }
    if (!journalSaved) await settleReceipt(input, 'abort');
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function execFinalizeUploadLocked(
  args: Args,
  ctx: AgentContext,
  receipt: string,
  projectId: string,
): Promise<unknown> {
  try {
    const resumed = await resumeReceiptCommit(receipt, projectId, ctx);
    if (resumed) return resumed;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const input = await claimFinalizeInput(receipt, projectId);
  return 'error' in input ? input : executeClaimedFinalize(args, ctx, input);
}

export async function execFinalizeUpload(
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  const preliminary = validateFinalizeArgs(args);
  if (preliminary.error) return { error: preliminary.error };
  const projectId = ctx.getProjectId?.();
  if (!projectId) return { error: 'a persisted project is required to finalize an upload receipt' };
  const key = receiptCommitKey({ receipt: preliminary.receipt, projectId });
  return withReceiptCommitLock(
    key,
    () => execFinalizeUploadLocked(args, ctx, preliminary.receipt, projectId),
  );
}
