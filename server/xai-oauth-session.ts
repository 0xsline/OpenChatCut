// xAI subscription session for the built-in Agent, managed server-side.
//
// Login itself is owned by the official Grok CLI (`grok login`, OAuth at
// auth.x.ai) and persisted by it in ~/.grok/auth.json. This module imports
// that session on explicit user action, keeps its own copy under the active
// runtime profile, refreshes it through the first-party token endpoint before
// expiry, and mirrors the current access token into the keystore so the llm
// proxy, the connection test, and model selection all read it through the
// normal provider path. Secrets never leave the server.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setKeys } from './keystore.ts';
import { proxyDispatcher } from './outbound-proxy.ts';
import { runtimeProfile } from './runtime-profile.ts';

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
const TOKEN_ENDPOINT = `${XAI_OAUTH_ISSUER}/oauth2/token`;
const CLI_AUTH_JSON = join(homedir(), '.grok', 'auth.json');
const SESSION_FILE = join(runtimeProfile().rootDir, 'xai-oauth-session.json');
const ACCESS_KEY = 'LLM_XAI_OAUTH_API_KEY';
// The Grok CLI keys its session by "<issuer>::<client id>"; accept the
// first-party issuer with any UUID-shaped public client id so a future CLI
// client rotation still imports.
const OUTER_KEY = /^https:\/\/auth\.x\.ai::([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const REFRESH_SKEW_MS = 120_000;
const TOKEN_TIMEOUT_MS = 15_000;
const DEFAULT_EXPIRES_SECONDS = 3600;
const MAX_FIELD_LENGTH = 4096;

export interface XaiOauthStatus {
  readonly found: boolean;
  readonly email: string;
  readonly expiresAt: number;
  readonly error: string;
}

interface XaiSession {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: number;
  readonly clientId: string;
  readonly email: string;
}

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH
    ? value
    : '';
}

function finitePositive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse the official CLI session file; returns null on any shape violation. */
export function parseGrokAuthJson(text: string): XaiSession | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  for (const [key, value] of Object.entries(doc)) {
    const match = OUTER_KEY.exec(key);
    if (!match || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const access = nonEmptyString(entry.key);
    const refresh = nonEmptyString(entry.refresh_token);
    if (!access || !refresh) continue;
    return {
      access,
      refresh,
      expiresAt: finitePositive(entry.expires_at),
      clientId: match[1],
      email: typeof entry.email === 'string' ? entry.email.slice(0, 200) : '',
    };
  }
  return null;
}

function validSession(value: unknown): XaiSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const access = nonEmptyString(entry.access);
  const refresh = nonEmptyString(entry.refresh);
  const clientId = nonEmptyString(entry.clientId);
  if (!access || !refresh || !clientId) return null;
  return {
    access,
    refresh,
    expiresAt: finitePositive(entry.expiresAt),
    clientId,
    email: typeof entry.email === 'string' ? entry.email.slice(0, 200) : '',
  };
}

export function readSessionFile(): XaiSession | null {
  try {
    return validSession(JSON.parse(readFileSync(SESSION_FILE, 'utf8')));
  } catch {
    return null;
  }
}

export function persistSession(session: XaiSession): void {
  const tmp = `${SESSION_FILE}.tmp`;
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 });
  renameSync(tmp, SESSION_FILE);
  chmodSync(SESSION_FILE, 0o600);
}

export function dropSessionFile(): void {
  rmSync(SESSION_FILE, { force: true });
}

let current: XaiSession | null = null;
let statusError = '';
let timer: NodeJS.Timeout | null = null;
let initStarted = false;

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function armTimer(): void {
  clearTimer();
  if (!current || current.expiresAt <= 0) return;
  const delay = Math.max(1_000, current.expiresAt - Date.now() - REFRESH_SKEW_MS);
  timer = setTimeout(() => {
    void ensureFreshXaiOauth().catch(() => {});
  }, delay);
  timer.unref();
}

export async function refreshTokens(session: XaiSession): Promise<XaiSession> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refresh,
    client_id: session.clientId,
  });
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    dispatcher: proxyDispatcher(),
  } as FetchInit);
  if (!response.ok) {
    let code = '';
    try {
      const payload = (await response.json()) as { error?: unknown };
      code = typeof payload.error === 'string' ? payload.error : '';
    } catch {
      // Non-JSON failure keeps the status only.
    }
    throw new Error(`refresh HTTP ${response.status}${code ? ` · ${code.slice(0, 60)}` : ''}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const access = nonEmptyString(payload.access_token);
  if (!access) throw new Error('refresh response missing access_token');
  const expiresIn = finitePositive(payload.expires_in) || DEFAULT_EXPIRES_SECONDS;
  const rotated = nonEmptyString(payload.refresh_token);
  return {
    ...session,
    access,
    refresh: rotated || session.refresh,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

function invalidateSession(): void {
  clearTimer();
  current = null;
  statusError = '登录会话已失效，请重新导入。';
  dropSessionFile();
  void setKeys({ [ACCESS_KEY]: '' });
}

/** Refresh before expiry; a revoked grant invalidates the local session. */
export async function ensureFreshXaiOauth(): Promise<void> {
  if (!current) return;
  clearTimer();
  if (current.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    armTimer();
    return;
  }
  try {
    const next = await refreshTokens(current);
    current = next;
    statusError = '';
    persistSession(next);
    await setKeys({ [ACCESS_KEY]: next.access });
  } catch (error) {
    const message = messageOf(error);
    if (message.includes('invalid_grant')) {
      invalidateSession();
      return;
    }
    statusError = message.slice(0, 160);
    armTimer();
  }
}

/** Load the persisted session and re-arm the refresh timer (server start). */
export async function initXaiOauth(): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  const stored = readSessionFile();
  if (stored) {
    current = stored;
    await setKeys({ [ACCESS_KEY]: stored.access });
    await ensureFreshXaiOauth();
  } else {
    await setKeys({ [ACCESS_KEY]: '' });
  }
}

/** Sync accessor for the llm proxy: the freshest token or an empty string. */
export function xaiOauthAccessToken(): string {
  return current?.access ?? '';
}

export function xaiOauthStatus(): XaiOauthStatus {
  return current
    ? { found: true, email: current.email, expiresAt: current.expiresAt, error: statusError }
    : { found: false, email: '', expiresAt: 0, error: statusError };
}

/** Adopt the official CLI session on explicit user action. */
export async function importXaiOauthFromCli(): Promise<XaiOauthStatus> {
  let text: string;
  try {
    text = readFileSync(CLI_AUTH_JSON, 'utf8');
  } catch {
    throw new Error('未找到 ~/.grok/auth.json。请先在终端运行官方 Grok CLI 登录：grok login，完成后回来点击导入。');
  }
  const parsed = parseGrokAuthJson(text);
  if (!parsed) {
    throw new Error('无法解析 ~/.grok/auth.json 中的登录会话。请先在终端运行 grok login 完成登录。');
  }
  statusError = '';
  try {
    current = parsed.expiresAt - Date.now() > REFRESH_SKEW_MS
      ? parsed
      : await refreshTokens(parsed);
    persistSession(current);
    await setKeys({ [ACCESS_KEY]: current.access });
    armTimer();
  } catch (error) {
    current = null;
    throw new Error(`登录会话已读取但刷新失败：${messageOf(error)}`);
  }
  return xaiOauthStatus();
}

export async function logoutXaiOauth(): Promise<void> {
  clearTimer();
  current = null;
  statusError = '';
  dropSessionFile();
  await setKeys({ [ACCESS_KEY]: '' });
}
