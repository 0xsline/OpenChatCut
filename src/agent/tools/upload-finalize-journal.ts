import { createMediaSourceRevision } from '../../editor/mediaSourceRevision';
import { safeSourceFilename } from '../../media/sourceFilename';
import {
  deleteUploadFinalizeJournal,
  loadUploadFinalizeJournal,
  saveUploadFinalizeJournal,
  uploadFinalizeEffectiveHash,
  type UploadFinalizeIdentity,
  type UploadFinalizeJournal,
  type UploadFinalizeMutation,
} from '../../persist/uploadFinalizeStore';
import type { AgentContext } from '../context';
import {
  findUploadAsset,
  isUploadSourceType,
  mapUploadKind,
} from './upload-handoff-tools';

export interface PreparedFinalize {
  mutation: UploadFinalizeMutation;
  result: Record<string, unknown>;
}

const receiptCommitQueues = new Map<string, Promise<void>>();
const reconcilingReceiptCommits = new Set<string>();

export const receiptCommitKey = (
  input: Pick<UploadFinalizeIdentity, 'projectId' | 'receipt'>,
) => `${input.projectId}\u0000${input.receipt}`;

export async function withReceiptCommitLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = receiptCommitQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const settled = run.then(() => undefined, () => undefined);
  receiptCommitQueues.set(key, settled);
  void settled.finally(() => {
    if (receiptCommitQueues.get(key) === settled) receiptCommitQueues.delete(key);
  });
  return run;
}

export async function postReceiptAction(body: Record<string, unknown>): Promise<Response> {
  return fetch('/api/external-agent/upload-receipt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function renewFinalizeClaim(input: UploadFinalizeIdentity): Promise<number | null> {
  const response = await postReceiptAction({
    action: 'claim', receipt: input.receipt, projectId: input.projectId, claimId: input.claimId,
  }).catch(() => null);
  if (!response?.ok) return null;
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const claimExpiresAt = typeof record.claimExpiresAt === 'number' ? record.claimExpiresAt : NaN;
  const sameIdentity = record.receipt === input.receipt && record.claimId === input.claimId
    && record.projectId === input.projectId && record.sessionId === input.sessionId
    && record.assetId === input.assetId && record.fileKey === input.fileKey
    && record.filename === input.filename && record.readUrl === input.readUrl
    && record.size === input.size && record.type === input.type
    && record.contentHash === input.sourceContentHash;
  return sameIdentity && Number.isFinite(claimExpiresAt) && claimExpiresAt > Date.now()
    ? claimExpiresAt
    : null;
}

export async function settleReceipt(
  input: Pick<UploadFinalizeIdentity, 'receipt' | 'claimId' | 'projectId'>,
  action: 'commit' | 'abort',
  attempts = 2,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await postReceiptAction({
        action, receipt: input.receipt, projectId: input.projectId, claimId: input.claimId,
      });
      if (!response.ok) return false;
      const value: unknown = await response.json().catch(() => null);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const expectedState = action === 'commit' ? 'committed' : 'available';
        if (record.ok === true && record.state === expectedState) return true;
      }
    } catch { /* Same-claim commit retries are safe against the terminal tombstone. */ }
  }
  return false;
}

export function receiptCommitResult(
  result: Record<string, unknown>,
  state: 'committed' | 'reconciliation_pending',
): Record<string, unknown> {
  if (state === 'committed') return { ...result, receiptCommit: state };
  return {
    ...result,
    receiptCommit: state,
    warning: 'Asset changes are committed; upload receipt confirmation is being reconciled.',
  };
}

function reconciliationDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function confirmReceiptCommit(
  journal: UploadFinalizeJournal,
  allowRenewal: boolean,
): Promise<{ journal: UploadFinalizeJournal; committed: boolean }> {
  if (await settleReceipt(journal.identity, 'commit')) {
    await deleteUploadFinalizeJournal(journal.identity.projectId, journal.identity.receipt);
    return { journal, committed: true };
  }
  if (!allowRenewal || Date.now() < journal.identity.claimExpiresAt) {
    return { journal, committed: false };
  }
  const claimExpiresAt = await renewFinalizeClaim(journal.identity);
  if (claimExpiresAt === null) return { journal, committed: false };
  const renewed = {
    ...journal,
    identity: { ...journal.identity, claimExpiresAt },
  };
  await saveUploadFinalizeJournal(renewed).catch(() => undefined);
  if (!await settleReceipt(renewed.identity, 'commit')) return { journal: renewed, committed: false };
  await deleteUploadFinalizeJournal(renewed.identity.projectId, renewed.identity.receipt);
  return { journal: renewed, committed: true };
}

export function mutationMatchesProject(
  mutation: UploadFinalizeMutation,
  ctx: AgentContext,
): boolean {
  if (mutation.type === 'none') return true;
  const existing = findUploadAsset(ctx, mutation.asset.id);
  if (!existing) return false;
  const asset = mutation.asset;
  return existing.id === asset.id && existing.name === asset.name
    && existing.sourceFilename === asset.sourceFilename && existing.kind === asset.kind
    && existing.src === asset.src && existing.durationInFrames === asset.durationInFrames
    && existing.sourceRevision === asset.sourceRevision
    && existing.sourceContentHash === asset.sourceContentHash
    && existing.sourceSize === asset.sourceSize && existing.width === asset.width
    && existing.height === asset.height && existing.originalFilePath === undefined;
}

function applyFinalizeMutation(mutation: UploadFinalizeMutation, ctx: AgentContext): void {
  if (mutation.type === 'none') return;
  const asset = mutation.asset;
  if (mutation.type === 'add') {
    ctx.commands.addAsset(asset);
    return;
  }
  ctx.commands.relinkMediaAsset(asset.id, {
    src: asset.src, name: asset.name, sourceFilename: asset.sourceFilename,
    originalFilePath: undefined, durationInFrames: asset.durationInFrames,
    width: asset.width, height: asset.height, kind: asset.kind,
    sourceRevision: asset.sourceRevision, sourceContentHash: asset.sourceContentHash,
    sourceSize: asset.sourceSize,
  });
}

function validJournalIdentity(identity: UploadFinalizeIdentity): boolean {
  return identity.receipt.length > 0 && identity.receipt.length <= 256
    && /^[A-Za-z0-9_-]{32,64}$/.test(identity.claimId)
    && /^[A-Za-z0-9_-]{1,160}$/.test(identity.projectId)
    && /^sess_[A-Za-z0-9_-]+$/.test(identity.sessionId)
    && /^[A-Za-z0-9_-]{1,80}$/.test(identity.assetId)
    && safeSourceFilename(identity.filename) === identity.filename
    && /^uploads\/[A-Za-z0-9._-]+$/.test(identity.fileKey)
    && identity.readUrl === `/media/${identity.fileKey}`
    && Number.isSafeInteger(identity.size) && identity.size > 0
    && isUploadSourceType(identity.type)
    && /^[a-f0-9]{64}$/.test(identity.sourceContentHash)
    && Number.isFinite(identity.claimExpiresAt);
}

function validJournalMutation(journal: UploadFinalizeJournal): boolean {
  const { identity, mutation } = journal;
  const asset = mutation.asset;
  return ['add', 'relink', 'none'].includes(mutation.type)
    && asset.id === identity.assetId && asset.name === identity.filename
    && asset.sourceFilename === identity.filename && asset.kind === mapUploadKind(identity.type)
    && /^\/media\/uploads\/[A-Za-z0-9._-]+$/.test(asset.src)
    && Number.isSafeInteger(asset.durationInFrames) && asset.durationInFrames > 0
    && asset.sourceRevision === createMediaSourceRevision({
      src: identity.readUrl, sourceContentHash: identity.sourceContentHash,
    })
    && asset.sourceContentHash === identity.sourceContentHash
    && Number.isSafeInteger(asset.sourceSize) && asset.sourceSize > 0
    && (asset.width === undefined || (Number.isFinite(asset.width) && asset.width > 0))
    && (asset.height === undefined || (Number.isFinite(asset.height) && asset.height > 0));
}

function validJournalResult(journal: UploadFinalizeJournal): boolean {
  const { identity, mutation, result } = journal;
  const asset = mutation.asset;
  return result.ok === true && result.sessionId === identity.sessionId
    && result.assetId === asset.id && result.name === asset.name && result.type === asset.kind
    && result.src === asset.src
    && result.fileKey === `uploads/${asset.src.slice('/media/uploads/'.length)}`
    && result.size === asset.sourceSize && result.contentHash === identity.sourceContentHash
    && result.sourceRevision === asset.sourceRevision
    && result.sourceContentHash === identity.sourceContentHash
    && result.durationInFrames === asset.durationInFrames
    && result.width === asset.width && result.height === asset.height
    && (result.transcription === undefined || result.transcription === 'not_started');
}

export function assertValidFinalizeJournal(journal: UploadFinalizeJournal): void {
  if (!validJournalIdentity(journal.identity)
    || !validJournalMutation(journal)
    || !validJournalResult(journal)) {
    throw new Error('Stored upload finalize journal contains invalid effective metadata.');
  }
}

export async function abortPreparedJournal(journal: UploadFinalizeJournal): Promise<void> {
  if (!await settleReceipt(journal.identity, 'abort')) return;
  await deleteUploadFinalizeJournal(journal.identity.projectId, journal.identity.receipt);
}

export async function applyJournalMutation(
  journal: UploadFinalizeJournal,
  ctx: AgentContext,
): Promise<UploadFinalizeJournal> {
  const matches = mutationMatchesProject(journal.mutation, ctx);
  if (matches && journal.status === 'mutation_applied') return journal;
  if (journal.status === 'mutation_applied') {
    const existing = findUploadAsset(ctx, journal.mutation.asset.id);
    if (journal.mutation.type !== 'add' || existing) {
      throw new Error('Upload finalize recovery found divergent project state; receipt remains reserved.');
    }
  }
  if (!matches) {
    try {
      applyFinalizeMutation(journal.mutation, ctx);
    } catch (error) {
      if (journal.status === 'prepared') await abortPreparedJournal(journal);
      throw error;
    }
  }
  const applied: UploadFinalizeJournal = { ...journal, status: 'mutation_applied' };
  await saveUploadFinalizeJournal(applied);
  return applied;
}

export async function createFinalizeJournal(
  input: UploadFinalizeIdentity,
  prepared: PreparedFinalize,
): Promise<UploadFinalizeJournal> {
  const base = {
    version: 1 as const,
    identity: { ...input },
    mutation: prepared.mutation,
    result: prepared.result,
    effectiveHash: '',
    status: 'prepared' as const,
    createdAt: Date.now(),
  };
  const journal = {
    ...base,
    effectiveHash: await uploadFinalizeEffectiveHash(base),
  };
  assertValidFinalizeJournal(journal);
  return journal;
}

export function scheduleReceiptReconciliation(
  journal: UploadFinalizeJournal,
  ctx: AgentContext,
): void {
  const key = receiptCommitKey(journal.identity);
  if (reconcilingReceiptCommits.has(key)) return;
  reconcilingReceiptCommits.add(key);
  void reconciliationDelay(100)
    .then(() => withReceiptCommitLock(key, async () => {
      const loaded = await loadUploadFinalizeJournal(
        journal.identity.projectId,
        journal.identity.receipt,
      );
      if (!loaded) return;
      assertValidFinalizeJournal(loaded);
      const applied = await applyJournalMutation(loaded, ctx);
      await confirmReceiptCommit(applied, false);
    }))
    .catch(() => undefined)
    .finally(() => reconcilingReceiptCommits.delete(key));
}

export async function resumeReceiptCommit(
  receipt: string,
  projectId: string,
  ctx: AgentContext,
): Promise<Record<string, unknown> | null> {
  const journal = await loadUploadFinalizeJournal(projectId, receipt);
  if (!journal) return null;
  assertValidFinalizeJournal(journal);
  try {
    const applied = await applyJournalMutation(journal, ctx);
    const confirmation = await confirmReceiptCommit(applied, true);
    if (!confirmation.committed) scheduleReceiptReconciliation(confirmation.journal, ctx);
    return receiptCommitResult(applied.result, confirmation.committed
      ? 'committed' : 'reconciliation_pending');
  } catch (error) {
    if (!mutationMatchesProject(journal.mutation, ctx)) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    scheduleReceiptReconciliation(journal, ctx);
    return receiptCommitResult(journal.result, 'reconciliation_pending');
  }
}
