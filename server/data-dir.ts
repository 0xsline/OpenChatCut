// User-chosen storage root ("games-style save folder"): projects, versions and
// media live where the user asks, so removing or reinstalling the app never
// touches their work.
//
// The chosen path CANNOT live in the settings keystore: in an isolated dev
// profile the keystore file itself sits inside the storage root, so reading it
// would require already knowing the root. It is therefore recorded in a small
// pointer file at a fixed location that never moves.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Fixed pointer location — deliberately outside the movable storage root. */
export function dataDirPointerPath(home: string = homedir()): string {
  return join(home, '.openchatcut', 'data-dir.json');
}

/** Expand ~/ and require an absolute path; anything else is rejected. */
export function expandDataDir(raw: string, home: string = homedir()): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const expanded = trimmed === '~' ? home : trimmed.replace(/^~(?=\/)/, home);
  if (!isAbsolute(expanded)) return null;
  return resolve(expanded);
}

/** Recorded storage root, or null when the app uses its default location.
 *  Synchronous: the runtime profile resolves at module load. A malformed
 *  pointer degrades to the default rather than blocking startup. */
export function readDataDirPointer(home: string = homedir()): string | null {
  const pointer = dataDirPointerPath(home);
  if (!existsSync(pointer)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pointer, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const value = (parsed as { dataDir?: unknown }).dataDir;
    return typeof value === 'string' ? expandDataDir(value, home) : null;
  } catch {
    return null;
  }
}

/** Record the storage root, or clear it (empty value) to return to the default. */
export async function writeDataDirPointer(dir: string | null, home: string = homedir()): Promise<void> {
  const pointer = dataDirPointerPath(home);
  await mkdir(join(home, '.openchatcut'), { recursive: true });
  if (!dir) {
    await unlink(pointer).catch(() => undefined);
    return;
  }
  await writeFile(pointer, `${JSON.stringify({ version: 1, dataDir: dir }, null, 2)}\n`, { mode: 0o600 });
}

export interface DataDirProbe { ok: boolean; note?: string; error?: string; }

/** Writability probe for the settings "test" action and for save-time validation. */
export async function checkDataDir(raw: string, currentDir: string): Promise<DataDirProbe> {
  if (!raw.trim()) return { ok: true, note: `未设置 · 使用默认目录 ${currentDir}` };
  const dir = expandDataDir(raw);
  if (!dir) return { ok: false, error: '必须是绝对路径（可用 ~/ 开头）' };
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.cc-data-probe-${process.pid}`);
    await writeFile(probe, 'ok');
    await unlink(probe);
    return { ok: true, note: `目录可写 · ${dir}` };
  } catch (err) {
    return { ok: false, error: `目录不可写 · ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Root-level entries that travel with a relocation. Media is NOT here: in the
 *  default profile uploads live outside the root (checkout `public/media/uploads`
 *  or packaged `userData/...`), so it is copied separately from the resolved
 *  upload directory. Anything else in the root is regenerated and left behind. */
const RELOCATED_ENTRIES = [
  'project-store-v1',
  'project-store-v1.json',
  'project-store-auth-v1',
  'deleted-projects-v1.json',
  'generation-operations-v1.json',
] as const;

/** Why a relocation was refused, so the caller can explain it to the user. */
export type RelocationRefusal = 'sqlite-store-active';

export interface RelocationOutcome {
  refused?: RelocationRefusal;
  copiedEntries: number;
}

/** Copy the current storage root into a newly chosen one. The source is left
 *  untouched: a relocation must never be the step that loses the projects.
 *
 *  Refuses outright while the SQLite store is the authority. That database is
 *  the whole project store (documents, FTS, semantic vectors) plus its import
 *  receipt, and copying a live WAL-mode database with a plain file copy can
 *  produce a torn snapshot. Moving it safely needs a quiesced backup taken
 *  under the store lock, which belongs in a follow-up rather than behind a
 *  settings field that looks harmless. */
export async function relocateDataDir(
  source: string,
  target: string,
  log: (msg: string) => void,
  sqliteActive: boolean,
): Promise<RelocationOutcome> {
  if (source === target) return { copiedEntries: 0 };
  if (sqliteActive) {
    log('[data-dir] relocation refused: the SQLite project store is active');
    return { refused: 'sqlite-store-active', copiedEntries: 0 };
  }
  let copiedEntries = 0;
  for (const entry of RELOCATED_ENTRIES) {
    const from = join(source, entry);
    if (!existsSync(from)) continue;
    const to = join(target, entry);
    if (existsSync(to)) {
      const existing = await readdir(to).catch(() => ['?']);
      if (existing.length > 0) {
        log(`[data-dir] skipped ${entry}: already present in the new directory`);
        continue;
      }
    }
    // Copy aside, then rename into place. A relocation interrupted midway (disk
    // full, power loss, quit) must never leave a half-copied store looking
    // complete: the entry either exists whole or not at all, so the next attempt
    // sees an absent destination and retries from scratch instead of adopting a
    // partial one. Leftover staging directories are cleaned up on the retry.
    const staging = `${to}.incoming`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(dirname(to), { recursive: true });
    try {
      await cp(from, staging, { recursive: true, force: false, errorOnExist: false });
      await rm(to, { recursive: true, force: true });
      await rename(staging, to);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    copiedEntries += 1;
  }
  if (copiedEntries > 0) log(`[data-dir] copied ${copiedEntries} entries: ${source} → ${target}`);
  return { copiedEntries };
}

/** Upload directory the relocated root will resolve to, so the caller can copy
 *  the existing media into it. Mirrors uploadDir()'s layout for a chosen root. */
export function relocatedUploadDir(target: string): string {
  return join(target, 'media', 'uploads');
}

/**
 * Media destination for a data-dir relocation. Setting the field moves media
 * next to the new root; clearing it returns to the default root, whose media
 * dir is checkout-relative and lives OUTSIDE rootDir (mirrors the no-dataDir
 * branch of resolveRuntimeProfile).
 */
export function relocatedMediaDestination(
  target: string | null,
  destination: string,
  defaultUploadDir: string,
): string {
  return target ? relocatedUploadDir(destination) : defaultUploadDir;
}

/** Create the storage root up-front so a first run never races the first write. */
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
