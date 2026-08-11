import { randomBytes } from 'node:crypto';
import { safeSourceFilename } from '../../src/media/sourceFilename.ts';
import { externalUploadMediaType } from '../../src/media/uploadMediaType.ts';

export type ImportUploadMethod = 'POST' | 'PUT';
export type ImportAssetType = 'audio' | 'gif' | 'image' | 'svg' | 'video';

export interface ImportTokenScope {
  sessionId: string;
  assetId: string;
  assetType: ImportAssetType;
  filename: string;
  projectId: string;
  method: ImportUploadMethod;
  contentType: string;
  expectedBytes: number;
}
export interface ImportTokenUse {
  sessionId: string;
  assetId: string;
  assetType: ImportAssetType;
  filename: string;
  projectId: string;
  method: ImportUploadMethod;
  contentType: string;
}
export interface ImportTokenMint { token: string; expiresAt: number }
export type ImportTokenConsumeResult =
  | { status: 'accepted'; scope: ImportTokenScope }
  | { status: 'expired' | 'invalid' | 'mismatch' };
interface ImportTokenEntry extends ImportTokenScope { expiresAt: number }
interface RegistryOptions { maxEntries?: number; ttlMs?: number; now?: () => number; createToken?: () => string }

const DEFAULT_MAX_ENTRIES = 1_024;
const DEFAULT_TTL_MS = 5 * 60_000;
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const ASSET_TYPES: Readonly<Record<ImportAssetType, true>> = { audio: true, gif: true, image: true, svg: true, video: true };
const METHODS: Readonly<Record<ImportUploadMethod, true>> = { POST: true, PUT: true };
const HANDOFF_QUERY_KEYS: Readonly<Record<string, true>> = {
  name: true, sessionId: true, assetId: true, assetType: true, projectId: true, handoff: true,
};

export function normalizedContentType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.split(';', 1)[0]!.trim().toLowerCase();
  return normalized.length <= 200 && CONTENT_TYPE_PATTERN.test(normalized) ? normalized : null;
}
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}
export function isSafeImportFilename(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255
    && safeSourceFilename(value) === value && !hasControlCharacter(value);
}
function normalizeScope(scope: ImportTokenScope): ImportTokenScope {
  if (!SESSION_ID_PATTERN.test(scope.sessionId)) throw new Error('invalid import session id');
  if (!ASSET_ID_PATTERN.test(scope.assetId)) throw new Error('invalid import asset id');
  if (ASSET_TYPES[scope.assetType] !== true) throw new Error('invalid import asset type');
  if (!isSafeImportFilename(scope.filename)) throw new Error('invalid import filename');
  if (!PROJECT_ID_PATTERN.test(scope.projectId)) throw new Error('invalid import project id');
  if (METHODS[scope.method] !== true) throw new Error('invalid import upload method');
  const contentType = normalizedContentType(scope.contentType);
  const mediaType = externalUploadMediaType(scope.assetType, contentType);
  if (!contentType || !mediaType) throw new Error('invalid import asset type or content type');
  if (!Number.isSafeInteger(scope.expectedBytes) || scope.expectedBytes <= 0) throw new Error('invalid import expected byte size');
  return { ...scope, contentType: mediaType.contentType };
}
function importUseMatches(expected: ImportTokenScope, actual: ImportTokenUse): boolean {
  return expected.sessionId === actual.sessionId
    && expected.assetId === actual.assetId && expected.assetType === actual.assetType
    && expected.filename === actual.filename && expected.projectId === actual.projectId
    && expected.method === actual.method && expected.contentType === actual.contentType;
}

export class ImportTokenRegistry {
  readonly #entries = new Map<string, ImportTokenEntry>();
  readonly #maxEntries: number; readonly #ttlMs: number; readonly #now: () => number; readonly #createToken: () => string;
  constructor(options: RegistryOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#createToken = options.createToken ?? (() => randomBytes(32).toString('base64url'));
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) throw new Error('invalid token registry cap');
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) throw new Error('invalid token lifetime');
  }
  mint(scope: ImportTokenScope): ImportTokenMint {
    const normalized = normalizeScope(scope); const now = this.#now(); this.pruneExpired(now);
    if (this.#entries.size >= this.#maxEntries) throw new Error('import token capacity reached');
    let token = '';
    for (let attempt = 0; attempt < 4 && (!token || this.#entries.has(token)); attempt += 1) token = this.#createToken();
    if (!token || this.#entries.has(token)) throw new Error('could not create import token');
    const expiresAt = now + this.#ttlMs; this.#entries.set(token, { ...normalized, expiresAt });
    return { token, expiresAt };
  }
  consume(token: string, use: ImportTokenUse): ImportTokenConsumeResult {
    const entry = this.#entries.get(token);
    if (!entry) { this.pruneExpired(this.#now()); return { status: 'invalid' }; }
    this.#entries.delete(token);
    if (entry.expiresAt <= this.#now()) return { status: 'expired' };
    const contentType = normalizedContentType(use.contentType);
    if (!SESSION_ID_PATTERN.test(use.sessionId) || !ASSET_ID_PATTERN.test(use.assetId)
      || ASSET_TYPES[use.assetType] !== true || !isSafeImportFilename(use.filename)
      || !PROJECT_ID_PATTERN.test(use.projectId) || METHODS[use.method] !== true
      || !contentType) return { status: 'mismatch' };
    if (!importUseMatches(entry, { ...use, contentType })) return { status: 'mismatch' };
    const { expiresAt: _expiresAt, ...scope } = entry;
    return { status: 'accepted', scope };
  }
  pruneExpired(now = this.#now()): number {
    let removed = 0;
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt > now) continue;
      this.#entries.delete(token); removed += 1;
    }
    return removed;
  }
  get size(): number { return this.#entries.size; }
}

export function parseImportTokenScope(value: Record<string, unknown>): ImportTokenScope {
  const allowedKeys: Readonly<Record<string, true>> = {
    sessionId: true, assetId: true, assetType: true, filename: true, projectId: true,
    method: true, contentType: true, expectedBytes: true,
  };
  if (Object.keys(value).some((key) => allowedKeys[key] !== true)) {
    throw new Error('invalid import token request');
  }
  const scope = normalizeScope(value as unknown as ImportTokenScope);
  if (scope.method !== 'POST') throw new Error('invalid import token request');
  return scope;
}
const importTokens = new ImportTokenRegistry();
export function mintImportToken(scope: ImportTokenScope): ImportTokenMint {
  return importTokens.mint(scope);
}
export function mintImportUpload(value: Record<string, unknown>) {
  const scope = parseImportTokenScope(value); const minted = importTokens.mint(scope);
  return {
    uploadUrl: importUploadUrl(scope, minted.token), expiresAt: minted.expiresAt,
    expiresInSeconds: Math.max(0, Math.ceil((minted.expiresAt - Date.now()) / 1_000)), allowedMethods: [scope.method],
  };
}
export function importUploadUrl(scope: ImportTokenScope, token: string): string {
  const query = new URLSearchParams({
    name: scope.filename,
    sessionId: scope.sessionId,
    assetId: scope.assetId,
    assetType: scope.assetType,
    projectId: scope.projectId,
    handoff: token,
  });
  return `/upload?${query.toString()}`;
}
function validHandoffQuery(query: URLSearchParams): boolean {
  const seen: Record<string, true> = {};
  for (const key of query.keys()) {
    if (HANDOFF_QUERY_KEYS[key] !== true || seen[key]) return false;
    seen[key] = true;
  }
  return true;
}
export function authorizeImportUpload(url: URL, method: string | undefined, contentType: string | undefined): ImportTokenConsumeResult {
  if (!url.searchParams.has('handoff') || !validHandoffQuery(url.searchParams)) return { status: 'invalid' };
  return importTokens.consume(url.searchParams.get('handoff') ?? '', {
    sessionId: url.searchParams.get('sessionId') ?? '',
    assetId: url.searchParams.get('assetId') ?? '', assetType: url.searchParams.get('assetType') as ImportAssetType,
    filename: url.searchParams.get('name') ?? '', projectId: url.searchParams.get('projectId') ?? '',
    method: method as ImportUploadMethod, contentType: contentType ?? '',
  });
}

export interface UploadReceiptValue {
  receipt: string; sessionId: string; assetId: string; filename: string; projectId: string;
  fileKey: string; readUrl: string; size: number; type: ImportAssetType;
  contentType: string; contentHash: string;
}
interface ReceiptClaim { id: string; expiresAt: number }
interface ReceiptEntry extends Omit<UploadReceiptValue, 'receipt'> {
  expiresAt: number;
  claim?: ReceiptClaim;
  committedClaimId?: string;
  committedExpiresAt?: number;
}
export type UploadReceiptClaimResult =
  | {
    status: 'accepted';
    claimId: string;
    claimExpiresAt: number;
    value: UploadReceiptValue;
  }
  | { status: 'invalid' | 'expired' | 'mismatch' | 'claimed' | 'consumed' };
const uploadReceipts = new Map<string, ReceiptEntry>();
const RECEIPT_TTL_MS = 10 * 60_000;
const RECEIPT_CLAIM_TTL_MS = 5 * 60_000;
const RECEIPT_MAX_ENTRIES = 1_024;
function pruneUploadReceipts(now = Date.now()): void {
  for (const [receipt, entry] of uploadReceipts) {
    const activeClaim = entry.claim && entry.claim.expiresAt > now;
    const activeCommitTombstone = entry.committedClaimId
      && (entry.committedExpiresAt ?? entry.expiresAt) > now;
    if (entry.expiresAt <= now && !activeClaim && !activeCommitTombstone) {
      uploadReceipts.delete(receipt);
    }
  }
}
export function mintUploadReceipt(
  scope: ImportTokenScope,
  uploaded: { path: string; fileKey: string; bytes: number; contentHash: string },
): string {
  if (uploaded.bytes !== scope.expectedBytes || !/^[a-f0-9]{64}$/.test(uploaded.contentHash)) {
    throw new Error('uploaded media identity does not match handoff scope');
  }
  pruneUploadReceipts();
  if (uploadReceipts.size >= RECEIPT_MAX_ENTRIES) {
    throw new Error('upload receipt capacity reached');
  }
  const receipt = randomBytes(32).toString('base64url');
  uploadReceipts.set(receipt, {
    sessionId: scope.sessionId, assetId: scope.assetId, filename: scope.filename,
    projectId: scope.projectId, fileKey: uploaded.fileKey, readUrl: uploaded.path,
    size: uploaded.bytes, type: scope.assetType, contentType: scope.contentType,
    contentHash: uploaded.contentHash, expiresAt: Date.now() + RECEIPT_TTL_MS,
  });
  return receipt;
}

/**
 * Reserve a receipt while the editor validates and normalizes its media. New
 * claims are accepted only before the original receipt expiry; an acquired
 * claim may renew its bounded lease while it remains current, including after
 * receipt expiry. A retry with the same caller-issued claim id is idempotent.
 * Abort recoverable failures.
 */
export function claimUploadReceipt(
  receipt: unknown,
  projectId: unknown,
  requestedClaimId?: unknown,
): UploadReceiptClaimResult {
  if (typeof receipt !== 'string' || typeof projectId !== 'string') return { status: 'invalid' };
  if (requestedClaimId !== undefined && (
    typeof requestedClaimId !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(requestedClaimId)
  )) return { status: 'invalid' };
  const entry = uploadReceipts.get(receipt);
  if (!entry) {
    pruneUploadReceipts();
    return { status: 'invalid' };
  }
  const now = Date.now();
  const claimId = requestedClaimId ?? randomBytes(32).toString('base64url');
  if (entry.projectId !== projectId) return { status: 'mismatch' };
  if (entry.committedClaimId) {
    if ((entry.committedExpiresAt ?? entry.expiresAt) > now) return { status: 'consumed' };
    uploadReceipts.delete(receipt);
    return { status: 'expired' };
  }
  if (entry.expiresAt <= now) {
    if (entry.claim && entry.claim.expiresAt > now) {
      if (entry.claim.id !== claimId) return { status: 'claimed' };
      const claimExpiresAt = now + RECEIPT_CLAIM_TTL_MS;
      entry.claim.expiresAt = claimExpiresAt;
      const {
        expiresAt: _expiresAt,
        claim: _claim,
        committedClaimId: _committed,
        committedExpiresAt: _committedExpiry,
        ...value
      } = entry;
      return {
        status: 'accepted',
        claimId,
        claimExpiresAt,
        value: { receipt, ...value },
      };
    }
    uploadReceipts.delete(receipt);
    return { status: 'expired' };
  }
  if (entry.claim && entry.claim.id !== claimId && entry.claim.expiresAt > now) {
    return { status: 'claimed' };
  }
  const claimExpiresAt = now + RECEIPT_CLAIM_TTL_MS;
  entry.claim = { id: claimId, expiresAt: claimExpiresAt };
  const {
    expiresAt: _expiresAt,
    claim: _claim,
    committedClaimId: _committed,
    committedExpiresAt: _committedExpiry,
    ...value
  } = entry;
  return {
    status: 'accepted',
    claimId,
    claimExpiresAt,
    value: { receipt, ...value },
  };
}

/** Terminally consume a claimed receipt. Repeating the same commit is idempotent. */
export function commitUploadReceipt(
  receipt: unknown,
  projectId: unknown,
  claimId: unknown,
): boolean {
  if (typeof receipt !== 'string' || typeof projectId !== 'string' || typeof claimId !== 'string') {
    return false;
  }
  const entry = uploadReceipts.get(receipt);
  if (!entry || entry.projectId !== projectId) return false;
  const now = Date.now();
  if (entry.committedClaimId) {
    return (entry.committedExpiresAt ?? entry.expiresAt) > now
      && entry.committedClaimId === claimId;
  }
  if (entry.claim?.id !== claimId || entry.claim.expiresAt <= now) return false;
  entry.committedClaimId = claimId;
  entry.committedExpiresAt = Math.max(entry.expiresAt, now + RECEIPT_CLAIM_TTL_MS);
  entry.claim = undefined;
  return true;
}

/** Release a matching in-flight claim without consuming the receipt. */
export function abortUploadReceipt(
  receipt: unknown,
  projectId: unknown,
  claimId: unknown,
): boolean {
  if (typeof receipt !== 'string' || typeof projectId !== 'string' || typeof claimId !== 'string') {
    return false;
  }
  const entry = uploadReceipts.get(receipt);
  if (!entry || entry.projectId !== projectId || entry.committedClaimId
    || entry.claim?.id !== claimId || entry.claim.expiresAt <= Date.now()) return false;
  entry.claim = undefined;
  return true;
}
