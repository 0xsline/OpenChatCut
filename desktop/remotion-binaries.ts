import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ffmpegBin } from '../server/media-binaries.ts';

const require = createRequire(import.meta.url);
const DIRECTORY_PREFIX = 'remotion-binaries-';
const HARDWARE_SUFFIX = '-hardware';
const READY_MARKER = '.openchatcut-ready';

interface RemotionBinariesOptions {
  userDataPath: string;
  version: string;
  platform?: NodeJS.Platform;
  compositorDirectory?: string;
  ffmpegPath?: string;
}

/** Where the renderer finds its compositor (CC_REMOTION_BINARIES_DIR, CC_REMOTION_HARDWARE_BINARIES_DIR). */
export interface RemotionBinariesDirectories {
  /** The compositor and ffmpeg as Remotion ships them: every ordinary render, still and composition selection. */
  readonly stock: string;
  /** The direct hardware H.264 attempt: on Windows the static ffmpeg swapped in, elsewhere the stock mirror itself. */
  readonly hardware: string;
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

async function mirrorDirectory(source: string, destination: string, skip: ReadonlySet<string> = new Set()): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await mirrorDirectory(from, to);
    else if (entry.isFile()) await linkOrCopy(from, to);
  }
}

function safeVersion(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** A complete mirror of this layout. The marker names the layout, so a directory built by an older layout is rebuilt. */
async function ready(directory: string, platform: NodeJS.Platform, layout: string): Promise<boolean> {
  for (const name of ['remotion', 'ffmpeg', 'ffprobe']) {
    if (!existsSync(join(directory, binaryName(name, platform)))) return false;
  }
  return await readFile(join(directory, READY_MARKER), 'utf8').then((value) => value === layout).catch(() => false);
}

async function ensureMirror(
  destination: string,
  platform: NodeJS.Platform,
  layout: string,
  populate: (directory: string) => Promise<void>,
): Promise<string> {
  if (await ready(destination, platform, layout)) return destination;
  const temporary = `${destination}-${process.pid}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await populate(temporary);
  await writeFile(join(temporary, READY_MARKER), layout);
  if (!await ready(temporary, platform, layout)) throw new Error('Remotion binaries are incomplete');
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
  return destination;
}

async function cleanupOldDirectories(userDataPath: string, keep: ReadonlySet<string>): Promise<void> {
  for (const entry of await readdir(userDataPath, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(DIRECTORY_PREFIX) && !keep.has(entry.name)) {
      await rm(join(userDataPath, entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * Mirror the Remotion compositor into writable, real directories under userData.
 *
 * Every platform needs a copy once the app ships as an asar archive: @remotion/renderer chmods
 * and spawns the compositor at the path it resolved, and neither works on a path inside
 * app.asar, not even an unpacked one, since the resolved path still names the archive. With
 * CC_REMOTION_BINARIES_DIR pointing at the stock mirror, the renderer never touches the
 * package directory at all.
 *
 * Windows adds a hardware mirror whose ffmpeg is the richer static build (hardware encoders)
 * for the direct hardware H.264 attempt alone. The static build has no libfdk_aac, which
 * Remotion's own AAC encode requires, so a software render from that mirror fails with
 * "Unknown encoder 'libfdk_aac'" (issue #223).
 */
export async function ensureRemotionBinaries(options: RemotionBinariesOptions): Promise<RemotionBinariesDirectories> {
  const platform = options.platform ?? process.platform;
  const name = `${DIRECTORY_PREFIX}${safeVersion(options.version)}`;
  const stock = await ensureMirror(join(options.userDataPath, name), platform, 'stock', (directory) => (
    mirrorDirectory(options.compositorDirectory ?? compositorDirectory(platform), directory)
  ));
  const hardware = platform === 'win32'
    ? await ensureMirror(join(options.userDataPath, `${name}${HARDWARE_SUFFIX}`), platform, 'hardware', async (directory) => {
      // Linked from the stock mirror: both live under userData, so the links never fall back to copies.
      await mirrorDirectory(stock, directory, new Set(['ffmpeg.exe', READY_MARKER]));
      await linkOrCopy(options.ffmpegPath ?? ffmpegBin(), join(directory, 'ffmpeg.exe'));
    })
    : stock;
  await cleanupOldDirectories(options.userDataPath, new Set([basename(stock), basename(hardware)]));
  return { stock, hardware };
}
