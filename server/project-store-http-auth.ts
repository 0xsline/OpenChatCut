import type { IncomingMessage } from 'node:http';
import { runtimeProfile, type RuntimeProfile } from './runtime-profile.ts';
import { isLoopbackAddress } from './loopback-address.ts';

/**
 * Local-device trust model (no shared secrets).
 *
 * The editor and project store are served from loopback bindings only, so the
 * listening port itself is a weak secret. Requests are authorized by what a
 * browser cannot spoof:
 *
 *   - the socket must arrive on a loopback address,
 *   - the Host header must name a loopback host (defeats DNS rebinding),
 *   - state-changing requests must carry an Origin matching Host (browsers
 *     attach Origin to every fetch POST/PUT/DELETE; a cross-site page cannot
 *     fabricate it),
 *   - Sec-Fetch-Site is browser-enforced and marks cross-site form posts,
 *     navigation and subresource loads; direct local tooling (curl) sends
 *     `none`.
 *
 * There is no launch token, no session handshake and no process-local
 * session state: any loopback editor tab is fully trusted, exactly like
 * Vite/webpack-dev-server local tooling. Reads additionally allow direct
 * local navigation without an Origin header.
 */

export function projectStoreAuthDir(profile: RuntimeProfile = runtimeProfile()): string {
  return profile.authDir;
}

function loopbackHost(value: string | undefined): value is string {
  if (!value) return false;
  const lower = value.toLowerCase();
  const host = lower.startsWith('[')
    ? lower.slice(1, lower.indexOf(']'))
    : lower.split(':', 1)[0];
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function header(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : null;
}

function trustedLoopback(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress) && loopbackHost(req.headers.host);
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = header(req, 'origin');
  if (!origin || !req.headers.host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host.toLowerCase() === req.headers.host.toLowerCase();
  } catch {
    return false;
  }
}

function browserEnforcedRequest(req: IncomingMessage): boolean {
  const site = header(req, 'sec-fetch-site');
  return site === 'same-origin' || site === 'none';
}

/** Read-only access: loopback requests from same-origin pages (or direct
 *  local navigation) may read the active runtime profile's project library. */
export function projectStoreReadAuthorized(req: IncomingMessage): boolean {
  return trustedLoopback(req) && browserEnforcedRequest(req);
}

/** Write access: loopback, same-origin, browser-enforced requests only. */
export function projectStoreHttpAuthorized(req: IncomingMessage): boolean {
  return trustedLoopback(req) && browserEnforcedRequest(req) && sameOrigin(req);
}

export function resetProjectStoreHttpAuthForTests(): void {
  // There is no process-local auth state anymore; kept as a stable test seam.
}
