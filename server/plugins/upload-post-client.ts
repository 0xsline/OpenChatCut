import { getKey } from '../keystore.ts';
import type { KeyName } from '../keystore-names.ts';
import { proxyDispatcher } from '../outbound-proxy.ts';

// Thin Upload-Post API client (https://docs.upload-post.com): configuration,
// read endpoints and result normalization. The publish flow lives in
// upload-post.ts.

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
export const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

export const UPLOAD_POST_DEFAULT_BASE_URL = 'https://api.upload-post.com';
export const UPLOAD_POST_PLATFORMS = [
  'tiktok', 'instagram', 'youtube', 'linkedin', 'facebook', 'x', 'threads', 'pinterest', 'bluesky',
] as const;
export type UploadPostPlatform = (typeof UPLOAD_POST_PLATFORMS)[number];
export const PLATFORM_ALIASES: Record<string, UploadPostPlatform> = { twitter: 'x', reels: 'instagram', shorts: 'youtube' };
/** Read calls stay well inside the agent's 30-second tool deadline. */
const READ_TIMEOUT_MS = 15_000;

export interface UploadPostConfig {
  readonly apiKey: string;
  readonly profile: string;
  readonly baseUrl: string;
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

export interface PublishStatus {
  readonly requestId: string;
  readonly status: string;
  readonly completed?: number;
  readonly total?: number;
  readonly results: PlatformResult[];
  readonly note?: string;
  readonly error?: string;
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

export function requireConfig(config: UploadPostConfig): void {
  if (!config.apiKey || !config.profile) {
    throw new UploadPostError(
      412,
      'upload_post_not_configured',
      'Upload-Post is not configured: add the API key and profile name in Settings → Enhanced tools → Social publishing.',
    );
  }
}

export async function providerError(response: Response): Promise<string> {
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
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
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

/** Provider-side status of a request id. `not_found` means Upload-Post has no record of it (yet). */
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
