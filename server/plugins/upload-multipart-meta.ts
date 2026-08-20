import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadDir } from '../media-dir.ts';

export const MAX_PARTS = 10_000;

export interface MultipartMeta {
  uploadId: string; name: string; ext: string; assetId?: string; contentType?: string;
  size: number; partSize: number; partCount: number; createdAt: number; updatedAt: number;
}

export function multipartRoot(): string { return join(uploadDir(), '.multipart'); }
export function sessionDir(uploadId: string): string { return join(multipartRoot(), uploadId); }

function parseMeta(raw: unknown, uploadId: string): MultipartMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<MultipartMeta>;
  const numbers = [value.size, value.partSize, value.partCount, value.createdAt];
  if (value.uploadId !== uploadId || typeof value.name !== 'string' || typeof value.ext !== 'string' || !/^\.[a-z0-9]{1,16}$/.test(value.ext)
    || !numbers.every((item) => typeof item === 'number' && Number.isFinite(item) && item > 0)
    || (value.assetId !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(value.assetId)) || (value.contentType !== undefined && (typeof value.contentType !== 'string' || value.contentType.length > 200)) || !Number.isInteger(Number(value.partCount)) || value.partCount! > MAX_PARTS
    || value.partCount !== Math.ceil(value.size! / value.partSize!)) return null;
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
    ? value.updatedAt : value.createdAt;
  return { ...value, updatedAt } as MultipartMeta;
}

export async function loadMeta(uploadId: string): Promise<MultipartMeta | null> {
  try {
    return parseMeta(JSON.parse(await readFile(join(sessionDir(uploadId), 'meta.json'), 'utf8')), uploadId);
  } catch {
    return null;
  }
}

const metaWriteQueues = new Map<string, Promise<void>>();

export function enqueueMetaWrite(uploadId: string, task: () => Promise<void>): Promise<void> {
  const previous = metaWriteQueues.get(uploadId) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.catch(() => {});
  metaWriteQueues.set(uploadId, tail);
  void tail.then(() => {
    if (metaWriteQueues.get(uploadId) === tail) metaWriteQueues.delete(uploadId);
  });
  return next;
}

export function queuedMetaWriteCount(): number { return metaWriteQueues.size; }

async function writeMeta(meta: MultipartMeta, tmp: string): Promise<void> {
  await writeFile(tmp, JSON.stringify(meta), 'utf8');
  let attempt = 0;
  for (;;) {
    try {
      await rename(tmp, join(sessionDir(meta.uploadId), 'meta.json'));
      return;
    } catch (error) {
      attempt += 1;
      if (attempt >= 4 || !(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

export async function saveMeta(meta: MultipartMeta): Promise<void> {
  const dir = sessionDir(meta.uploadId);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.meta-${randomUUID()}.tmp`);
  return enqueueMetaWrite(meta.uploadId, async () => {
    try {
      await writeMeta(meta, tmp);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  });
}
