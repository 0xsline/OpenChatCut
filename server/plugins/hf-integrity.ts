import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export interface ExpectedFileIntegrity {
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface VerifiedFile {
  readonly handle: FileHandle;
  readonly size: number;
}

const verifiedFingerprints = new Map<string, string>();

function pathIsWithin(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`));
}

async function sha256File(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return hash.digest('hex');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

export async function openVerifiedFile(
  path: string,
  expected: ExpectedFileIntegrity,
): Promise<VerifiedFile | null> {
  let handle: FileHandle | null = null;
  try {
    const linkInfo = await lstat(path);
    if (!linkInfo.isFile()) return null;
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const info = await handle.stat();
    if (!info.isFile() || info.size !== expected.sizeBytes) return null;
    const key = `${path}:${expected.sha256}`;
    const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (verifiedFingerprints.get(key) !== fingerprint) {
      if (await sha256File(handle) !== expected.sha256) return null;
      verifiedFingerprints.set(key, fingerprint);
    }
    const verified = { handle, size: info.size };
    handle = null;
    return verified;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw error;
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function openContainedVerifiedFile(
  cacheRoot: string,
  allowedRoot: string,
  candidate: string,
  expected: ExpectedFileIntegrity,
): Promise<VerifiedFile | null> {
  try {
    const [resolvedCache, resolvedRoot, resolvedFile] = await Promise.all([
      realpath(cacheRoot), realpath(allowedRoot), realpath(candidate),
    ]);
    if (!pathIsWithin(resolvedCache, resolvedRoot) || !pathIsWithin(resolvedRoot, resolvedFile)) return null;
    return openVerifiedFile(candidate, expected);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null;
    throw error;
  }
}

export async function fileMatchesIntegrity(path: string, expected: ExpectedFileIntegrity): Promise<boolean> {
  const file = await openVerifiedFile(path, expected);
  if (!file) return false;
  await file.handle.close();
  return true;
}
