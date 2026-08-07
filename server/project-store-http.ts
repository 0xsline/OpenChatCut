import type { IncomingMessage, ServerResponse } from 'node:http';
import { isProjectStoreEntries, isProjectStoreKey } from '../shared/project-store-validation.ts';
import type { ProjectStoreResponse } from '../shared/project-store-transport.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

interface ProjectStoreHttpOperations {
  deleteEntry(key: string): Promise<void>;
  getEntry(key: string): Promise<ProjectStoreResponse>;
  mergeEntries(entries: Record<string, unknown>): Promise<{ entries: Record<string, unknown> }>;
  readSnapshot(): Promise<ProjectStoreResponse>;
  setEntry(key: string, value: unknown): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('invalid JSON body');
  }
  if (!isRecord(parsed)) throw new Error('body must be a JSON object');
  return parsed;
}

export function sendProjectStoreJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function entryKey(req: IncomingMessage): string | null {
  const key = new URL(req.url ?? '', 'http://localhost').searchParams.get('key');
  return isProjectStoreKey(key) ? key : null;
}

export async function handleProjectStoreRequest(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<void> {
  if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
    sendProjectStoreJson(res, 200, await operations.readSnapshot());
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/entry?')) {
    const key = entryKey(req);
    if (!key) throw new Error('invalid entry key');
    sendProjectStoreJson(res, 200, await operations.getEntry(key));
    return;
  }
  if (req.method === 'POST' && req.url === '/merge') {
    const body = await readBody(req);
    if (!isProjectStoreEntries(body.entries)) throw new Error('invalid project store entries');
    const merged = await operations.mergeEntries(body.entries);
    const projects = merged.entries.projects;
    sendProjectStoreJson(res, 200, { version: 1, entries: projects === undefined ? {} : { projects } });
    return;
  }
  if (req.method === 'PUT' && req.url === '/entry') {
    const body = await readBody(req);
    if (!isProjectStoreKey(body.key) || !Object.hasOwn(body, 'value')) throw new Error('invalid entry');
    await operations.setEntry(body.key, body.value);
    sendProjectStoreJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'DELETE' && req.url?.startsWith('/entry?')) {
    const key = entryKey(req);
    if (!key) throw new Error('invalid entry key');
    await operations.deleteEntry(key);
    sendProjectStoreJson(res, 200, { ok: true });
    return;
  }
  sendProjectStoreJson(res, 405, { error: 'method not allowed' });
}
