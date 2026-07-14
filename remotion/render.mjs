// Shared server-side render pipeline: bundle → selectComposition → renderMedia.
// Used by both scripts/export.mjs (CLI) and vite-plugin-export.ts (dev /export).
// This is the faithful analog of ChatCut's Lambda render: templates are compiled
// at render time in headless Chrome exactly as the Player does, so audio muxes
// natively and no template porting is needed.
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, renderStill } from '@remotion/renderer';
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
  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    publicDir: PUBLIC_DIR,
    // GLSL shaders are imported as strings via Vite's `?raw`; teach the export
    // bundle's webpack the same trick (asset/source = raw text module).
    webpackOverride: (config) => ({
      ...config,
      module: {
        ...config.module,
        rules: [...(config.module?.rules ?? []), { test: /\.frag$/, type: 'asset/source' }],
      },
    }),
  });
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
 * Render a timeline state to video or audio at outputLocation.
 * @param {object} args
 * @param {import('../src/editor/types').TimelineState} args.state
 * @param {string} args.outputLocation  absolute output path
 * @param {'h264'|'vp8'|'mp3'|'wav'} [args.codec]
 * @param {[number, number]} [args.frameRange] inclusive Remotion frame range
 * @param {(progress: number) => void} [args.onProgress]  0..1
 * @returns {Promise<string>} the outputLocation
 */
export async function renderTimeline({ state, outputLocation, onProgress, codec = 'h264', frameRange }) {
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
    codec,
    frameRange,
    inputProps,
    outputLocation,
    // GLSL transitions need WebGL2 in headless Chrome; 'angle' uses the native
    // GPU backend (Metal on macOS). Swap to 'swangle' (SwiftShader) on servers.
    chromiumOptions: { gl: 'angle' },
    onProgress: onProgress ? ({ progress }) => onProgress(progress) : undefined,
  });

  return outputLocation;
}

/**
 * Render a single-clip sub-timeline to a video, optionally with alpha over a
 * transparent background (source 导出 MG 动画 = ProRes 4444 alpha; 转为视频 =
 * bake to an alpha webm). `state` should be a one-item timeline (item at frame 0).
 * @param {object} args
 * @param {import('../src/editor/types').TimelineState} args.state
 * @param {string} args.outputLocation
 * @param {'prores'|'vp8'|'h264'} [args.codec]
 * @param {boolean} [args.transparent]  render over transparency + carry alpha
 */
export async function renderClip({ state, outputLocation, codec = 'vp8', transparent = true }) {
  if (!state || !Array.isArray(state.items) || !state.items.length) {
    throw new Error('renderClip: a single-item TimelineState is required');
  }
  if (!outputLocation) throw new Error('renderClip: outputLocation is required');
  const serveUrl = await getServeUrl();
  const inputProps = { state, transparent };
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });
  await renderMedia({
    serveUrl,
    composition,
    codec,
    inputProps,
    outputLocation,
    // alpha: png intermediate carries the alpha channel; ProRes 4444 needs the
    // explicit yuva444 pixel format (without it, it falls back to opaque 422).
    // (vp8/vp9 alpha webm doesn't work in this ffmpeg build, so 转为视频 uses
    // opaque h264 — see clipExport.ts.)
    ...(transparent && codec === 'prores'
      ? { proResProfile: '4444', imageFormat: 'png', pixelFormat: 'yuva444p10le' }
      : {}),
    chromiumOptions: { gl: 'angle' },
  });
  return outputLocation;
}

/**
 * Render still frames of a timeline as small JPEGs (source view_timeline_frames
 * — the agent "sees" its own draft edits). Returns [{frame, base64}].
 * @param {object} args
 * @param {import('../src/editor/types').TimelineState} args.state
 * @param {number[]} args.frames  frame numbers to render
 */
export async function renderTimelineStills({ state, frames }) {
  if (!state || !Array.isArray(state.items)) throw new Error('renderTimelineStills: state.items required');
  if (!Array.isArray(frames) || !frames.length) throw new Error('renderTimelineStills: frames[] required');
  const serveUrl = await getServeUrl();
  const inputProps = { state };
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });
  const out = [];
  for (const frame of frames.slice(0, 8)) { // cap: keep tool_result payload sane
    const f = Math.max(0, Math.min(composition.durationInFrames - 1, Math.round(frame)));
    const { buffer } = await renderStill({
      serveUrl, composition, inputProps, frame: f,
      imageFormat: 'jpeg', jpegQuality: 70,
      scale: 640 / composition.width, // ~640px wide → small base64 for the LLM
      chromiumOptions: { gl: 'angle' },
      output: null,
    });
    out.push({ frame: f, base64: buffer.toString('base64') });
  }
  return out;
}
