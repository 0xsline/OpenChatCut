import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const DEFAULT_ROOT_DIR = join(homedir(), '.openchatcut', 'plugins');
const FORMAT = 'openchatcut-plugin@1';
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

interface IndexEntry {
  id: string;
  version: string;
  enabled: boolean;
  installedAt: number;
}

type StoredPack = Record<string, unknown> & {
  id: string;
  version: string;
  installedAt: number;
  enabled: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function validVersion(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 80
    && !value.includes('\0')
    && !value.includes('\r')
    && !value.includes('\n');
}

function validPack(value: unknown): StoredPack | null {
  if (!isRecord(value) || value.format !== FORMAT || !ID_RE.test(String(value.id ?? ''))) return null;
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 60) return null;
  if (!validVersion(value.version) || !Array.isArray(value.items) || value.items.length > 64) return null;
  if (typeof value.installedAt !== 'number' || !Number.isFinite(value.installedAt)) return null;
  return {
    ...value,
    id: String(value.id),
    version: value.version,
    installedAt: value.installedAt,
    enabled: value.enabled !== false,
  };
}

function validIndexEntry(value: unknown): IndexEntry | null {
  if (!isRecord(value) || !ID_RE.test(String(value.id ?? '')) || !validVersion(value.version)) return null;
  if (typeof value.installedAt !== 'number' || !Number.isFinite(value.installedAt)) return null;
  return {
    id: String(value.id),
    version: value.version,
    enabled: value.enabled !== false,
    installedAt: value.installedAt,
  };
}

const versionFolder = (version: string) => Buffer.from(version, 'utf8').toString('base64url') || '_';
const manifestPath = (rootDir: string, entry: Pick<IndexEntry, 'id' | 'version'>) =>
  join(rootDir, entry.id, versionFolder(entry.version), 'manifest.json');

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

async function readIndex(rootDir: string): Promise<IndexEntry[]> {
  try {
    const raw = JSON.parse(await readFile(join(rootDir, 'index.json'), 'utf8')) as unknown;
    return Array.isArray(raw)
      ? raw.map(validIndexEntry).filter((entry): entry is IndexEntry => entry !== null)
      : [];
  } catch {
    return [];
  }
}

async function writeIndex(rootDir: string, entries: IndexEntry[]): Promise<void> {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await atomicWrite(join(rootDir, 'index.json'), entries);
}

async function listPacks(rootDir: string): Promise<StoredPack[]> {
  const entries = await readIndex(rootDir);
  const packs = await Promise.all(entries.map(async (entry) => {
    try {
      const pack = validPack(JSON.parse(await readFile(manifestPath(rootDir, entry), 'utf8')));
      return pack ? { ...pack, enabled: entry.enabled } : null;
    } catch {
      return null;
    }
  }));
  return packs.filter((pack): pack is StoredPack => pack !== null);
}

async function savePack(rootDir: string, pack: StoredPack): Promise<void> {
  const dir = join(rootDir, pack.id, versionFolder(pack.version));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicWrite(join(dir, 'manifest.json'), pack);
  const entries = await readIndex(rootDir);
  const entry: IndexEntry = {
    id: pack.id,
    version: pack.version,
    enabled: pack.enabled,
    installedAt: pack.installedAt,
  };
  const next = entries.some((item) => item.id === pack.id)
    ? entries.map((item) => (item.id === pack.id ? entry : item))
    : [...entries, entry];
  await writeIndex(rootDir, next);
}

async function setEnabled(rootDir: string, id: string, enabled: boolean): Promise<boolean> {
  const entries = await readIndex(rootDir);
  if (!entries.some((entry) => entry.id === id)) return false;
  await writeIndex(rootDir, entries.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)));
  return true;
}

async function removePack(rootDir: string, id: string): Promise<boolean> {
  const entries = await readIndex(rootDir);
  if (!entries.some((entry) => entry.id === id)) return false;
  await rm(join(rootDir, id), { recursive: true, force: true });
  await writeIndex(rootDir, entries.filter((entry) => entry.id !== id));
  return true;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('extension pack is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

let writes = Promise.resolve();
function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writes.then(task, task);
  writes = next.then(() => undefined, () => undefined);
  return next;
}

async function handleRequest(rootDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawId = url.pathname.split('/').filter(Boolean)[0] ?? '';
  const id = decodeURIComponent(rawId);
  if (id && !ID_RE.test(id)) { sendJson(res, 400, { error: 'invalid extension id' }); return; }

  if (req.method === 'GET' && !id) {
    sendJson(res, 200, { packs: await listPacks(rootDir) });
    return;
  }
  if (req.method === 'PUT' && id) {
    const pack = validPack(await readBody(req));
    if (!pack || pack.id !== id) { sendJson(res, 400, { error: 'invalid extension pack' }); return; }
    await serializeWrite(() => savePack(rootDir, pack));
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'PATCH' && id) {
    const body = await readBody(req);
    if (!isRecord(body) || typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'enabled must be boolean' });
      return;
    }
    const found = await serializeWrite(() => setEnabled(rootDir, id, body.enabled as boolean));
    sendJson(res, found ? 200 : 404, found ? { ok: true } : { error: 'extension not found' });
    return;
  }
  if (req.method === 'DELETE' && id) {
    const found = await serializeWrite(() => removePack(rootDir, id));
    sendJson(res, found ? 200 : 404, found ? { ok: true } : { error: 'extension not found' });
    return;
  }
  sendJson(res, 405, { error: 'method not allowed' });
}

export function extensionStorePlugin(options: { rootDir?: string } = {}): Plugin {
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  return {
    name: 'openchatcut-extension-store',
    configureServer(server) {
      server.middlewares.use('/api/plugins', async (req, res) => {
        try {
          await handleRequest(rootDir, req, res);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[extension-store] ${message}`);
          if (!res.headersSent) sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
