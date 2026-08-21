import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const REFERENCE_VERSION = 1;
const MAX_MANIFEST_BYTES = 8 * 1024;
export const MEDIA_REFERENCE_DIRECTORY = '.references';

interface MediaReferenceRecord {
  readonly version: 1;
  readonly sourcePath: string;
  readonly createdAt: string;
}

export interface ListedMediaReference {
  readonly name: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export function mediaReferenceManifestPath(directory: string, name: string): string {
  return join(directory, MEDIA_REFERENCE_DIRECTORY, `${name}.json`);
}

function readMediaReference(directory: string, name: string): MediaReferenceRecord | null {
  const manifest = mediaReferenceManifestPath(directory, name);
  try {
    const info = statSync(manifest);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null;
    const value = JSON.parse(readFileSync(manifest, 'utf8')) as Partial<MediaReferenceRecord>;
    if (value.version !== REFERENCE_VERSION || typeof value.sourcePath !== 'string') return null;
    if (!isAbsolute(value.sourcePath)) return null;
    return {
      version: REFERENCE_VERSION,
      sourcePath: value.sourcePath,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    };
  } catch {
    return null;
  }
}

export async function registerMediaReference(
  directory: string,
  name: string,
  sourcePath: string,
): Promise<void> {
  const canonicalSource = await realpath(sourcePath);
  if (!(await stat(canonicalSource)).isFile()) throw new Error('local media source must be a file');
  const references = join(directory, MEDIA_REFERENCE_DIRECTORY);
  const manifest = mediaReferenceManifestPath(directory, name);
  const temporary = join(references, `.${name}.${randomUUID()}.tmp`);
  const record: MediaReferenceRecord = {
    version: REFERENCE_VERSION,
    sourcePath: canonicalSource,
    createdAt: new Date().toISOString(),
  };
  await mkdir(references, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    await rename(temporary, manifest);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function resolveMediaReference(directory: string, name: string): string | null {
  const sourcePath = readMediaReference(directory, name)?.sourcePath;
  if (!sourcePath || !existsSync(sourcePath)) return null;
  try {
    const canonical = realpathSync(sourcePath);
    return statSync(canonical).isFile() ? canonical : null;
  } catch {
    return null;
  }
}

export function hasMediaReference(directory: string, name: string): boolean {
  return readMediaReference(directory, name) !== null;
}

export async function deleteMediaReference(directory: string, name: string): Promise<boolean> {
  try {
    await unlink(mediaReferenceManifestPath(directory, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function listMediaReferences(directory: string): Promise<ListedMediaReference[]> {
  const references = join(directory, MEDIA_REFERENCE_DIRECTORY);
  const entries = await readdir(references).catch(() => [] as string[]);
  const listed: ListedMediaReference[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.slice(0, -'.json'.length);
    const record = readMediaReference(directory, name);
    if (!record) continue;
    const [sourceInfo, manifestInfo] = await Promise.all([
      stat(record.sourcePath).catch(() => null),
      stat(mediaReferenceManifestPath(directory, name)).catch(() => null),
    ]);
    listed.push({
      name,
      bytes: sourceInfo?.isFile() ? sourceInfo.size : 0,
      mtimeMs: manifestInfo?.mtimeMs ?? 0,
    });
  }
  return listed;
}
