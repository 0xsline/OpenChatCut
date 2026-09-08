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

/** The @remotion/compositor package for this platform, named the way @remotion/renderer resolves it. */
export function compositorPackageName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform === 'win32') return '@remotion/compositor-win32-x64-msvc';
  if (platform === 'darwin') return `@remotion/compositor-darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (platform === 'linux') return `@remotion/compositor-linux-${arch === 'arm64' ? 'arm64' : 'x64'}-gnu`;
  throw new Error(`no Remotion compositor for ${platform}/${arch}`);
}

function compositorDirectory(platform: NodeJS.Platform): string {
  const pkg = require(compositorPackageName(platform)) as { dir?: unknown };
  if (typeof pkg.dir !== 'string' || !pkg.dir) throw new Error(`Remotion compositor directory is missing for ${platform}`);
  return pkg.dir;
}

function binaryName(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
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

async function ready(directory: string, platform: NodeJS.Platform): Promise<boolean> {
  for (const name of ['remotion', 'ffmpeg', 'ffprobe']) {
    if (!existsSync(join(directory, binaryName(name, platform)))) return false;
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

/**
 * Mirror the Remotion compositor into a writable, real directory under userData.
 *
 * Two reasons, one per platform family. Windows swaps the compositor's limited ffmpeg for
 * the richer static build (hardware encoders). Every platform needs the copy once the app
 * ships as an asar archive: @remotion/renderer chmods and spawns the compositor at the
 * path it resolved, and neither works on a path inside app.asar — not even an unpacked
 * one, since the resolved path still names the archive. With CC_REMOTION_BINARIES_DIR
 * pointing here, the renderer never touches the package directory at all.
 */
export async function ensureRemotionBinaries(options: RemotionBinariesOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const name = `${DIRECTORY_PREFIX}${safeVersion(options.version)}`;
  const destination = join(options.userDataPath, name);
  if (await ready(destination, platform)) return destination;

  const temporary = `${destination}-${process.pid}.tmp`;
  const source = options.compositorDirectory ?? compositorDirectory(platform);
  await rm(temporary, { recursive: true, force: true });
  if (platform === 'win32') {
    await mirrorDirectory(source, temporary, 'ffmpeg.exe');
    await linkOrCopy(options.ffmpegPath ?? ffmpegBin(), join(temporary, 'ffmpeg.exe'));
  } else {
    await mirrorDirectory(source, temporary, '');
  }
  await writeFile(join(temporary, READY_MARKER), 'ok');
  if (!await ready(temporary, platform)) throw new Error('Remotion binaries are incomplete');
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
  await cleanupOldDirectories(options.userDataPath, basename(destination));
  return destination;
}

