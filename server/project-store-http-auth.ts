import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const PROJECT_STORE_LAUNCH_TOKEN_HEADER = 'x-openchatcut-editor-launch-token';
export const PROJECT_STORE_SESSION_HEADER = 'x-openchatcut-project-store-session';
const TOKEN_ENV = 'OPENCHATCUT_EDITOR_LAUNCH_TOKEN';
const MIN_TOKEN_LENGTH = 32;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const generatedLaunchToken = randomBytes(32).toString('base64url');

interface ProjectStoreSession {
  readonly token: string;
  readonly host: string;
  readonly remoteAddress: string;
  readonly expiresAt: number;
}

let launchConsumed = false;
let activeSession: ProjectStoreSession | null = null;

function configuredLaunchToken(): string {
  const token = process.env[TOKEN_ENV]?.trim() ?? '';
  return token.length >= MIN_TOKEN_LENGTH ? token : generatedLaunchToken;
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

export function exchangeProjectStoreLaunchToken(
  req: IncomingMessage,
): { sessionToken: string; expiresAt: number } | null {
  if (launchConsumed || !trustedLoopback(req) || !sameOrigin(req)) return null;
  const actual = header(req, PROJECT_STORE_LAUNCH_TOKEN_HEADER);
  if (!actual || !equalSecret(actual, configuredLaunchToken())) return null;
  const session: ProjectStoreSession = {
    token: randomBytes(32).toString('base64url'),
    host: req.headers.host.toLowerCase(),
    remoteAddress: req.socket.remoteAddress,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  launchConsumed = true;
  activeSession = session;
  return { sessionToken: session.token, expiresAt: session.expiresAt };
}

export function projectStoreHttpAuthorized(req: IncomingMessage): boolean {
  const session = activeSession;
  if (!session || session.expiresAt <= Date.now() || !trustedLoopback(req)) return false;
  if (req.headers.host.toLowerCase() !== session.host || req.socket.remoteAddress !== session.remoteAddress) return false;
  const actual = header(req, PROJECT_STORE_SESSION_HEADER);
  return actual !== null && equalSecret(actual, session.token);
}

export function resetProjectStoreHttpAuthForTests(): void {
  launchConsumed = false;
  activeSession = null;
}
