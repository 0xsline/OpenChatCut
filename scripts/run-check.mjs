// 跑那些 import 链里带 Vite 专属 `?raw` / .frag 的 .check.ts(裸 tsx 解析不了)。
// esbuild 打成单文件 ESM(?raw → 文件文本),node 直接跑。
// 用法:node scripts/run-check.mjs <check 文件路径>
import { build } from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) {
  console.error('usage: node scripts/run-check.mjs <check.ts>');
  process.exit(2);
}

const rawPlugin = {
  name: 'vite-raw',
  setup(b) {
    // `import x from './y.frag?raw'` → y.frag 的文件内容字符串(对齐 Vite 语义)
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
      namespace: 'raw-text',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
      resolveDir: dirname(args.path),
    }));
  },
};

// The bundle must live INSIDE the project: with `packages: 'external'` node
// resolves bare imports relative to the output file, and a system temp dir has
// no node_modules to resolve them from.
const dir = await mkdtemp(join(process.cwd(), '.cc-check-'));
const outfile = join(dir, 'check.mjs');
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    plugins: [rawPlugin],
    loader: { '.frag': 'text', '.vert': 'text' },
    logLevel: 'silent',
    // Bundle only OUR source; let node resolve dependencies itself. Bundling
    // node_modules into a single ESM file breaks any package that does a CJS
    // dynamic require at import time (@vercel/oidc via ai → @ai-sdk/gateway
    // throws 'Dynamic require of "path" is not supported'), which made every
    // verify whose import graph reaches the AI SDK fail for a reason that had
    // nothing to do with the code under test. Only the Vite-specific
    // ?raw/.frag imports need bundling, and those are local files.
    packages: 'external',
  });
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
