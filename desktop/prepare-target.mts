// Stage the two platform-specific binaries required for a cross-platform package:
//   1. chrome-headless-shell for rendering/export into desktop-dist/chrome-headless-shell.
//      electron-builder.config.mjs always reads extraResources from this staging directory.
//   2. @remotion/compositor-<target>. npm installs only the host package, so cross-builds add it manually.
// Usage: npx tsx desktop/prepare-target.mts darwin-arm64|darwin-x64|win32-x64|linux-x64
// Chrome comes from the Chrome for Testing CDN used by @remotion/renderer at the same version.
// The compositor uses npm pack and respects .npmrc registry settings. Both downloads are cached.
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STAGING = join(ROOT, 'desktop-dist', 'chrome-headless-shell');
const CACHE = join(ROOT, 'node_modules', '.remotion', 'chrome-headless-shell');
const FALLBACK_CHROME_VERSION = '149.0.7790.0'; // renderer TESTED_VERSION fallback when the cached VERSION file is missing

interface Target {
  /** Chrome for Testing platform name used in download URLs and directory names. */
  cft: string;
  /** Platform package name for @remotion/compositor. */
  compositor: string;
  /** Chrome executable name. */
  bin: string;
}

// Compositor names follow @remotion/renderer optionalDependencies; win32 packages use the -msvc suffix.
const TARGETS: Record<string, Target> = {
  'darwin-arm64': { cft: 'mac-arm64', compositor: '@remotion/compositor-darwin-arm64', bin: 'chrome-headless-shell' },
  'darwin-x64': { cft: 'mac-x64', compositor: '@remotion/compositor-darwin-x64', bin: 'chrome-headless-shell' },
  'win32-x64': { cft: 'win64', compositor: '@remotion/compositor-win32-x64-msvc', bin: 'chrome-headless-shell.exe' },
  // Chrome for Testing ships linux64 only, so desktop Linux supports x64 only.
  // AppImage targets glibc distributions, so use the -gnu compositor variant.
  'linux-x64': { cft: 'linux64', compositor: '@remotion/compositor-linux-x64-gnu', bin: 'chrome-headless-shell' },
};

async function chromeVersion(): Promise<string> {
  const v = await readFile(join(CACHE, 'VERSION'), 'utf8').catch(() => '');
  return v.trim() || FALLBACK_CHROME_VERSION;
}

async function download(url: string, dest: string): Promise<void> {
  console.log(`[prepare] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
}

/** Ensure chrome-headless-shell is cached for the target platform, downloading and extracting it if needed. */
async function ensureChrome(t: Target): Promise<string> {
  const dir = join(CACHE, t.cft);
  const marker = join(dir, `chrome-headless-shell-${t.cft}`, t.bin);
  if (existsSync(marker)) return dir;
  const ver = await chromeVersion();
  const zip = join(ROOT, 'desktop-dist', `chs-${t.cft}-${ver}.zip`);
  if (!existsSync(zip)) {
    await download(`https://storage.googleapis.com/chrome-for-testing-public/${ver}/${t.cft}/chrome-headless-shell-${t.cft}.zip`, zip);
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  execFileSync('tar', ['-xf', zip, '-C', dir]);
  if (!existsSync(marker)) throw new Error(`unzip produced no ${marker}`);
  if (t.bin === 'chrome-headless-shell') await chmod(marker, 0o755);
  return dir;
}

/** Install the target compositor package with npm pack and tgz extraction, bypassing host OS/CPU filters. */
async function ensureCompositor(pkg: string): Promise<void> {
  const dest = join(ROOT, 'node_modules', ...pkg.split('/'));
  if (existsSync(join(dest, 'package.json'))) {
    console.log(`[prepare] compositor ok: ${pkg}`);
    return;
  }
  const rendererVer = JSON.parse(await readFile(join(ROOT, 'node_modules/@remotion/renderer/package.json'), 'utf8')).version as string;
  const tmp = join(ROOT, 'desktop-dist', 'pack-tmp');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  console.log(`[prepare] npm pack ${pkg}@${rendererVer}`);
  execFileSync('npm', ['pack', `${pkg}@${rendererVer}`, '--pack-destination', tmp], { stdio: 'inherit' });
  const tgz = (await readdir(tmp)).find((n) => n.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced no tgz for ${pkg}`);
  execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp]);
  await mkdir(join(dest, '..'), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await rename(join(tmp, 'package'), dest);
  await rm(tmp, { recursive: true, force: true });
  console.log(`[prepare] compositor installed: ${pkg}@${rendererVer}`);
}

async function main(): Promise<void> {
  const key = process.argv[2] ?? `${process.platform}-${process.arch}`;
  const t = TARGETS[key];
  if (!t) throw new Error(`unknown target "${key}" — use one of: ${Object.keys(TARGETS).join(' / ')}`);

  const chromeDir = await ensureChrome(t);
  await rm(STAGING, { recursive: true, force: true });
  await mkdir(STAGING, { recursive: true });
  await cp(chromeDir, join(STAGING, t.cft), { recursive: true });
  await ensureCompositor(t.compositor);
  console.log(`[prepare] ${key} ready — chrome staged at desktop-dist/chrome-headless-shell/${t.cft}`);
}

main().catch((err) => {
  console.error('[prepare] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
