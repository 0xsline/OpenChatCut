// Prebuild the Remotion serve bundle into desktop-dist/remotion-bundle during packaging.
// Packaged builds do not include the src/ tree or webpack, so this is the only available render serveUrl.
// On first launch, main.ts copies it into userData and passes the path to render.mjs via CC_REMOTION_BUNDLE.
import { join } from 'node:path';
// @ts-expect-error — plain .mjs render pipeline has no .d.ts
import { prebuildServeBundle } from '../remotion/render.mjs';

const out = join(process.cwd(), 'desktop-dist', 'remotion-bundle');
const dir = await prebuildServeBundle(out);
console.log(`[prebuild-remotion] serve bundle → ${dir}`);
