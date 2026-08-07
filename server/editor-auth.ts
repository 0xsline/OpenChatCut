import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';
import type { EditorBootstrapInfo } from '../shared/editor-auth-transport.ts';
import { projectStoreHttpAuthorized } from './project-store-http-auth.ts';

export const EDITOR_CREDENTIAL_HEADER = 'x-openchatcut-editor-credential';
export const EDITOR_BOOTSTRAP_HEADER = 'x-openchatcut-editor-bootstrap';

const editorCredential = randomBytes(32).toString('base64url');
const generatedMcpToken = randomBytes(32).toString('base64url');
const LOCAL_EDITOR_HOSTS: Readonly<Record<string, true>> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
};

export function externalMcpToken(): string {
  return process.env.OPENCHATCUT_MCP_TOKEN?.trim() || generatedMcpToken;
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
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

export function editorCredentialAuthorized(req: IncomingMessage, requireOrigin: boolean): boolean {
  if (!trustedEditorRequest(req, requireOrigin)) return false;
  const credential = headerValue(req, EDITOR_CREDENTIAL_HEADER) ?? undefined;
  return secretMatches(credential, editorCredential) || projectStoreHttpAuthorized(req);
}

export function editorBootstrapPayload(): EditorBootstrapInfo {
  return { credential: editorCredential, mcpToken: externalMcpToken() };
}
