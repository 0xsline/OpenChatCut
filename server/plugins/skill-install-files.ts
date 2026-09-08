import { constants, createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export interface SkillInstallFile { path: string; size: number; sha?: string }
export interface SkillByteBudget { total: number }

const SKIP_PREFIXES = ['readme', 'license', 'changelog', '.gitignore', 'agents/', 'workflow'];

export function isSkillPath(path: string): boolean {
  if (path === 'SKILL.md') return true;
  if (path.split('/').some((part) => part.startsWith('.'))) return false;
  const lower = path.toLowerCase();
  return ['references/', 'scripts/', 'assets/', 'examples/'].some((prefix) => lower.startsWith(prefix))
    || SKIP_PREFIXES.every((prefix) => !lower.startsWith(prefix) && !lower.includes(`/${prefix}/`));
}

export function validateSkillPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.includes('\\') || path.includes(':')
    || path.split('/').some((part) => !part || part === '.' || part === '..')
    || [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('invalid skill file path');
  }
}

export function validateSkillFiles(files: SkillInstallFile[]): void {
  let total = 0;
  const paths = new Set<string>();
  for (const file of files) {
    validateSkillPath(file.path);
    if (paths.has(file.path.toLowerCase())) throw new Error(`duplicate skill file: ${file.path}`);
    paths.add(file.path.toLowerCase());
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error(`invalid file size: ${file.path}`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`skill file exceeds 4 MB: ${file.path}`);
    total += file.size;
    if (total > MAX_TOTAL_BYTES) throw new Error('skill files exceed 64 MB');
  }
  if (!paths.has('skill.md') || !files.some((file) => file.path === 'SKILL.md')) {
    throw new Error('repo has no SKILL.md at its root');
  }
}

/** Enumerate before reading; lstat never follows links, including SKILL.md. */
export async function listCloneSkillFiles(root: string, relative = ''): Promise<SkillInstallFile[]> {
  const files: SkillInstallFile[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    validateSkillPath(path);
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error(`symbolic links are not allowed in skills: ${path}`);
    if (info.isDirectory()) files.push(...await listCloneSkillFiles(root, path));
    else if (isSkillPath(path)) {
      if (!info.isFile()) throw new Error(`skill entry must be a regular file: ${path}`);
      files.push({ path, size: info.size });
    }
  }
  return files;
}

/** Apply the limit to streamed bytes too, not only untrusted metadata. */
export async function stageSkillFile(
  source: Readable,
  stage: string,
  file: SkillInstallFile,
  budget: SkillByteBudget,
): Promise<void> {
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      budget.total += chunk.length;
      if (bytes > MAX_FILE_BYTES || budget.total > MAX_TOTAL_BYTES || bytes > file.size) {
        callback(new Error(`skill file exceeds size limit: ${file.path}`));
      } else callback(null, chunk);
    },
  });
  const target = join(stage, file.path);
  try {
    await mkdir(dirname(target), { recursive: true });
    await pipeline(source, limit, createWriteStream(target, { flags: 'wx' }));
    if (bytes !== file.size) throw new Error(`skill file size mismatch: ${file.path}`);
  } finally {
    source.destroy();
  }
}

export async function stageCloneSkillFiles(source: string, stage: string): Promise<SkillInstallFile[]> {
  const files = await listCloneSkillFiles(source);
  validateSkillFiles(files);
  const budget = { total: 0 };
  for (const file of files) {
    const handle = await open(join(source, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== file.size) throw new Error(`skill file changed: ${file.path}`);
      await stageSkillFile(handle.createReadStream(), stage, file, budget);
    } finally {
      await handle.close();
    }
  }
  return files;
}

async function existingDirectory(dir: string): Promise<boolean> {
  const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('skill destination must be a directory');
  return true;
}

async function overlayStagedFiles(stage: string, target: string, files: SkillInstallFile[]): Promise<void> {
  for (const file of files) {
    const parts = file.path.split('/');
    let parent = target;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      if (!await existingDirectory(parent)) await mkdir(parent);
    }
    // Remove a copied leaf first so write/copy cannot follow a pre-existing symlink.
    await rm(join(target, file.path), { force: true });
    await cp(join(stage, file.path), join(target, file.path));
  }
}

async function publishStagedSkillFiles(stage: string, dir: string, files: SkillInstallFile[]): Promise<void> {
  await mkdir(dirname(dir), { recursive: true });
  const scratch = await mkdtemp(join(dirname(dir), '.skill-install-'));
  const next = join(scratch, 'next');
  const previous = join(scratch, 'previous');
  let backedUp = false;
  try {
    if (await existingDirectory(dir)) await cp(dir, next, { recursive: true, dereference: false, verbatimSymlinks: true });
    else await mkdir(next);
    await overlayStagedFiles(stage, next, files);
    if (await existingDirectory(dir)) { await rename(dir, previous); backedUp = true; }
    try { await rename(next, dir); }
    catch (error) {
      if (backedUp) { await rename(previous, dir); backedUp = false; }
      throw error;
    }
    backedUp = false;
  } finally {
    // If rollback itself failed, retain the backup so existing user files stay recoverable.
    if (!backedUp) await rm(scratch, { recursive: true, force: true });
  }
}

const publications = new Map<string, Promise<void>>();

/** Serialize each complete overlay so a stale snapshot cannot erase another install. */
export async function publishSkillFiles(stage: string, dir: string, files: SkillInstallFile[]): Promise<void> {
  const previous = publications.get(dir) ?? Promise.resolve();
  const publication = previous.catch(() => undefined).then(() => publishStagedSkillFiles(stage, dir, files));
  publications.set(dir, publication);
  try {
    await publication;
  } finally {
    if (publications.get(dir) === publication) publications.delete(dir);
  }
}
