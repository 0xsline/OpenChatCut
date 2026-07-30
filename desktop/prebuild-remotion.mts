// 打包期预打 remotion serve bundle → desktop-dist/remotion-bundle。
// 打包版运行时没有 src/ 源码和 webpack,渲染的 serveUrl 只能来自这里
// (main.ts 首启把它拷进 userData 并经 CC_REMOTION_BUNDLE 指给 render.mjs)。
import { join } from 'node:path';
// @ts-expect-error — plain .mjs render pipeline has no .d.ts
import { prebuildServeBundle } from '../remotion/render.mjs';

const out = join(process.cwd(), 'desktop-dist', 'remotion-bundle');
const dir = await prebuildServeBundle(out);
console.log(`[prebuild-remotion] serve bundle → ${dir}`);
