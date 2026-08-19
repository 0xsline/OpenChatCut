// Preparation for runtime in packaged state: Resources is a read-only area, and the two things needed for rendering must be pointed to available locations —
// ① remotion serve bundle:uploads symlink to be written into the bundle directory → copy to according to version
// userData (first startup, the old version directory will be cleared easily);
// ② chrome-headless-shell: distributed with the package, find the executable file path to render.mjs.
// Both are passed through environment variables (CC_REMOTION_BUNDLE / CC_BROWSER_EXECUTABLE), dev does not set the old behavior.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureWindowsRemotionBinaries } from './remotion-binaries.ts';

/** Find the chrome-headless-shell executable file in the distribution directory (the level varies with the platform, small-scale recursion). */
export function findBundledBrowser(root: string, depth = 4): string | null {
  if (depth < 0 || !existsSync(root)) return null;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isFile() && (name === 'chrome-headless-shell' || name === 'chrome-headless-shell.exe')) return p;
    if (st.isDirectory()) {
      const hit = findBundledBrowser(p, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

export interface PackagedPaths {
  resourcesPath: string;
  userDataPath: string;
  version: string;
}

/** Firstly copy the serve bundle into userData (with version number, clean up old versions), and return the writable bundle path. */
export async function ensureWritableBundle({ resourcesPath, userDataPath, version }: PackagedPaths): Promise<string> {
  const src = join(resourcesPath, 'remotion-bundle');
  const dst = join(userDataPath, `remotion-bundle-${version}`);
  for (const name of readdirSync(userDataPath)) {
    if (name.startsWith('remotion-bundle-') && name !== `remotion-bundle-${version}`) {
      await rm(join(userDataPath, name), { recursive: true, force: true });
    }
  }
  if (!existsSync(join(dst, 'index.html'))) {
    await rm(dst, { recursive: true, force: true });  // Half copy (killed last time) → restart
    await cp(src, dst, { recursive: true });
  }
  return dst;
}

/** Configure packaged render assets before the first rendering request. */
export async function preparePackagedRuntime(paths: PackagedPaths): Promise<void> {
  process.env.CC_REMOTION_BUNDLE = await ensureWritableBundle(paths);
  const browser = findBundledBrowser(join(paths.resourcesPath, 'chrome-headless-shell'));
  if (browser) process.env.CC_BROWSER_EXECUTABLE = browser;
  if (!process.env.CC_REMOTION_BINARIES_DIR) {
    const binaries = await ensureWindowsRemotionBinaries({
      userDataPath: paths.userDataPath,
      version: paths.version,
    });
    if (binaries) process.env.CC_REMOTION_BINARIES_DIR = binaries;
  }
}
