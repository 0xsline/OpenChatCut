// Shared server-side render pipeline: bundle → selectComposition → renderMedia.
// Used by both scripts/export.mjs (CLI) and vite-plugin-export.ts (dev /export).
// This is the faithful analog of ChatCut's Lambda render: templates are compiled
// at render time in headless Chrome exactly as the Player does, so audio muxes
// natively and no template porting is needed.
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia } from '@remotion/renderer';
import path from 'node:path';
import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_POINT = path.join(REPO_ROOT, 'remotion', 'index.ts');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const COMPOSITION_ID = 'timeline';

// Bundling is expensive (webpack over the whole app + @babel/standalone), so we
// build the serve bundle once and reuse the serveUrl across every render.
let bundlePromise;

async function buildServeUrl() {
  const serveUrl = await bundle({ entryPoint: ENTRY_POINT, publicDir: PUBLIC_DIR });
  // Remotion copies publicDir to <serveUrl>/public and only exposes it through
  // staticFile(). But the app (like Vite) addresses assets with root-absolute
  // paths — e.g. <Audio src="/audio/track-1.mp3"> in TimelineComposition — so
  // overlay public/ onto the bundle root to serve those paths identically.
  await cp(PUBLIC_DIR, serveUrl, { recursive: true });
  return serveUrl;
}

function getServeUrl() {
  if (!bundlePromise) {
    bundlePromise = buildServeUrl();
  }
  return bundlePromise;
}

/**
 * Render a timeline state to an MP4 (h264) at outputLocation.
 * @param {object} args
 * @param {import('../src/editor/types').TimelineState} args.state
 * @param {string} args.outputLocation  absolute path for the .mp4
 * @param {(progress: number) => void} [args.onProgress]  0..1
 * @returns {Promise<string>} the outputLocation
 */
export async function renderTimeline({ state, outputLocation, onProgress }) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.items)) {
    throw new Error('renderTimeline: a valid TimelineState (with items[]) is required');
  }
  if (!outputLocation) throw new Error('renderTimeline: outputLocation is required');

  const serveUrl = await getServeUrl();
  const inputProps = { state };

  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });

  await renderMedia({
    serveUrl,
    composition,
    codec: 'h264',
    inputProps,
    outputLocation,
    onProgress: onProgress ? ({ progress }) => onProgress(progress) : undefined,
  });

  return outputLocation;
}
