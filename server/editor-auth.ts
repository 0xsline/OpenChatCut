import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';
import type { EditorBootstrapInfo } from '../shared/editor-auth-transport.ts';
import { isLoopbackAddress } from './loopback-address.ts';

export const EDITOR_BOOTSTRAP_HEADER = 'x-openchatcut-editor-bootstrap';
export const EDITOR_TOKEN_HEADER = 'x-openchatcut-editor-token';

const generatedEditorToken = randomBytes(32).toString('base64url');
const generatedMcpToken = randomBytes(32).toString('base64url');
const LOCAL_EDITOR_HOSTS: Readonly<Record<string, true>> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
};

export function externalMcpToken(): string {
  return process.env.OPENCHATCUT_MCP_TOKEN?.trim() || generatedMcpToken;
}

/** Process-local capability used only by the renderer-facing editor APIs. */
export function editorApiToken(): string {
  return generatedEditorToken;
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export function externalMcpAuthorized(req: IncomingMessage): boolean {
  return secretMatches(req.headers.authorization, `Bearer ${externalMcpToken()}`);
}

export function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' && value ? value : null;
}

export function configuredEditorOrigin(): string | null {
  const configured = process.env.OPENCHATCUT_EDITOR_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function requestEditorOrigin(req: IncomingMessage): string | null {
  const host = headerValue(req, 'host');
  if (!host || /[/\\@?#,\s]/.test(host)) return null;
  const configured = process.env.OPENCHATCUT_EDITOR_URL?.trim();
  const expected = configuredEditorOrigin();
  if (configured && !expected) return null;
  const protocol = expected
    ? new URL(expected).protocol
    : req.socket instanceof TLSSocket ? 'https:' : 'http:';
  try {
    const actual = new URL(`${protocol}//${host}`);
    if (expected) return actual.origin === expected ? expected : null;
    return LOCAL_EDITOR_HOSTS[actual.hostname.toLowerCase()] === true ? actual.origin : null;
  } catch {
    return null;
  }
}

export function trustedEditorRequest(req: IncomingMessage, requireOrigin: boolean): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const expected = requestEditorOrigin(req);
  if (!expected) return false;
  const origin = headerValue(req, 'origin');
  if (!origin) return !requireOrigin;
  try {
    return new URL(origin).origin === origin && origin === expected;
  } catch {
    return false;
  }
}

/** Editor-capable endpoints require both the trusted loopback request shape and
 *  the independent, per-process editor token. */
export function editorCredentialAuthorized(req: IncomingMessage, requireOrigin: boolean): boolean {
  return trustedEditorRequest(req, requireOrigin)
    && secretMatches(headerValue(req, EDITOR_TOKEN_HEADER) ?? undefined, editorApiToken());
}

export function editorBootstrapPayload(): EditorBootstrapInfo {
  return {
    editorToken: editorApiToken(),
    mcpToken: externalMcpToken(),
  };
}

/** Browser dev bootstrap grants only the renderer-facing capability. External
 * MCP credentials are never exposed over HTTP. */
export function editorHttpBootstrapPayload(): EditorBootstrapInfo {
  return { editorToken: editorApiToken() };
}
