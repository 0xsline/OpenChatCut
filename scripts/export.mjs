// CLI export: renders a representative timeline to ./out.mp4.
//   node scripts/export.mjs
// Uses one real template from chatcut-templates.json + one audio track so the
// output exercises both the motion-graphic and audio-mux paths.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderTimeline } from '../remotion/render.mjs';

const require = createRequire(import.meta.url);
const templates = require('../src/chatcut-templates.json');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Pick a self-contained template (no external <Img>/<Video> assets) so the CLI
// smoke test doesn't depend on scraped image assets that aren't in public/.
// (Templates like "Finance Explainer" carry a dangling bgImage id from the
// source site; those render fine once the real asset exists, but as a headless
// smoke test we exercise a pure-procedural one + an audio track.)
const isSelfContained = (t) => !/\bImg\b/.test(t.code) && !/\bVideo\b/.test(t.code) && !/staticFile/.test(t.code);
const tpl = templates.find((t) => t.name.includes('Bar Chart - Monthly Sales') && isSelfContained(t))
  ?? templates.find(isSelfContained)
  ?? templates[0];

const state = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [
    {
      id: 'export_mg',
      track: 'V1',
      startFrame: 0,
      durationInFrames: tpl.durationInFrames,
      kind: 'motion-graphic',
      templateId: tpl.id,
      name: tpl.name,
      code: tpl.code,
      props: { ...tpl.props },
      width: tpl.width,
      height: tpl.height,
    },
    {
      id: 'export_audio',
      track: 'A1',
      startFrame: 0,
      durationInFrames: 20 * 30,
      kind: 'audio',
      name: 'Ambient Groove',
      src: '/audio/track-1.mp3',
      volume: 1,
    },
  ],
  selectedId: 'export_mg',
};

const outputLocation = path.join(REPO_ROOT, 'out.mp4');

let lastPct = -1;
try {
  console.log(`[export] rendering "${tpl.name}" (${tpl.durationInFrames} frames) → out.mp4`);
  console.log('[export] first run downloads Chrome Headless Shell (~170MB) — this is expected.');
  await renderTimeline({
    state,
    outputLocation,
    onProgress: (p) => {
      const pct = Math.floor(p * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(`\r[export] ${pct}%   `);
      }
    },
  });
  process.stdout.write('\n');
  console.log(`[export] done → ${outputLocation}`);
} catch (err) {
  process.stdout.write('\n');
  console.error('[export] FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
