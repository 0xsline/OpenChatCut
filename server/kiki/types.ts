// KikiVoice (kikivoice.ai) integration types.
// Auth is COOKIE-based (no API key). The cookie lives in an Electron `persist:partition`
// session and travels automatically via the transport's session-bound requests.
// R2 spike validated: Electron `net` (Chromium TLS) passes Cloudflare where Node fetch is blocked.

export type KikiHeaders = Record<string, string>;

export interface KikiResponse {
  status: number;
  ok: boolean;
  headers: KikiHeaders;
  text(): Promise<string>;
  bytes(): Promise<Buffer>;
}

export interface KikiFilePart {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface KikiGetOptions {
  params?: Record<string, string>;
  headers?: KikiHeaders;
  timeoutMs?: number;
}

export interface KikiPostFormOptions {
  headers?: KikiHeaders;
  timeoutMs?: number;
}

/**
 * HTTP transport for KikiVoice. Implementations bind cookies + Chromium TLS:
 *  - ElectronKikiTransport: `net.request({ session })` — cookies auto-attached, Chromium TLS (passes Cloudflare). Desktop only.
 * No Node-fetch fallback exists: Node TLS is Cloudflare-blocked (spike `.omc/spikes/kiki-cloudflare.mjs`:
 * Node fetch → 403 cf-challenge; Electron net → 200). So in browser-dev KikiVoice returns "requires desktop".
 */
export interface KikiTransport {
  get(url: string, opts?: KikiGetOptions): Promise<KikiResponse>;
  postForm(
    url: string,
    fields: Record<string, string>,
    files?: Record<string, KikiFilePart>,
    opts?: KikiPostFormOptions,
  ): Promise<KikiResponse>;
}

export class KikiError extends Error {
  readonly expired: boolean;
  readonly missing: boolean;
  constructor(message: string, expired = false, missing = false) {
    super(message);
    this.name = 'KikiError';
    this.expired = expired;
    this.missing = missing;
  }
}

export interface KikiQuotaSnapshot {
  available?: number;
  used?: number;
  max?: number;
  publicIp?: string;
  nextResetDays?: number;
  /** monotonic ms when captured (the badge treats >N min as stale) */
  capturedAtMonotonic?: number;
}
