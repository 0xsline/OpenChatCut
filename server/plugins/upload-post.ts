import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

import { getKey } from '../keystore.ts';
import type { KeyName } from '../keystore-names.ts';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import { proxyDispatcher } from '../outbound-proxy.ts';
import { readJsonBody, sendError, sendJson } from './export-http.ts';

// Publish a finished render to social platforms through Upload-Post
// (https://docs.upload-post.com). One multipart upload fans out to every
// requested platform; the API answers with a request_id and the per-platform
// results are polled from /api/uploadposts/status.
//
// Publishing is public and cannot be undone, so the route has two steps:
// without `confirm` it only previews (resolves the file, checks the key and
// which platforms the profile has connected); with `confirm: true` it uploads.
// The request_id is derived from the file and the publish fields and doubles
// as the Idempotency-Key, so re-sending an approved publish (a retried tool
// call, a dropped connection) resumes the same post instead of posting twice.

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

export const UPLOAD_POST_DEFAULT_BASE_URL = 'https://api.upload-post.com';
export const UPLOAD_POST_PLATFORMS = [
  'tiktok', 'instagram', 'youtube', 'linkedin', 'facebook', 'x', 'threads', 'pinterest', 'bluesky',
] as const;
export type UploadPostPlatform = (typeof UPLOAD_POST_PLATFORMS)[number];
const PLATFORM_ALIASES: Record<string, UploadPostPlatform> = { twitter: 'x', reels: 'instagram', shorts: 'youtube' };
const YOUTUBE_PRIVACY = ['private', 'unlisted', 'public'] as const;
const TIKTOK_PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
const TITLE_MAX = 2200;
const YOUTUBE_TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const REQUEST_ID = /^ocut-[0-9a-f]{32}$/;

export interface UploadPostConfig {
  readonly apiKey: string;
  readonly profile: string;
  readonly baseUrl: string;
}

export interface PublishRequest {
  readonly source: string;
  readonly platforms: readonly UploadPostPlatform[];
  readonly title: string;
  readonly description?: string;
  readonly youtubePrivacy: (typeof YOUTUBE_PRIVACY)[number];
  readonly tiktokPrivacy?: (typeof TIKTOK_PRIVACY)[number];
  readonly aiGenerated: boolean;
  readonly confirm: boolean;
}

export interface PlatformResult {
  readonly platform: string;
  readonly status: 'completed' | 'failed' | 'retryable' | 'skipped' | 'queued' | 'processing';
  readonly url?: string;
  readonly postId?: string;
  readonly note?: string;
  readonly error?: string;
  readonly inbox?: boolean;
}

export class UploadPostError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function uploadPostConfig(get: (name: KeyName) => string = getKey): UploadPostConfig {
  return {
    apiKey: get('UPLOAD_POST_API_KEY').trim(),
    profile: get('UPLOAD_POST_PROFILE').trim(),
    baseUrl: (get('UPLOAD_POST_BASE_URL').trim() || UPLOAD_POST_DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

function requireConfig(config: UploadPostConfig): void {
  if (!config.apiKey || !config.profile) {
    throw new UploadPostError(
      412,
      'upload_post_not_configured',
      'Upload-Post is not configured: add the API key and profile name in Settings → Enhanced tools → Social publishing.',
    );
  }
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
  return {
    source,
    platforms,
    title,
    description,
    youtubePrivacy: oneOf(input.youtubePrivacy, YOUTUBE_PRIVACY, 'youtubePrivacy', 'private')!,
    tiktokPrivacy: oneOf(input.tiktokPrivacy, TIKTOK_PRIVACY, 'tiktokPrivacy'),
    aiGenerated: input.aiGenerated === true,
    confirm: input.confirm === true,
  };
}

/** Resolve a `/media/uploads/<name>` render to its file; only video files may be published. */
export async function resolvePublishSource(
  source: string,
  resolve: (name: string) => string | null = resolveUploadFile,
): Promise<{ file: string; name: string; sizeBytes: number; modifiedMs: number }> {
  const clean = source.split(/[?#]/, 1)[0];
  if (!clean.startsWith('/media/uploads/')) {
    throw new UploadPostError(400, 'invalid_source', 'source must be a /media/uploads/ path (the downloadUrl from track_export)');
  }
  let name: string;
  try {
    name = decodeURIComponent(clean.slice('/media/uploads/'.length));
  } catch {
    throw new UploadPostError(400, 'invalid_source', 'invalid source path');
  }
  if (!isSafeUploadName(name)) throw new UploadPostError(400, 'invalid_source', 'invalid source path');
  if (!VIDEO_EXTENSIONS.has(extname(name).toLowerCase())) {
    throw new UploadPostError(400, 'invalid_source', 'only MP4, MOV or WebM video renders can be published');
  }
  const file = resolve(name);
  if (!file) throw new UploadPostError(404, 'source_not_found', `render not found: ${source}`);
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new UploadPostError(422, 'source_empty', 'the render file is empty');
  return { file, name, sizeBytes: info.size, modifiedMs: Math.trunc(info.mtimeMs) };
}

/** Deterministic id: the same file + the same publish fields always map to the same post. */
export function publishRequestId(
  profile: string,
  source: { name: string; sizeBytes: number; modifiedMs: number },
  request: PublishRequest,
): string {
  const identity = JSON.stringify([
    profile, source.name, source.sizeBytes, source.modifiedMs,
    [...request.platforms].sort(), request.title, request.description ?? '',
    request.youtubePrivacy, request.tiktokPrivacy ?? '', request.aiGenerated,
  ]);
  return `ocut-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

async function providerError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { message?: string; error?: string; detail?: string };
    return data.message ?? data.error ?? data.detail ?? `Upload-Post request failed (${response.status})`;
  } catch {
    return text.slice(0, 300) || `Upload-Post request failed (${response.status})`;
  }
}

async function apiGet(config: UploadPostConfig, path: string): Promise<Response> {
  return fetchWithProxy(`${config.baseUrl}${path}`, {
    headers: { Authorization: `Apikey ${config.apiKey}`, 'User-Agent': 'OpenChatCut' },
    signal: AbortSignal.timeout(30_000),
  });
}

/** Platforms that have an account connected on the configured profile. */
export async function connectedPlatforms(config: UploadPostConfig): Promise<string[]> {
  const response = await apiGet(config, `/api/uploadposts/users/${encodeURIComponent(config.profile)}`);
  if (response.status === 401) throw new UploadPostError(401, 'upload_post_auth', 'Upload-Post rejected the API key');
  if (response.status === 404) {
    throw new UploadPostError(404, 'upload_post_profile', `Upload-Post profile "${config.profile}" was not found`);
  }
  if (!response.ok) throw new UploadPostError(502, 'upload_post_http', await providerError(response));
  const data = await response.json() as { profile?: { social_accounts?: Record<string, unknown> } };
  const accounts = data.profile?.social_accounts ?? {};
  return Object.entries(accounts)
    .filter(([, account]) => Boolean(account))
    .map(([platform]) => PLATFORM_ALIASES[platform] ?? platform)
    // Only platforms this tool can publish video to (a profile may also hold e.g. Reddit or Telegram).
    .filter((platform) => (UPLOAD_POST_PLATFORMS as readonly string[]).includes(platform));
}

export function normalizeResults(raw: unknown): PlatformResult[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>).map(([platform, value]) => ({ platform, ...(value as object) }))
      : [];
  return list.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const platform = String(item.platform ?? '');
    const status: PlatformResult['status'] = item.skipped === true
      ? 'skipped'
      : typeof item.status === 'string' && ['completed', 'failed', 'retryable', 'queued', 'processing'].includes(item.status)
        ? item.status as PlatformResult['status']
        : item.success === true ? 'completed' : 'failed';
    const postId = typeof item.platform_post_id === 'string' ? item.platform_post_id : undefined;
    const rawUrl = typeof item.post_url === 'string' ? item.post_url : typeof item.url === 'string' ? item.url : undefined;
    let url = rawUrl?.startsWith('http') ? rawUrl : undefined;
    // Private YouTube videos have no public URL but the owner can still open this one.
    if (!url && platform === 'youtube' && postId) url = `https://www.youtube.com/watch?v=${postId}`;
    const error = status === 'completed' ? undefined : String(item.error_message ?? item.error ?? '') || undefined;
    return {
      platform,
      status,
      ...(url ? { url } : {}),
      ...(postId ? { postId } : {}),
      ...(rawUrl && !url ? { note: rawUrl } : {}),
      ...(error ? { error } : {}),
      ...(item.fallback_to_inbox === true ? { inbox: true } : {}),
    };
  });
}

export interface PublishStatus {
  readonly requestId: string;
  readonly status: string;
  readonly completed?: number;
  readonly total?: number;
  readonly results: PlatformResult[];
}

export async function publishStatus(config: UploadPostConfig, requestId: string): Promise<PublishStatus> {
  requireConfig(config);
  const response = await apiGet(config, `/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`);
  if (response.status === 404) return { requestId, status: 'not_found', results: [] };
  if (response.status === 401) throw new UploadPostError(401, 'upload_post_auth', 'Upload-Post rejected the API key');
  if (!response.ok) throw new UploadPostError(502, 'upload_post_http', await providerError(response));
  const data = await response.json() as Record<string, unknown>;
  return {
    requestId,
    status: String(data.status ?? 'unknown'),
    ...(typeof data.completed === 'number' ? { completed: data.completed } : {}),
    ...(typeof data.total === 'number' ? { total: data.total } : {}),
    results: normalizeResults(data.results),
  };
}

function publishForm(request: PublishRequest, profile: string, requestId: string): FormData {
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
  return form;
}

function videoMime(name: string): string {
  const ext = extname(name).toLowerCase();
  return ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
}

export type PublishOutcome =
  | ({ readonly phase: 'preview'; readonly needsConfirm: true } & PublishPreview)
  | ({ readonly phase: 'submitted' | 'resumed' | 'unconfirmed_delivery' } & PublishStatus);

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
  readonly aiGenerated: boolean;
}

export async function publishToUploadPost(
  config: UploadPostConfig,
  request: PublishRequest,
  resolve: (name: string) => string | null = resolveUploadFile,
): Promise<PublishOutcome> {
  requireConfig(config);
  const source = await resolvePublishSource(request.source, resolve);
  const requestId = publishRequestId(config.profile, source, request);

  if (!request.confirm) {
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
      aiGenerated: request.aiGenerated,
    };
  }

  // An already-accepted id means this exact publish was sent before: resume it, never re-upload.
  const existing = await publishStatus(config, requestId);
  if (existing.status !== 'not_found') return { phase: 'resumed', ...existing };

  const form = publishForm(request, config.profile, requestId);
  // File-backed Blob: the render streams from disk and is never buffered in memory.
  form.append('video', await openAsBlob(source.file, { type: videoMime(source.name) }), source.name);
  let response: Response;
  try {
    response = await fetchWithProxy(`${config.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Apikey ${config.apiKey}`, 'Idempotency-Key': requestId, 'User-Agent': 'OpenChatCut' },
      body: form,
    });
  } catch {
    // The upload may have reached Upload-Post before the connection dropped.
    // Report the id instead of re-sending; the next status poll settles it.
    return { phase: 'unconfirmed_delivery', requestId, status: 'unknown', results: [] };
  }
  if (response.status === 401) throw new UploadPostError(401, 'upload_post_auth', 'Upload-Post rejected the API key');
  if (response.status === 403 || response.status === 429) {
    throw new UploadPostError(response.status, 'upload_post_plan', await providerError(response));
  }
  if (!response.ok) throw new UploadPostError(response.status === 400 ? 400 : 502, 'upload_post_http', await providerError(response));
  return { phase: 'submitted', requestId, status: 'queued', results: [] };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
  const config = uploadPostConfig();
  if (req.method === 'POST' && path === '/publish') {
    const body = await readJsonBody(req).catch((error: unknown) => {
      throw new UploadPostError(400, 'invalid_request', error instanceof Error ? error.message : 'invalid JSON body');
    });
    const request = parsePublishRequest(body);
    sendJson(res, 200, await publishToUploadPost(config, request));
    return;
  }
  const match = /^\/publish\/([^/]+)$/.exec(path);
  if (req.method === 'GET' && match) {
    const requestId = match[1];
    if (!REQUEST_ID.test(requestId)) throw new UploadPostError(400, 'invalid_request', 'invalid publish id');
    sendJson(res, 200, await publishStatus(config, requestId));
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
