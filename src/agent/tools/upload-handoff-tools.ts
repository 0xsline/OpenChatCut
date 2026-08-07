import type { MediaAsset } from '../../editor/types';
import { safeSourceFilename } from '../../media/sourceFilename';
import { externalUploadMediaType } from '../../media/uploadMediaType';
import type { AgentContext } from '../context';
import { mintUploadHandoff } from './upload-handoff';

type Args = Record<string, unknown>;
const ASSET_TYPES = ['audio', 'gif', 'image', 'svg', 'video'] as const;
type SourceAssetType = (typeof ASSET_TYPES)[number];

interface UploadHandoffError {
  error: string;
}

interface UploadHandoffResult extends Record<string, unknown> {
  assetId: string;
  filename: string;
  uploadUrl: string;
  expiresAt: number;
  expiresInSeconds: number;
}

const newId = (): string =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `a_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

export function mapUploadKind(type: string): MediaAsset['kind'] | null {
  switch (type) {
    case 'video':
    case 'audio':
    case 'image':
      return type;
    case 'gif':
    case 'svg':
      return 'image';
    default:
      return null;
  }
}

export function isUploadSourceType(value: unknown): value is SourceAssetType {
  return typeof value === 'string' && (ASSET_TYPES as readonly string[]).includes(value);
}

export function findUploadAsset(ctx: AgentContext, query: string): MediaAsset | null {
  const assets = ctx.getDoc().assets ?? ctx.getState().assets ?? [];
  const exact = assets.find((asset) => asset.id === query);
  if (exact) return exact;
  const hits = assets.filter((asset) => asset.id.startsWith(query));
  return hits.length === 1 ? hits[0]! : null;
}

async function requestUploadSlot(
  args: Args,
  ctx: AgentContext,
  sessionId: string,
): Promise<UploadHandoffResult | UploadHandoffError> {
  if (!isUploadSourceType(args.assetType)) {
    return { error: 'assetType must be audio|gif|image|svg|video' };
  }
  const contentType = String(args.contentType ?? '').trim();
  const filename = safeSourceFilename(args.filename);
  const mediaType = externalUploadMediaType(args.assetType, contentType);
  const size = Number(args.size);
  if (!mediaType) return { error: 'assetType and contentType must be a supported media pair' };
  if (!filename) return { error: 'filename must be a safe basename' };
  if (!Number.isSafeInteger(size) || size <= 0) {
    return { error: 'size must be a positive integer byte count' };
  }
  const projectId = ctx.getProjectId?.();
  if (!projectId) return { error: 'a persisted project is required for external upload handoff' };
  const requestedAssetId = typeof args.assetId === 'string' ? args.assetId.trim() : '';
  const existing = requestedAssetId ? findUploadAsset(ctx, requestedAssetId) : null;
  if (requestedAssetId && !existing) return { error: `asset not found: ${requestedAssetId}` };
  const kind = mapUploadKind(args.assetType);
  if (existing && kind !== existing.kind) {
    return { error: `asset ${existing.id} is ${existing.kind}, not ${kind}` };
  }
  const assetId = existing?.id ?? newId();
  const fileKey = `uploads/${assetId}${mediaType.extension}`;
  const readUrl = `/media/${fileKey}`;
  const handoff = await mintUploadHandoff(
    sessionId,
    assetId,
    args.assetType,
    filename,
    projectId,
    contentType,
    size,
  );
  return {
    ok: true,
    slotId: assetId,
    assetId,
    existingAsset: Boolean(existing),
    fileKey,
    readUrl,
    uploadUrl: handoff.uploadUrl,
    method: 'POST',
    allowedMethods: handoff.allowedMethods,
    expiresAt: handoff.expiresAt,
    expiresInSeconds: handoff.expiresInSeconds,
    headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
    contentType,
    filename,
    size,
    assetType: args.assetType,
    state: 'awaiting_upload',
  };
}

async function createSession(args: Args, ctx: AgentContext): Promise<unknown> {
  const sessionId = `sess_${newId().replace(/^a_/, '')}`;
  const slot = await requestUploadSlot(args, ctx, sessionId);
  if ('error' in slot) return slot;
  return {
    ok: true,
    action: 'create_session',
    sessionId,
    projectId: ctx.getProjectId?.() ?? null,
    state: 'awaiting_upload',
    slots: [slot],
    next: [
      'Upload once to the exact slot uploadUrl before expiry with the declared headers.',
      'Pass only the opaque receipt from the successful upload JSON to finalize_uploaded_asset.',
      'The asset becomes consumable only after finalize succeeds.',
    ],
    note: 'Import session created with one verified, filename-scoped, short-lived, single-use slot.',
  };
}

export async function execImportMediaHandoff(args: Args, ctx: AgentContext): Promise<unknown> {
  if (args.action !== 'create_session') {
    return { error: 'import_media action must be create_session' };
  }
  return createSession(args, ctx);
}
