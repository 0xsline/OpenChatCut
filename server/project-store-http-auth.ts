import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

export const PROJECT_STORE_LAUNCH_TOKEN_HEADER = 'x-openchatcut-editor-launch-token';
export const PROJECT_STORE_SESSION_HEADER = 'x-openchatcut-project-store-session';
const TOKEN_ENV = 'OPENCHATCUT_EDITOR_LAUNCH_TOKEN';
const AUTH_DIR_ENV = 'OPENCHATCUT_PROJECT_STORE_AUTH_DIR';
const MIN_TOKEN_LENGTH = 32;
const generatedLaunchToken = randomBytes(32).toString('base64url');

interface ProjectStoreSession {
  readonly token: string;
  readonly host: string;
  readonly remoteAddress: string;
}

let activeSession: ProjectStoreSession | null = null;

function authDir(): string {
  const configured = process.env[AUTH_DIR_ENV]?.trim();
  return configured || join(homedir(), '.openchatcut', 'project-store-auth-v1');
}

const SESSION_FILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
let lastSessionPruneAt = 0;

/** Remove long-dead persisted sessions (one per host/port binding) so the
 *  auth directory cannot grow unbounded across dev port changes. */
function pruneStaleSessionFiles(): void {
  const now = Date.now();
  if (now - lastSessionPruneAt < SESSION_PRUNE_INTERVAL_MS) return;
  lastSessionPruneAt = now;
  try {
    const directory = authDir();
    for (const name of readdirSync(directory)) {
      if (!name.startsWith('session-')) continue;
      const path = join(directory, name);
      if (now - statSync(path).mtimeMs > SESSION_FILE_MAX_AGE_MS) {
        rmSync(path, { force: true });
      }
    }
  } catch {
    // Best-effort cleanup; never block auth on it.
  }
}

function ensureAuthDir(): string {
  const directory = authDir();
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


/** Origin is a loopback host (localhost / 127.0.0.1 / ::1) on ANY port. */

/**
 * Read-only authorization WITHOUT a session: same-origin pages (or direct
 * local navigation, e.g. curl) served from a loopback host may read the
 * shared project library. This keeps every dev port / desktop window
 * consistent (a project deleted on port 5199 must not reappear on port
 * 5202's stale local cache). Sec-Fetch-Site is browser-enforced and cannot
 * be spoofed by cross-origin pages; writes still require a real session.
 */
export function projectStoreReadAuthorized(req: IncomingMessage): boolean {
  const site = header(req, 'sec-fetch-site');
  if (site !== 'same-origin' && site !== 'none') return false;
  return trustedLoopback(req);
}

export function exchangeProjectStoreLaunchToken(
  req: IncomingMessage,
): { sessionToken: string } | null {
  if (!trustedLoopback(req) || !sameOrigin(req)) return null;
  const actualLaunch = header(req, PROJECT_STORE_LAUNCH_TOKEN_HEADER);
  if (!actualLaunch || !equalSecret(actualLaunch, configuredLaunchToken())) return null;

  const current = activeSession;
  if (current?.host === req.headers.host.toLowerCase()
    && current.remoteAddress === req.socket.remoteAddress) {
    return { sessionToken: current.token };
  }
  const session: ProjectStoreSession = {
    token: randomBytes(32).toString('base64url'),
    host: req.headers.host.toLowerCase(),
    remoteAddress: req.socket.remoteAddress,
  };
  activeSession = session;
  return { sessionToken: session.token };
}

export function projectStoreHttpAuthorized(req: IncomingMessage): boolean {
  if (!trustedLoopback(req)) return false;
  const session = activeSession;
  if (!session || session.host !== req.headers.host.toLowerCase()
    || session.remoteAddress !== req.socket.remoteAddress) return false;
  const actual = header(req, PROJECT_STORE_SESSION_HEADER);
  return actual !== null && equalSecret(actual, session.token);
}

export function resetProjectStoreHttpAuthMemoryForTests(): void {
  activeSession = null;
}

export function resetProjectStoreHttpAuthForTests(): void {
  resetProjectStoreHttpAuthMemoryForTests();
}
