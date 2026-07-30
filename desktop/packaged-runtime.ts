// 打包态运行时准备:Resources 是只读区,渲染需要的两样东西要指到能用的位置——
//   ① remotion serve bundle:uploads symlink 要写进 bundle 目录 → 按版本拷到
//      userData(首启一次,旧版本目录顺手清掉);
//   ② chrome-headless-shell:随包分发,找出可执行文件路径给 render.mjs。
// 两者都经环境变量交接(CC_REMOTION_BUNDLE / CC_BROWSER_EXECUTABLE),dev 不设即旧行为。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** 在分发目录里找 chrome-headless-shell 可执行文件(层级随平台不同,小范围递归)。 */
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

/** 首启把 serve bundle 拷进 userData(带版本号,旧版本清理),返回可写 bundle 路径。 */
export async function ensureWritableBundle({ resourcesPath, userDataPath, version }: PackagedPaths): Promise<string> {
  const src = join(resourcesPath, 'remotion-bundle');
  const dst = join(userDataPath, `remotion-bundle-${version}`);
  for (const name of readdirSync(userDataPath)) {
    if (name.startsWith('remotion-bundle-') && name !== `remotion-bundle-${version}`) {
      await rm(join(userDataPath, name), { recursive: true, force: true });
    }
  }
  if (!existsSync(join(dst, 'index.html'))) {
    await rm(dst, { recursive: true, force: true });  // 半截拷贝(上次被杀)→ 重来
    await cp(src, dst, { recursive: true });
  }
  return dst;
}

/** 打包态一站式:设好两个环境变量。必须在第一次渲染请求前调(boot 即调)。 */
export async function preparePackagedRuntime(paths: PackagedPaths): Promise<void> {
  process.env.CC_REMOTION_BUNDLE = await ensureWritableBundle(paths);
  const browser = findBundledBrowser(join(paths.resourcesPath, 'chrome-headless-shell'));
  if (browser) process.env.CC_BROWSER_EXECUTABLE = browser;
}
