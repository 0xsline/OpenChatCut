import type { MediaAssetKind } from '../editor/types';
import { isProjectStoreRecord } from '../../shared/project-store-validation';
import { kvDel, kvGet, kvSet } from './sharedKv';

export interface UploadFinalizeIdentity {
  receipt: string;
  claimId: string;
  claimExpiresAt: number;
  projectId: string;
  sessionId: string;
  assetId: string;
  fileKey: string;
  filename: string;
  readUrl: string;
  size: number;
  type: 'audio' | 'gif' | 'image' | 'svg' | 'video';
  sourceContentHash: string;
}

export interface UploadFinalizeAsset {
  id: string;
  name: string;
  sourceFilename: string;
  kind: MediaAssetKind;
  src: string;
  durationInFrames: number;
  sourceRevision: string;
  sourceContentHash: string;
  sourceSize: number;
  width?: number;
  height?: number;
}

export interface UploadFinalizeMutation {
  type: 'add' | 'relink' | 'none';
  asset: UploadFinalizeAsset;
}

export interface UploadFinalizeJournal {
  version: 1;
  identity: UploadFinalizeIdentity;
  mutation: UploadFinalizeMutation;
  result: Record<string, unknown>;
  effectiveHash: string;
  status: 'prepared' | 'mutation_applied';
  createdAt: number;
}

const PROJECT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const HASH = /^[a-f0-9]{64}$/;

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isProjectStoreRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => (
    value[key] === undefined ? [] : [[key, canonicalValue(value[key])]]
  )));
}

async function journalKey(projectId: string, receipt: string): Promise<string> {
  if (!PROJECT_ID.test(projectId)) throw new Error('Invalid upload finalize project id.');
  return `upload-finalize:${projectId}:${await sha256Text(receipt)}`;
}

function parseJournal(raw: unknown): UploadFinalizeJournal | null {
  if (!isProjectStoreRecord(raw) || raw.version !== 1 || !isProjectStoreRecord(raw.identity)
    || !isProjectStoreRecord(raw.mutation) || !isProjectStoreRecord(raw.mutation.asset)
    || !isProjectStoreRecord(raw.result)
    || (raw.status !== 'prepared' && raw.status !== 'mutation_applied')
    || typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)
    || typeof raw.effectiveHash !== 'string' || !HASH.test(raw.effectiveHash)) return null;
  return raw as unknown as UploadFinalizeJournal;
}

export async function uploadFinalizeEffectiveHash(
  journal: Pick<UploadFinalizeJournal, 'identity' | 'mutation' | 'result'>,
): Promise<string> {
  const { claimExpiresAt: _claimExpiresAt, ...immutableIdentity } = journal.identity;
  const serialized = JSON.stringify(canonicalValue({
    identity: immutableIdentity,
    mutation: journal.mutation,
    result: journal.result,
  }));
  if (serialized === undefined) throw new Error('Upload finalize journal is not serializable.');
  return sha256Text(serialized);
}

export async function loadUploadFinalizeJournal(
  projectId: string,
  receipt: string,
): Promise<UploadFinalizeJournal | null> {
  const raw = await kvGet<unknown>(await journalKey(projectId, receipt));
  if (raw === undefined) return null;
  const journal = parseJournal(raw);
  if (!journal || journal.identity.projectId !== projectId || journal.identity.receipt !== receipt
    || journal.effectiveHash !== await uploadFinalizeEffectiveHash(journal)) {
    throw new Error('Stored upload finalize journal failed its integrity check.');
  }
  return journal;
}

export async function saveUploadFinalizeJournal(journal: UploadFinalizeJournal): Promise<void> {
  if (!parseJournal(journal)
    || journal.effectiveHash !== await uploadFinalizeEffectiveHash(journal)) {
    throw new Error('Upload finalize journal failed its integrity check.');
  }
  await kvSet(await journalKey(journal.identity.projectId, journal.identity.receipt), journal);
}

export async function deleteUploadFinalizeJournal(projectId: string, receipt: string): Promise<void> {
  await kvDel(await journalKey(projectId, receipt));
}
