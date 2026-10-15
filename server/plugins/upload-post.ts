import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin } from 'vite';

import { resolveUploadFile } from '../media-dir.ts';
import { runtimeProfile } from '../runtime-profile.ts';
import { readJsonBody, sendError, sendJson } from './export-http.ts';
import {
  accountIdentity, connectedPlatforms, fetchWithProxy, PLATFORM_ALIASES, providerError, publishStatus, requireConfig,
  UPLOAD_POST_PLATFORMS, UploadPostError, uploadPostConfig,
  type PublishStatus, type UploadPostConfig, type UploadPostPlatform,
} from './upload-post-client.ts';
import {
  ledgerEntry, ledgerIdle, LedgerUnavailableError, markLedger, type LedgerEntry,
} from './upload-post-ledger.ts';
import { publishRequestId, resolvePublishSource, type PublishSource } from './upload-post-source.ts';

function defaultLedgerPath(): string {
  return join(runtimeProfile().rootDir, 'upload-post-publishes.json');
}


// Publish a finished render to social platforms through Upload-Post. One
// multipart upload fans out to every requested platform; per-platform results
// are polled from /api/uploadposts/status.
//
// Publishing is public and cannot be undone:
// - Without `confirm` the route only previews and returns a requestId derived
//   from the destination (endpoint, Upload-Post account and profile), the
//   render's content and every publish field.
// - `confirm: true` must carry that requestId as `previewId`. If the account
//   (another API key), the endpoint, the profile, the file or a field changed
//   since the preview, the ids differ and the confirm is refused: the user has
//   to approve a fresh preview. Rotating the key of the SAME account keeps the
//   id, so duplicate protection survives a key rotation.
// - A confirm is admitted, recorded in the local ledger and answered at once;
//   the upload itself runs in the background, so a large render never outlives
//   the agent's tool deadline. track_social_publish reports `uploading` until
//   Upload-Post answers.
// - The requestId doubles as the Idempotency-Key. Only a 400/401/403/422 is a
//   definitive rejection; anything else is ambiguous, reconciled against
//   /status and never re-sent (see upload-post-ledger.ts).

const YOUTUBE_PRIVACY = ['private', 'unlisted', 'public'] as const;
const TIKTOK_PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const;
const TITLE_MAX = 2200;
const YOUTUBE_TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const REQUEST_ID = /^ocut-[0-9a-f]{32}$/;
/** Pre-acceptance rejections: the upload was refused, so it can be fixed and retried. */
const DEFINITIVE_REJECTIONS = new Set([400, 401, 403, 422]);

export interface PublishRequest {
  readonly source: string;
  readonly platforms: readonly UploadPostPlatform[];
  readonly title: string;
  readonly description?: string;
  readonly youtubePrivacy: (typeof YOUTUBE_PRIVACY)[number];
  readonly tiktokPrivacy?: (typeof TIKTOK_PRIVACY)[number];
  /** Required when publishing to Pinterest: the board the pin goes to. */
  readonly pinterestBoardId?: string;
  readonly aiGenerated: boolean;
  readonly confirm: boolean;
  /** The requestId returned by the preview the user approved. Required with confirm. */
  readonly previewId?: string;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T | undefined {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new UploadPostError(400, 'invalid_request', `${field} must be one of ${allowed.join(', ')}`);
}

export function parsePlatforms(raw: unknown): UploadPostPlatform[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const platforms: UploadPostPlatform[] = [];
  for (const entry of list) {
    const name = String(entry).trim().toLowerCase();
    if (!name) continue;
    const platform = PLATFORM_ALIASES[name] ?? name;
    if (!(UPLOAD_POST_PLATFORMS as readonly string[]).includes(platform)) {
      throw new UploadPostError(400, 'invalid_request', `unsupported platform "${name}" — use ${UPLOAD_POST_PLATFORMS.join(', ')}`);
    }
    if (!platforms.includes(platform as UploadPostPlatform)) platforms.push(platform as UploadPostPlatform);
  }
  if (!platforms.length) throw new UploadPostError(400, 'invalid_request', 'platforms is required');
  return platforms;
}

export function parsePublishRequest(body: unknown): PublishRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new UploadPostError(400, 'invalid_request', 'expected a JSON object');
  }
  const input = body as Record<string, unknown>;
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  if (!source) throw new UploadPostError(400, 'invalid_request', 'source is required');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new UploadPostError(400, 'invalid_request', 'title is required');
  if (title.length > TITLE_MAX) throw new UploadPostError(400, 'invalid_request', `title exceeds ${TITLE_MAX} characters`);
  const platforms = parsePlatforms(input.platforms);
  if (platforms.includes('youtube') && title.length > YOUTUBE_TITLE_MAX) {
    throw new UploadPostError(400, 'invalid_request', `YouTube titles are limited to ${YOUTUBE_TITLE_MAX} characters`);
  }
  const description = typeof input.description === 'string' && input.description.trim()
    ? input.description.trim().slice(0, DESCRIPTION_MAX)
    : undefined;
  const pinterestBoardId = typeof input.pinterestBoardId === 'string' ? input.pinterestBoardId.trim() : '';
  if (platforms.includes('pinterest') && !pinterestBoardId) {
    throw new UploadPostError(400, 'invalid_request', 'pinterestBoardId is required when publishing to Pinterest');
  }
  return {
    source,
    platforms,
    title,
    description,
    youtubePrivacy: oneOf(input.youtubePrivacy, YOUTUBE_PRIVACY, 'youtubePrivacy', 'private')!,
    tiktokPrivacy: oneOf(input.tiktokPrivacy, TIKTOK_PRIVACY, 'tiktokPrivacy'),
    ...(platforms.includes('pinterest') ? { pinterestBoardId } : {}),
    aiGenerated: input.aiGenerated === true,
    confirm: input.confirm === true,
    ...(typeof input.previewId === 'string' && input.previewId.trim() ? { previewId: input.previewId.trim() } : {}),
  };
}


function publishBody(
  request: PublishRequest,
  profile: string,
  requestId: string,
  source: Pick<PublishSource, 'video' | 'name'>,
): Blob {
  const form = new FormData();
  form.append('user', profile);
  form.append('title', request.title);
  form.append('request_id', requestId);
  form.append('async_upload', 'true');
  for (const platform of request.platforms) form.append('platform[]', platform);
  if (request.description) form.append('description', request.description);
  if (request.aiGenerated) form.append('is_ai_generated', 'true');
  if (request.platforms.includes('youtube')) form.append('privacyStatus', request.youtubePrivacy);
  if (request.platforms.includes('tiktok') && request.tiktokPrivacy) form.append('privacy_level', request.tiktokPrivacy);
  if (request.platforms.includes('pinterest') && request.pinterestBoardId) form.append('pinterest_board_id', request.pinterestBoardId);
  // Node's FormData encoder can leave a changed file Blob's read rejection
  // unhandled. A composite Blob streams the same file-backed parts, but routes
  // stream errors into fetch's rejected promise so delivery remains ambiguous.
  const boundary = `----openchatcut-${randomUUID()}`;
  const parts: BlobPart[] = [];
  for (const [name, value] of form) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`
      + `${String(value).replace(/\r\n|\r|\n/g, '\r\n')}\r\n`);
  }
  const filename = source.name.replace(/[\r\n"]/g, (character) => encodeURIComponent(character));
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${filename}"\r\n`
    + `Content-Type: ${source.video.type}\r\n\r\n`, source.video, `\r\n--${boundary}--\r\n`);
  return new Blob(parts, { type: `multipart/form-data; boundary=${boundary}` });
}


export interface PublishPreview {
  readonly requestId: string;
  readonly file: { readonly name: string; readonly sizeBytes: number };
  readonly profile: string;
  readonly platforms: readonly string[];
  readonly connectedPlatforms: readonly string[];
  readonly missingPlatforms: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly youtubePrivacy?: string;
  readonly tiktokPrivacy?: string;
  readonly pinterestBoardId?: string;
  readonly aiGenerated: boolean;
  /** This exact publish was already sent once; confirming again only reconciles it, it never re-uploads. */
  readonly previouslySubmitted?: boolean;
}

export type PublishOutcome =
  | ({ readonly phase: 'preview'; readonly needsConfirm: true } & PublishPreview)
  | ({ readonly phase: 'admitted' | 'resumed' | 'unconfirmed_delivery' } & PublishStatus);

export interface PublishOptions {
  readonly resolve?: (name: string) => string | null;
  readonly ledgerPath?: string;
}

const AMBIGUOUS_NOTE = 'The upload may or may not have been accepted. It will not be re-sent: '
  + 'check it with track_social_publish. To publish a separate post anyway, change the title or description.';

/** Request ids whose upload is running (or being admitted) in this process. */
const inFlight = new Map<string, Promise<void>>();
/**
 * Why new uploads are not admitted: a storage relocation is copying the root,
 * or has copied it and only takes effect on the next launch. Until then this
 * process still writes the old root's ledger, so a publish admitted now would
 * be missing from the relocated record after the restart.
 */
let pausedFor: 'relocating' | 'relocated' | null = null;

/**
 * Run `task` (a storage relocation) with publishing paused. Refused while an
 * upload is in flight, because its ledger writes would land in the old root
 * after the copy and leave the relocated record stale. The check and the flag
 * are set in the same synchronous step as an admission's claim, so the two
 * cannot interleave. If `task` succeeds, publishing stays paused until the
 * restart that activates the new root; if it fails, publishing resumes.
 */
export async function pausePublishing<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight.size > 0) {
    throw new UploadPostError(409, 'publish_in_progress',
      'A social publish is still uploading. Change the storage folder after it finishes (check it with track_social_publish).');
  }
  if (pausedFor === 'relocating') throw new UploadPostError(409, 'publish_paused', 'A storage relocation is already in progress.');
  const before = pausedFor;
  pausedFor = 'relocating';
  try {
    await ledgerIdle(); // every write already queued lands before the copy
    const result = await task();
    pausedFor = 'relocated';
    return result;
  } catch (error) {
    pausedFor = before;
    throw error;
  }
}

/** Test hook: undo pausePublishing as a restart would. */
export function resumePublishingForTests(): void {
  pausedFor = null;
}

/** Test hook: wait for every background upload to finish. */
export async function settleBackgroundUploads(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight.values()]);
}


function ledgerError(error: unknown): never {
  if (error instanceof LedgerUnavailableError) throw new UploadPostError(503, 'ledger_unavailable', error.message);
  throw error;
}

/** After an ambiguous answer the status endpoint is the only authority on whether the post exists. */
async function settleAmbiguous(config: UploadPostConfig, requestId: string, ledgerPath: string): Promise<void> {
  const status = await publishStatus(config, requestId).catch(() => null);
  await markLedger(ledgerPath, requestId, status && status.status !== 'not_found' ? 'accepted' : 'ambiguous');
}

/** Background half of a confirmed publish. Never throws; the outcome lands in the ledger. */
async function runUpload(
  config: UploadPostConfig,
  request: PublishRequest,
  source: Pick<PublishSource, 'video' | 'name'>,
  requestId: string,
  ledgerPath: string,
): Promise<void> {
  try {
    const body = publishBody(request, config.profile, requestId, source);
    let response: Response;
    try {
      response = await fetchWithProxy(`${config.baseUrl}/api/upload`, {
        method: 'POST',
        headers: { Authorization: `Apikey ${config.apiKey}`, 'Idempotency-Key': requestId, 'User-Agent': 'OpenChatCut' },
        body,
      });
    } catch {
      await settleAmbiguous(config, requestId, ledgerPath); // transport error or timeout
      return;
    }
    if (response.ok) {
      // Any 2xx means the upload was accepted, whatever the body looks like.
      await response.body?.cancel().catch(() => undefined);
      await markLedger(ledgerPath, requestId, 'accepted');
    } else if (DEFINITIVE_REJECTIONS.has(response.status)) {
      // Refused before acceptance: nothing was posted, so this publish may be fixed and retried.
      await markLedger(ledgerPath, requestId, 'rejected', `${response.status}: ${await providerError(response)}`);
    } else {
      // 5xx, 429, 404, 409… — ambiguous: never treated as a failure that may be re-sent.
      await response.body?.cancel().catch(() => undefined);
      await settleAmbiguous(config, requestId, ledgerPath);
    }
  } catch {
    // Unexpected error after the write-ahead record: stays ambiguous, never re-sent.
    await markLedger(ledgerPath, requestId, 'ambiguous').catch(() => undefined);
  }
}

/** Where a confirmed publish stands, combining this process, the ledger and Upload-Post. */
export async function trackPublish(
  config: UploadPostConfig,
  requestId: string,
  ledgerPath: string = defaultLedgerPath(),
): Promise<PublishStatus> {
  requireConfig(config);
  if (inFlight.has(requestId)) {
    return { requestId, status: 'uploading', results: [], note: 'The video is still being uploaded to Upload-Post.' };
  }
  const entry = await ledgerEntry(ledgerPath, requestId).catch(() => undefined);
  if (entry?.state === 'rejected') {
    return { requestId, status: 'failed', results: [], error: entry.error ?? 'Upload-Post rejected the upload' };
  }
  const remote = await publishStatus(config, requestId);
  if (remote.status !== 'not_found') {
    if (entry && entry.state !== 'accepted') await markLedger(ledgerPath, requestId, 'accepted').catch(() => undefined);
    return remote;
  }
  if (entry?.state === 'accepted') {
    return { requestId, status: 'queued', results: [], note: 'Accepted by Upload-Post; results are not visible yet.' };
  }
  // `sending` with no upload running here = interrupted (e.g. the app closed mid-upload).
  if (entry) return { requestId, status: 'unknown', results: [], note: AMBIGUOUS_NOTE };
  return remote;
}

async function resumeExisting(
  config: UploadPostConfig,
  requestId: string,
  prior: LedgerEntry,
  ledgerPath: string,
): Promise<PublishOutcome> {
  const status = await publishStatus(config, requestId).catch(() => null);
  if (status && status.status !== 'not_found') {
    if (prior.state !== 'accepted') await markLedger(ledgerPath, requestId, 'accepted');
    return { phase: 'resumed', ...status };
  }
  if (prior.state === 'accepted') return { phase: 'resumed', requestId, status: 'queued', results: [] };
  return { phase: 'unconfirmed_delivery', requestId, status: 'unknown', results: [], note: AMBIGUOUS_NOTE };
}

export async function publishToUploadPost(
  config: UploadPostConfig,
  request: PublishRequest,
  options: PublishOptions = {},
): Promise<PublishOutcome> {
  requireConfig(config);
  const ledgerPath = options.ledgerPath ?? defaultLedgerPath();
  const [source, account] = await Promise.all([
    resolvePublishSource(request.source, options.resolve ?? resolveUploadFile),
    accountIdentity(config),
  ]);
  const requestId = publishRequestId(account, config.profile, source, request);

  if (!request.confirm) {
    const prior = await ledgerEntry(ledgerPath, requestId).catch(ledgerError);
    const connected = await connectedPlatforms(config);
    return {
      phase: 'preview',
      needsConfirm: true,
      requestId,
      file: { name: source.name, sizeBytes: source.sizeBytes },
      profile: config.profile,
      platforms: request.platforms,
      connectedPlatforms: connected,
      missingPlatforms: request.platforms.filter((platform) => !connected.includes(platform)),
      title: request.title,
      ...(request.description ? { description: request.description } : {}),
      ...(request.platforms.includes('youtube') ? { youtubePrivacy: request.youtubePrivacy } : {}),
      ...(request.tiktokPrivacy ? { tiktokPrivacy: request.tiktokPrivacy } : {}),
      ...(request.pinterestBoardId ? { pinterestBoardId: request.pinterestBoardId } : {}),
      aiGenerated: request.aiGenerated,
      ...(prior && prior.state !== 'rejected' ? { previouslySubmitted: true } : {}),
    };
  }

  // The confirmation is bound to the exact preview the user approved.
  if (!request.previewId) {
    throw new UploadPostError(400, 'preview_required', 'Preview first (call without confirm) and pass its requestId as previewId when confirming.');
  }
  if (request.previewId !== requestId) {
    throw new UploadPostError(409, 'preview_mismatch', 'The Upload-Post account, endpoint or profile, the render file or the publish fields changed since the preview. '
      + 'Nothing was published: preview again and ask the user to approve the new preview.');
  }
  if (inFlight.has(requestId)) return { phase: 'admitted', requestId, status: 'uploading', results: [] };
  if (pausedFor) {
    throw new UploadPostError(503, 'publish_paused', pausedFor === 'relocating'
      ? 'The storage folder is being moved. Nothing was published: confirm again in a moment.'
      : 'The storage folder was moved and takes effect after restarting OpenChatCut. Nothing was published: restart, then confirm again.');
  }

  // Claim the id synchronously so a concurrent confirm cannot start a second upload.
  let release!: () => void;
  const claim = new Promise<void>((resolve) => { release = resolve; });
  inFlight.set(requestId, claim);
  let handedOff = false;
  try {
    const prior = await ledgerEntry(ledgerPath, requestId).catch(ledgerError);
    if (prior && prior.state !== 'rejected') return await resumeExisting(config, requestId, prior, ledgerPath);
    if (!prior) {
      // No local record (another machine, a cleared data dir): the provider is the fallback.
      const existing = await publishStatus(config, requestId);
      if (existing.status !== 'not_found') {
        await markLedger(ledgerPath, requestId, 'accepted').catch(ledgerError);
        return { phase: 'resumed', ...existing };
      }
    }
    // Write-ahead: from here on this id counts as sent, even if the process dies mid-upload.
    await markLedger(ledgerPath, requestId, 'sending').catch(ledgerError);
    const upload = runUpload(config, request, source, requestId, ledgerPath)
      .finally(() => { inFlight.delete(requestId); release(); });
    inFlight.set(requestId, upload);
    handedOff = true;
    return { phase: 'admitted', requestId, status: 'uploading', results: [] };
  } finally {
    if (!handedOff) {
      inFlight.delete(requestId);
      release();
    }
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
  const config = uploadPostConfig();
  if (req.method === 'POST' && path === '/publish') {
    const body = await readJsonBody(req).catch((error: unknown) => {
      throw new UploadPostError(400, 'invalid_request', error instanceof Error ? error.message : 'invalid JSON body');
    });
    sendJson(res, 200, await publishToUploadPost(config, parsePublishRequest(body)));
    return;
  }
  const match = /^\/publish\/([^/]+)$/.exec(path);
  if (req.method === 'GET' && match) {
    const requestId = match[1];
    if (!REQUEST_ID.test(requestId)) throw new UploadPostError(400, 'invalid_request', 'invalid publish id');
    sendJson(res, 200, await trackPublish(config, requestId));
    return;
  }
  sendError(res, 404, 'not found');
}

export function uploadPostPlugin(): Plugin {
  return {
    name: 'openchatcut-upload-post',
    configureServer(server) {
      server.middlewares.use('/api/upload-post', async (req, res) => {
        try {
          await handle(req, res);
        } catch (error) {
          if (res.writableEnded) return;
          if (error instanceof UploadPostError) {
            sendJson(res, error.status, { error: error.message, code: error.code });
            return;
          }
          server.config.logger.error(`[upload-post] ${error instanceof Error ? error.message : String(error)}`);
          sendError(res, 500, error instanceof Error ? error.message : 'Upload-Post request failed');
        }
      });
    },
  };
}
