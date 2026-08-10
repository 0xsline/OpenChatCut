import {
  createHmac, randomBytes, timingSafeEqual,
} from 'node:crypto';
import {
  chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runtimeProfile, type RuntimeProfile } from './runtime-profile.ts';

export const PROJECT_STORE_LAUNCH_TOKEN_HEADER = 'x-openchatcut-editor-launch-token';
export const PROJECT_STORE_SESSION_HEADER = 'x-openchatcut-project-store-session';
/** Browser cookie carrying the signed, stateless editor session. */
export const PROJECT_STORE_SESSION_COOKIE = 'occ_ps';
const TOKEN_ENV = 'OPENCHATCUT_EDITOR_LAUNCH_TOKEN';
const NO_AUTH_ENV = 'OPENCHATCUT_DISABLE_LAUNCH_AUTH';
const MIN_TOKEN_LENGTH = 32;
const generatedLaunchToken = randomBytes(32).toString('base64url');
/** How long a signed session stays valid before the browser must re-exchange. */
export const SESSION_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * Personal-use escape hatch: with OPENCHATCUT_DISABLE_LAUNCH_AUTH=1 (or 'true')
 * any loopback request is authorized without a launch token or session, so the
 * editor can be opened from a bare URL. Default is OFF: the token/session flow
 * remains the shipped behavior for everyone else and for CI.
 */
export function launchAuthDisabled(): boolean {
  const value = process.env[NO_AUTH_ENV]?.trim().toLowerCase() ?? '';
  return value === '1' || value === 'true';
}

export function projectStoreAuthDir(profile: RuntimeProfile = runtimeProfile()): string {
  return profile.authDir;
}

const SESSION_KEY_FILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
let lastSessionPruneAt = 0;

/** Remove long-dead persisted session key files so the auth directory cannot
 *  grow unbounded across dev port changes. */
function pruneStaleSessionFiles(): void {
  const now = Date.now();
  if (now - lastSessionPruneAt < SESSION_PRUNE_INTERVAL_MS) return;
  lastSessionPruneAt = now;
  try {
    const directory = projectStoreAuthDir();
    for (const name of readdirSync(directory)) {
      if (!name.startsWith('session-key-')) continue;
      const path = join(directory, name);
      if (now - statSync(path).mtimeMs > SESSION_KEY_FILE_MAX_AGE_MS) {
        rmSync(path, { force: true });
      }
    }
  } catch {
    // Best-effort cleanup; never block auth on it.
  }
}

function ensureAuthDir(): string {
  const directory = projectStoreAuthDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* best-effort on non-POSIX filesystems */ }
  pruneStaleSessionFiles();
  return directory;
}

function validToken(value: string): boolean {
  return value.trim().length >= MIN_TOKEN_LENGTH;
}

function readTokenFile(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return validToken(value) ? value : null;
  } catch {
    return null;
  }
}

function atomicWritePrivate(path: string, value: string): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      renameSync(temporary, path);
    } catch {
      // Windows cannot atomically replace an existing destination with rename.
      rmSync(path, { force: true });
      renameSync(temporary, path);
    }
    try { chmodSync(path, 0o600); } catch { /* best-effort on non-POSIX filesystems */ }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function persistentLaunchToken(): string {
  const path = join(ensureAuthDir(), 'launch-token');
  const existing = readTokenFile(path);
  if (existing) return existing;
  try {
    writeFileSync(path, generatedLaunchToken, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code !== 'EEXIST') throw error;
  }
  const winner = readTokenFile(path);
  if (winner) return winner;
  atomicWritePrivate(path, generatedLaunchToken);
  return generatedLaunchToken;
}

function configuredLaunchToken(): string {
  const token = process.env[TOKEN_ENV]?.trim() ?? '';
  return validToken(token) ? token : persistentLaunchToken();
}

export function projectStoreLaunchToken(): string {
  return configuredLaunchToken();
}

/** The persistent HMAC signer for editor sessions. Derived from the stable
 *  launch token so a server restart keeps validating previously-issued
 *  cookies (no process-local memory to lose). */
function sessionSignerKey(): Buffer {
  const launch = configuredLaunchToken();
  return createHmac('sha256', launch).update('openchatcut:project-store-session:v1').digest();
}

/**
 * Build a signed, stateless session cookie value for the given host.
 * payload = host, signature = HMAC(signerKey, host). The browser sends it
 * back on every same-origin request; the server verifies the HMAC and host
 * with no shared memory, so it survives restart and tab relaunch.
 */
export function signEditorSession(host: string): string {
  const key = sessionSignerKey();
  const sig = createHmac('sha256', key).update(host).digest('base64url');
  return Buffer.from(host, 'utf8').toString('base64url') + '.' + sig;
}

function verifyEditorSession(host: string, cookie: string): boolean {
  if (!cookie) return false;
  const dot = cookie.indexOf('.');
  if (dot < 0) return false;
  const payload = cookie.slice(0, dot);
  const providedSig = cookie.slice(dot + 1);
  const expectedHost = Buffer.from(payload, 'base64url').toString('utf8');
  if (expectedHost !== host) return false;
  const key = sessionSignerKey();
  const expectedSig = createHmac('sha256', key).update(expectedHost).digest('base64url');
  const left = Buffer.from(providedSig);
  const right = Buffer.from(expectedSig);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function setProjectStoreSessionCookie(res: ServerResponse, host: string): void {
  const value = signEditorSession(host);
  res.setHeader('Set-Cookie', [
    `${PROJECT_STORE_SESSION_COOKIE}=${value}`,
    'HttpOnly', 'SameSite=Lax', 'Path=/',
    `Max-Age=${SESSION_COOKIE_MAX_AGE_S}`,
  ].join('; '));
}

function loopbackAddress(value: string | undefined): value is string {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function loopbackHost(value: string | undefined): value is string {
  if (!value) return false;
  const lower = value.toLowerCase();
  const host = lower.startsWith('[')
    ? lower.slice(1, lower.indexOf(']'))
    : lower.split(':', 1)[0];
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function equalSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function header(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : null;
}

function trustedLoopback(req: IncomingMessage): req is IncomingMessage & {
  socket: IncomingMessage['socket'] & { remoteAddress: string };
  headers: IncomingMessage['headers'] & { host: string };
} {
  return loopbackAddress(req.socket.remoteAddress) && loopbackHost(req.headers.host);
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

/**
 * Read-only authorization without a session: same-origin pages (or direct
 * local navigation, e.g. curl) served from a loopback host may read the
 * active runtime profile's project library. Sec-Fetch-Site is browser-enforced
 * and cannot be spoofed by cross-origin pages; writes still require a real
 * session. Isolated development ports resolve to distinct profile stores.
 */
export function projectStoreReadAuthorized(req: IncomingMessage): boolean {
  const site = header(req, 'sec-fetch-site');
  if (site !== 'same-origin' && site !== 'none') return false;
  return trustedLoopback(req);
}

/**
 * Exchange a launch credential for a session. In no-auth mode any loopback
 * same-origin request is granted. In secured mode the launch token header must
 * match the configured/persisted launch token; the returned `sessionToken` is a
 * signed, stateless value that verifies via HMAC with no process memory.
 */
export function exchangeProjectStoreLaunchToken(
  req: IncomingMessage,
): { sessionToken: string } | null {
  if (launchAuthDisabled() && trustedLoopback(req) && sameOrigin(req)) {
    return { sessionToken: signEditorSession((header(req, 'host') ?? 'localhost:5199').toLowerCase()) };
  }
  if (!trustedLoopback(req) || !sameOrigin(req)) return null;
  const actualLaunch = header(req, PROJECT_STORE_LAUNCH_TOKEN_HEADER);
  if (!actualLaunch || !equalSecret(actualLaunch, configuredLaunchToken())) return null;
  return { sessionToken: signEditorSession((header(req, 'host') ?? 'localhost:5199').toLowerCase()) };
}

/** Read the signed editor session from a request cookie (or legacy header). */
function sessionCredential(req: IncomingMessage): string | null {
  const host = (header(req, 'host') ?? '').toLowerCase();
  if (!host) return null;
  const cookie = header(req, 'cookie');
  if (cookie) {
    const match = cookie.split(';').map((c) => c.trim())
      .find((c) => c.startsWith(`${PROJECT_STORE_SESSION_COOKIE}=`));
    if (match) {
      const value = match.slice(PROJECT_STORE_SESSION_COOKIE.length + 1);
      if (verifyEditorSession(host, value)) return value;
    }
  }
  // Back-compat: the legacy explicit session header, still signed/verifiable.
  const legacy = header(req, PROJECT_STORE_SESSION_HEADER);
  return legacy && verifyEditorSession(host, legacy) ? legacy : null;
}

export function projectStoreHttpAuthorized(req: IncomingMessage): boolean {
  if (!trustedLoopback(req)) return false;
  if (launchAuthDisabled()) return true;
  return sessionCredential(req) !== null;
}

export function resetProjectStoreHttpAuthMemoryForTests(): void {
  // Stateless signed sessions have no process memory to clear; kept as a no-op
  // so existing tests that reset between scenarios still behave deterministically.
}

export function resetProjectStoreHttpAuthForTests(): void {
  resetProjectStoreHttpAuthMemoryForTests();
}
