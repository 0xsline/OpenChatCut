// 跨平台出包的"备料"步:把目标平台的两样平台专属二进制放到位——
//   ① chrome-headless-shell(渲染/导出用)→ staging 目录 desktop-dist/chrome-headless-shell
//      (electron-builder.config.mjs 的 extraResources 恒指这里,换目标就换里面内容);
//   ② @remotion/compositor-<目标>(npm 只装本机平台的,交叉出包要手动补进 node_modules)。
// 用法:npx tsx desktop/prepare-target.mts darwin-arm64|darwin-x64|win32-x64
// 下载源:chrome-for-testing 公共 CDN(与 @remotion/renderer 自身下载同源同版本);
// compositor 走 npm pack(吃 .npmrc 镜像配置)。均带本地缓存,重复运行秒完。
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
const FALLBACK_CHROME_VERSION = '149.0.7790.0'; // renderer TESTED_VERSION(缓存 VERSION 文件缺失时兜底)

interface Target {
  /** chrome-for-testing 平台名(下载 URL 与目录名) */
  cft: string;
  /** @remotion/compositor 平台包名 */
  compositor: string;
  /** chrome 可执行文件名 */
  bin: string;
}

// compositor 包名以 @remotion/renderer 的 optionalDependencies 为准(win32 带 -msvc 后缀)
const TARGETS: Record<string, Target> = {
  'darwin-arm64': { cft: 'mac-arm64', compositor: '@remotion/compositor-darwin-arm64', bin: 'chrome-headless-shell' },
  'darwin-x64': { cft: 'mac-x64', compositor: '@remotion/compositor-darwin-x64', bin: 'chrome-headless-shell' },
  'win32-x64': { cft: 'win64', compositor: '@remotion/compositor-win32-x64-msvc', bin: 'chrome-headless-shell.exe' },
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

/** 确保缓存里有 <cft> 平台的 chrome-headless-shell(缺则从 CfT CDN 拉 zip 解开)。 */
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

/** 确保 node_modules 里有目标平台的 compositor 包(npm pack + 解 tgz,绕过 os/cpu 门)。 */
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
