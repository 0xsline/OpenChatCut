import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ffmpegBin } from '../server/media-binaries.ts';

const require = createRequire(import.meta.url);
const DIRECTORY_PREFIX = 'remotion-binaries-';
const READY_MARKER = '.openchatcut-ready';

interface RemotionBinariesOptions {
  userDataPath: string;
  version: string;
  platform?: NodeJS.Platform;
  compositorDirectory?: string;
  ffmpegPath?: string;
}

function windowsCompositorDirectory(): string {
  const pkg = require('@remotion/compositor-win32-x64-msvc') as { dir?: unknown };
  if (typeof pkg.dir !== 'string' || !pkg.dir) throw new Error('Windows Remotion compositor directory is missing');
  return pkg.dir;
}

async function linkOrCopy(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
  } catch {
    await copyFile(source, destination);
  }
}

async function mirrorDirectory(source: string, destination: string, skip: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === skip) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await mirrorDirectory(from, to, '');
    else if (entry.isFile()) await linkOrCopy(from, to);
  }
}

function safeVersion(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function ready(directory: string): Promise<boolean> {
  for (const name of ['remotion.exe', 'ffmpeg.exe', 'ffprobe.exe']) {
    if (!existsSync(join(directory, name))) return false;
  }
  return await readFile(join(directory, READY_MARKER), 'utf8').then((value) => value === 'ok').catch(() => false);
}

async function cleanupOldDirectories(userDataPath: string, keep: string): Promise<void> {
  for (const entry of await readdir(userDataPath, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(DIRECTORY_PREFIX) && entry.name !== keep) {
      await rm(join(userDataPath, entry.name), { recursive: true, force: true });
    }
  }
}

/** Build a complete Remotion directory while replacing only its limited FFmpeg. */
export async function ensureWindowsRemotionBinaries(options: RemotionBinariesOptions): Promise<string | null> {
  if ((options.platform ?? process.platform) !== 'win32') return null;
  const name = `${DIRECTORY_PREFIX}${safeVersion(options.version)}`;
  const destination = join(options.userDataPath, name);
  if (await ready(destination)) return destination;

  const temporary = `${destination}-${process.pid}.tmp`;
  const source = options.compositorDirectory ?? windowsCompositorDirectory();
  const ffmpeg = options.ffmpegPath ?? ffmpegBin();
  await rm(temporary, { recursive: true, force: true });
  await mirrorDirectory(source, temporary, 'ffmpeg.exe');
  await linkOrCopy(ffmpeg, join(temporary, 'ffmpeg.exe'));
  await writeFile(join(temporary, READY_MARKER), 'ok');
  if (!await ready(temporary)) throw new Error('Windows Remotion binaries are incomplete');
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
  await cleanupOldDirectories(options.userDataPath, basename(destination));
  return destination;
}
