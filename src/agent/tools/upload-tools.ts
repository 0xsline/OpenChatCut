export { UPLOAD_TOOL_SCHEMAS, UPLOAD_TOOL_NAMES } from './schemas/upload-tools';
import type { AgentContext } from '../context';
import type { MediaAsset } from '../../editor/types';
import { enqueueTranscription, shouldTranscribe } from '../../transcript/transcribe-jobs';
import { extractAudioForAsr } from '../../transcript/assemblyai';
import { hasOperationalTranscript } from '../../transcript/types';
import { createMediaSourceRevision } from '../../editor/mediaSourceRevision';

// Local-development upload flow:
//   request_asset_upload_url → finalize_uploaded_asset → request_asset_download
// Uses POST/PUT /upload?name=&assetId= (server/plugins/upload) instead of real S3.
// Do NOT pretend this is cloud storage — responses carry localDev: true.

type Args = Record<string, unknown>;

const ASSET_TYPES = ['audio', 'gif', 'image', 'svg', 'video'] as const;
type SourceAssetType = (typeof ASSET_TYPES)[number];

const newId = (): string =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `a_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

function mapKind(type: string): MediaAsset['kind'] | null {
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

function isSourceType(v: unknown): v is SourceAssetType {
  return typeof v === 'string' && (ASSET_TYPES as readonly string[]).includes(v);
}

function extOf(filename: string, contentType: string): string {
  const fromName = filename.includes('.')
    ? `.${filename.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '')}`
    : '';
  if (fromName && fromName.length <= 6) return fromName;
  const ct = contentType.split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mp4': '.m4a',
  };
  return map[ct] ?? '.bin';
}

function findAsset(ctx: AgentContext, q: string): MediaAsset | null {
  const assets = ctx.getDoc().assets ?? ctx.getState().assets ?? [];
  const exact = assets.find((a) => a.id === q);
  if (exact) return exact;
  const hits = assets.filter((a) => a.id.startsWith(q));
  return hits.length === 1 ? hits[0]! : null;
}

export async function execUploadTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'import_media') return execImportMedia(args, ctx);
  if (name === 'request_asset_upload_url') return execRequestUpload(args);
  if (name === 'finalize_uploaded_asset') return execFinalize(args, ctx);
  if (name === 'request_asset_download') return execRequestDownload(args, ctx);
  return { error: `unknown tool ${name}` };
}

/** Server-side video compatibility normalization (same as UI importMedia). */
async function normalizeVideoSrc(src: string, targetFps: number): Promise<{
  src: string;
  width?: number;
  height?: number;
  bytes?: number;
  normalized?: boolean;
  durationSeconds?: number;
  fps?: number;
}> {
  if (!src.startsWith('/media/uploads/')) return { src };
  try {
    const res = await fetch('/api/normalize-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ src, targetFps }),
    });
    const data = (await res.json()) as {
      path?: string;
      width?: number;
      height?: number;
      bytes?: number;
      normalized?: boolean;
      durationSeconds?: number;
      fps?: number;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.path?.startsWith('/media/uploads/')) {
      return {
        src: data.path,
        width: typeof data.width === 'number' ? data.width : undefined,
        height: typeof data.height === 'number' ? data.height : undefined,
        bytes: typeof data.bytes === 'number' ? data.bytes : undefined,
        normalized: data.normalized,
        durationSeconds: typeof data.durationSeconds === 'number' ? data.durationSeconds : undefined,
        fps: typeof data.fps === 'number' ? data.fps : undefined,
      };
    }
    throw new Error('server returned no media path');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Video compatibility processing failed: ${message}`);
  }
}

function execImportMedia(args: Args, ctx: AgentContext): unknown {
  if (args.action === 'register_placeholder') return execRegisterPlaceholder(args, ctx);
  if (args.action !== 'create_session') {
    return { error: 'import_media actions: create_session | register_placeholder' };
  }
  const sessionId = newId().replace(/^a_/, 'sess_');
  const token = `local_${sessionId}`;
  // Pre-mint a few asset slots the host can use (optional); primary path is per-file upload URL
  const slots = [0, 1, 2].map(() => {
    const assetId = newId();
    return {
      assetId,
      uploadUrl: `/upload?name=file.bin&assetId=${encodeURIComponent(assetId)}`,
    };
  });
  return {
    ok: true,
    localDev: true,
    action: 'create_session',
    sessionId,
    token,
    projectId: ctx.getProjectId?.() ?? null,
    directUpload: {
      url: '/upload',
      method: 'POST',
      alsoAccepts: 'PUT',
      auth: `Bearer ${token} (ignored locally)`,
      query: {
        name: '<original-filename>',
        assetId: '<optional-deterministic-id from request_asset_upload_url or slots>',
      },
      contentType: 'raw body (not multipart required locally)',
    },
    slots,
    next: [
      'Preferred for large files: import_media action=register_placeholder → edit_item with assetId → POST /upload → finalize_uploaded_asset.',
      '1. POST/PUT file bytes to /upload?name=clip.mp4&assetId=<id>',
      '2. probe_media(source=/media/uploads/<id>.ext) — accurate ffprobe: hasAudioTrack / fps / duration.',
      '3. finalize_uploaded_asset with assetId, fileKey, readUrl, size, type, duration, hasAudioTrack/fps.',
      '4. If hasAudioTrack: track_progress action=wait target=transcription assetIds=<id>.',
    ],
    expiresInSeconds: 3600,
    note: 'LOCAL-DEV import session — token is not verified.',
  };
}

/** Early pool row with a deterministic path and upload URL before bytes land. */
function execRegisterPlaceholder(args: Args, ctx: AgentContext): unknown {
  if (!isSourceType(args.assetType)) {
    return { error: 'register_placeholder requires assetType: audio|gif|image|svg|video' };
  }
  const filename = String(args.filename ?? '').trim();
  if (!filename) return { error: 'filename is required' };
  const contentType = String(args.contentType ?? '').trim() || 'application/octet-stream';
  const kind = mapKind(args.assetType);
  if (!kind) return { error: `unsupported assetType ${args.assetType}` };

  const fps = ctx.getState().fps || 30;
  let durationInFrames: number;
  if (kind === 'image' && args.assetType !== 'gif') {
    durationInFrames = Math.round(3 * fps);
  } else if (typeof args.durationInSeconds === 'number' && args.durationInSeconds > 0) {
    durationInFrames = Math.max(1, Math.round(args.durationInSeconds * fps));
  } else if (kind === 'image') {
    durationInFrames = Math.round(3 * fps);
  } else {
    return { error: 'durationInSeconds is required for audio/video/gif placeholders' };
  }

  const assetId = newId();
  const ext = extOf(filename, contentType);
  const fname = `${assetId}${ext}`;
  const fileKey = `uploads/${fname}`;
  const readUrl = `/media/uploads/${fname}`;
  const uploadUrl = `/upload?name=${encodeURIComponent(filename)}&assetId=${encodeURIComponent(assetId)}`;

  if (findAsset(ctx, assetId)) {
    return { error: `asset id collision: ${assetId}` };
  }

  const asset: MediaAsset = {
    id: assetId,
    name: filename,
    kind,
    src: readUrl,
    durationInFrames,
    width: typeof args.width === 'number' && args.width > 0 ? args.width : undefined,
    height: typeof args.height === 'number' && args.height > 0 ? args.height : undefined,
    // No ASR until finalize — file may not exist yet.
  };
  ctx.commands.addAsset(asset);

  return {
    ok: true,
    localDev: true,
    action: 'register_placeholder',
    assetId,
    name: filename,
    type: kind,
    sourceType: args.assetType,
    src: readUrl,
    readUrl,
    fileKey,
    uploadUrl,
    method: 'POST',
    allowedMethods: ['POST', 'PUT'],
    headers: { 'Content-Type': contentType },
    contentType,
    size: typeof args.size === 'number' ? args.size : undefined,
    durationInFrames,
    width: asset.width,
    height: asset.height,
    hasAudioTrack: typeof args.hasAudioTrack === 'boolean' ? args.hasAudioTrack : undefined,
    agentNext: [
      'Asset is in the media pool — you may edit_item / manage_media_pool now.',
      `POST/PUT bytes to ${uploadUrl} with Content-Type: ${contentType}.`,
      'Then finalize_uploaded_asset (same assetId/fileKey/readUrl/size/type/duration) to normalize video + start ASR.',
      'Wait target=upload (file reachable) before export / remote frame views; wait target=transcription before script/caption tools.',
    ].join(' '),
    note: 'Placeholder registered; bytes not uploaded yet. Preview/export may 404 until upload completes.',
  };
}

function execRequestUpload(args: Args): unknown {
  if (!isSourceType(args.assetType)) {
    return { error: 'assetType must be audio|gif|image|svg|video' };
  }
  const contentType = String(args.contentType ?? '').trim();
  const filename = String(args.filename ?? '').trim();
  if (!contentType) return { error: 'contentType is required' };
  if (!filename) return { error: 'filename is required' };

  const assetId = newId();
  const ext = extOf(filename, contentType);
  const fname = `${assetId}${ext}`;
  const fileKey = `uploads/${fname}`;
  const readUrl = `/media/uploads/${fname}`;
  // Local stand-in for S3 presigned URL — same-origin /upload with deterministic assetId
  const uploadUrl = `/upload?name=${encodeURIComponent(filename)}&assetId=${encodeURIComponent(assetId)}`;

  return {
    ok: true,
    localDev: true,
    assetId,
    fileKey,
    readUrl,
    // Field name accepted by the upload contract.
    presignedUrl: uploadUrl,
    uploadUrl,
    method: 'POST',
    // also accept PUT (vite plugin allows both)
    allowedMethods: ['POST', 'PUT'],
    headers: { 'Content-Type': contentType },
    contentType,
    filename,
    size: typeof args.size === 'number' ? args.size : undefined,
    assetType: args.assetType,
    note: [
      'LOCAL-DEV (not S3): upload raw file bytes with',
      `fetch(presignedUrl, { method: 'POST' or 'PUT', headers: { 'Content-Type': '${contentType}' }, body: fileBytes })`,
      'then call finalize_uploaded_asset with assetId, fileKey, readUrl, size, type, and media metadata.',
    ].join(' '),
  };
}

async function execFinalize(args: Args, ctx: AgentContext): Promise<unknown> {
  const assetId = String(args.assetId ?? '').trim();
  const fileKey = String(args.fileKey ?? '').trim();
  const filename = String(args.filename ?? '').trim();
  const readUrl = String(args.readUrl ?? '').trim();
  const size = typeof args.size === 'number' ? args.size : Number(args.size);
  const type = args.type;

  if (!assetId) return { error: 'assetId is required' };
  if (!fileKey) return { error: 'fileKey is required' };
  if (!filename) return { error: 'filename is required' };
  if (!readUrl) return { error: 'readUrl is required' };
  if (!Number.isFinite(size) || size <= 0) return { error: 'size must be a positive integer' };
  if (!isSourceType(type)) return { error: 'type must be audio|gif|image|svg|video' };

  // Accept same-origin media paths or http(s) URLs (remote finalize rare)
  const srcOk = readUrl.startsWith('/media/')
    || readUrl.startsWith('http://')
    || readUrl.startsWith('https://')
    || readUrl.startsWith('blob:');
  if (!srcOk) {
    return { error: 'readUrl must be a /media/... path or http(s) URL (local-dev)' };
  }

  const kind = mapKind(type);
  if (!kind) return { error: `unsupported type ${type}` };

  const fps = ctx.getState().fps || 30;
  let durationInFrames: number;
  if (kind === 'image' && type !== 'gif') {
    durationInFrames = Math.round(3 * fps);
  } else if (typeof args.durationInSeconds === 'number' && args.durationInSeconds > 0) {
    durationInFrames = Math.max(1, Math.round(args.durationInSeconds * fps));
  } else if (kind === 'image') {
    durationInFrames = Math.round(3 * fps);
  } else {
    return { error: 'durationInSeconds is required for audio/video/gif' };
  }

  // Upload and transcribe: ASR is automatically triggered after ingest is dropped into the database, and the
  // hasAudioTrack signal; audio always, video unless explicitly told there's no audio.
  const hasAudio = shouldTranscribe(kind, typeof args.hasAudioTrack === 'boolean' ? args.hasAudioTrack : undefined);
  const projectId = ctx.getProjectId?.();
  if (hasAudio && !projectId) return { error: 'transcription requires a persisted project id' };

  // Race: extract-audio for ASR while video normalize runs (don't serialize them).
  const asrRace = hasAudio && readUrl.startsWith('/media/uploads/')
    ? extractAudioForAsr(readUrl).catch(() => null)
    : Promise.resolve(null);

  // Conditional server normalize for video masters (codec / size / bitrate).
  let src = readUrl;
  let width = typeof args.width === 'number' && args.width > 0 ? args.width : undefined;
  let height = typeof args.height === 'number' && args.height > 0 ? args.height : undefined;
  let finalSize = size;
  let normalized = false;
  if (kind === 'video' && readUrl.startsWith('/media/uploads/')) {
    const norm = await normalizeVideoSrc(readUrl, fps);
    src = norm.src;
    if (norm.width) width = norm.width;
    if (norm.height) height = norm.height;
    if (norm.bytes) finalSize = norm.bytes;
    if (norm.durationSeconds && norm.durationSeconds > 0) {
      durationInFrames = Math.max(1, Math.round(norm.durationSeconds * fps));
    }
    normalized = Boolean(norm.normalized);
  }
  const sourceRevision = createMediaSourceRevision({
    src,
    name: filename,
    kind,
    sourceSize: finalSize,
    durationInFrames,
    width,
    height,
  });

  const existing = findAsset(ctx, assetId);
  if (existing) {
    // Complete a register_placeholder row (or re-finalize after re-upload).
    if (src !== existing.src || width !== existing.width || height !== existing.height
      || durationInFrames !== existing.durationInFrames || filename !== existing.name
      || sourceRevision !== existing.sourceRevision) {
      ctx.commands.relinkMediaAsset(existing.id, {
        src,
        name: filename,
        durationInFrames,
        width: width ?? existing.width,
        height: height ?? existing.height,
        kind,
        sourceRevision,
        sourceSize: finalSize,
      });
    }
    const needsAsr = hasAudio && (
      sourceRevision !== existing.sourceRevision
      || existing.transcribeStatus !== 'done'
      || !hasOperationalTranscript(existing)
    );
    if (needsAsr) {
      ctx.commands.setAssetTranscription(existing.id, { transcribeStatus: 'running', transcribeError: undefined });
      enqueueTranscription(projectId!, {
        id: existing.id,
        src,
        name: filename,
        kind,
        sourceRevision,
        sourceSize: finalSize,
        durationInFrames,
        width,
        height,
      }, { asrPath: asrRace });
    }
    return {
      ok: true,
      alreadyRegistered: true,
      completedPlaceholder: true,
      assetId: existing.id,
      name: filename,
      type: kind,
      src,
      fileKey: src.startsWith('/media/uploads/')
        ? `uploads/${src.slice('/media/uploads/'.length)}`
        : fileKey,
      size: finalSize,
      normalized: normalized || undefined,
      durationInFrames,
      width: width ?? existing.width,
      height: height ?? existing.height,
      transcription: needsAsr ? 'started' : existing.transcribeStatus === 'done' ? 'ready' : undefined,
      next: needsAsr
        ? `ASR started. Call track_progress action=wait target=transcription assetIds=${existing.id} before transcript tools.`
        : undefined,
      note: 'Placeholder/prior asset finalized (normalized + ASR if needed).',
    };
  }

  const asset: MediaAsset = {
    id: assetId,
    name: filename,
    kind,
    src,
    durationInFrames,
    sourceRevision,
    sourceSize: finalSize,
    width,
    height,
    transcribeStatus: hasAudio ? 'running' : undefined,
  };
  ctx.commands.addAsset(asset);

  // Fire ASR now (race extract already started above while normalize ran).
  if (hasAudio) enqueueTranscription(projectId!, asset, { asrPath: asrRace });

  return {
    ok: true,
    localDev: true,
    assetId: asset.id,
    name: asset.name,
    type: kind,
    sourceType: type,
    src: asset.src,
    fileKey: src.startsWith('/media/uploads/')
      ? `uploads/${src.slice('/media/uploads/'.length)}`
      : fileKey,
    size: finalSize,
    normalized: normalized || undefined,
    durationInFrames: asset.durationInFrames,
    width: asset.width,
    height: asset.height,
    transcription: hasAudio ? 'started' : undefined,
    next: hasAudio
      ? `ASR started (上传即转写). Call track_progress action=wait target=transcription assetIds=${asset.id} before find_transcript / clean_script / delete_text / edit_captions / apply_script.`
      : undefined,
    note: 'Asset registered in media pool (local-dev finalize).',
  };
}

function execRequestDownload(args: Args, ctx: AgentContext): unknown {
  const q = String(args.assetId ?? '').trim();
  if (!q) return { error: 'assetId is required' };
  if (args.variant != null && args.variant !== 'source') {
    return { error: 'only variant "source" is supported' };
  }
  const asset = findAsset(ctx, q);
  if (!asset) return { error: `asset not found: ${q}` };
  if (!asset.src) {
    return {
      error: 'asset has no source media file (e.g. motion-graphic without baked video)',
      hint: 'Export MG via export_motion_graphic_prores or convert_motion_graphic_to_video first.',
    };
  }

  const origin = typeof location !== 'undefined' && location.origin ? location.origin : '';
  const downloadUrl = asset.src.startsWith('http')
    ? asset.src
    : origin
      ? `${origin}${asset.src.startsWith('/') ? '' : '/'}${asset.src}`
      : asset.src;

  return {
    ok: true,
    localDev: true,
    assetId: asset.id,
    name: asset.name,
    type: asset.kind,
    variant: 'source',
    path: asset.src,
    downloadUrl,
    note: 'Open downloadUrl in the browser or use as <a download>. Local-dev has no signed expiry.',
  };
}
