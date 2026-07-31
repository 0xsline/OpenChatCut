// Shared server-side render pipeline: bundle → selectComposition → renderMedia.
// Used by the server export endpoint and Electron packaging.
// Headless Lambda-style render: templates are compiled
// at render time in headless Chrome exactly as the Player does, so audio muxes
// natively and no template porting is needed.
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, RenderInternals, selectComposition, renderMedia, renderStill } from '@remotion/renderer';
import path from 'node:path';
import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  h264FfmpegOverride,
  remotionHardwareAcceleration,
  resolveH264VideoBitrate,
  resolveOffthreadVideoThreads,
  resolveRenderConcurrency,
  withEncoderProfileFallback,
} from './performance.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_POINT = path.join(REPO_ROOT, 'remotion', 'index.ts');
/** Product-bundled static files (fonts, thumbs, SFX, …) — NOT user uploads. */
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
/** User/runtime media root (only media/uploads under public/). */
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'media', 'uploads');
const COMPOSITION_ID = 'timeline';

const H264_PROFILE_LABELS = {
  h264_videotoolbox: 'Apple VideoToolbox',
  h264_nvenc: 'NVIDIA NVENC',
  h264_qsv: 'Intel Quick Sync Video',
  h264_amf: 'AMD AMF',
  h264_vaapi: 'Linux VA-API',
  libx264: 'Software (libx264)',
};

function normalizeH264Profile(codec, profile) {
  if (codec !== 'h264') return undefined;
  const id = profile?.id;
  if (typeof id !== 'string' || !Object.hasOwn(H264_PROFILE_LABELS, id)) {
    return { id: 'libx264', label: H264_PROFILE_LABELS.libx264, hardware: false, transport: 'server' };
  }
  return {
    id,
    label: H264_PROFILE_LABELS[id],
    hardware: id !== 'libx264',
    transport: 'server',
  };
}

// Bundling is expensive (webpack over the whole app + @babel/standalone), so we
// build the serve bundle once and reuse the serveUrl across every render.
let bundlePromise;

// Desktop packaging version: There is no src/ source code and webpack at runtime, and the serve bundle is pre-packaged during the packaging period.
// Point in via CC_REMOTION_BUNDLE at startup (writable directory - uploads symlink needs to be written in);
// Headless browser equivalent CC_BROWSER_EXECUTABLE points to the chrome-headless-shell distributed with the package
// (Default undefined = Remotion self-seeking/self-downloading, dev behavior remains unchanged).
const browserExecutable = () => process.env.CC_BROWSER_EXECUTABLE || undefined;

export function currentRenderConcurrency() {
  return resolveRenderConcurrency();
}

export function remotionFfmpegPath() {
  return RenderInternals.getExecutablePath({
    type: 'ffmpeg',
    indent: false,
    logLevel: 'error',
    binariesDirectory: null,
  });
}

const offthreadVideoThreads = () => resolveOffthreadVideoThreads();
function remotionCancelSignal(signal) {
  if (!signal) return undefined;
  const cancellation = makeCancelSignal();
  if (signal.aborted) cancellation.cancel();
  else signal.addEventListener('abort', cancellation.cancel, { once: true });
  return cancellation.cancelSignal;
}


/** Render with the selected probed engine, then make a truthful software retry. */
async function renderMediaOptimized(options) {
  const { h264Profile, vaapiDevice, ...renderOptions } = options;
  const profile = normalizeH264Profile(renderOptions.codec, h264Profile);
  const hardwareAcceleration = remotionHardwareAcceleration(renderOptions.codec, {
    encoder: profile?.id,
  });
  const customOverride = profile?.hardware && hardwareAcceleration === 'disable'
    ? h264FfmpegOverride(profile.id, { vaapiDevice })
    : undefined;
  const automaticBitrate = profile?.hardware && !renderOptions.videoBitrate
    ? resolveH264VideoBitrate({
      width: renderOptions.composition.width,
      height: renderOptions.composition.height,
      fps: renderOptions.composition.fps,
      scale: renderOptions.scale ?? 1,
    })
    : null;
  const hardwareOptions = {
    ...renderOptions,
    concurrency: currentRenderConcurrency(),
    offthreadVideoThreads: offthreadVideoThreads(),
    hardwareAcceleration,
    ...(customOverride ? { ffmpegOverride: customOverride } : {}),
    ...(automaticBitrate ? { videoBitrate: automaticBitrate } : {}),
  };
  if (!profile) return { result: await renderMedia(hardwareOptions), encoder: undefined };
  return withEncoderProfileFallback({
    render: renderMedia,
    hardwareOptions,
    softwareOptions: {
      ...hardwareOptions,
      hardwareAcceleration: 'disable',
      ffmpegOverride: undefined,
      ...(automaticBitrate ? { videoBitrate: null } : {}),
    },
    hardwareProfile: profile,
    cleanup: async () => {
      if (renderOptions.outputLocation) {
        await rm(renderOptions.outputLocation, { force: true }).catch(() => {});
      }
    },
    onFallback: () => {
      console.warn(`[render] ${profile.label} failed; retrying ${renderOptions.codec} with software encoding`);
    },
  });
}

// The asset directory defaults to public/media/uploads; the dev server side can be customized by MEDIA_DIR——
// server/plugins/export injects provider (read keystore). The standalone script remains the default.
let uploadsDirProvider = () => UPLOAD_DIR;
let linkedDir = null; // <serveUrl>/media/uploads symlink currently points to; reconnect when the directory changes

/** @param {() => string} fn returns the absolute path of the current asset directory*/
export function setUploadsDirProvider(fn) { uploadsDirProvider = fn; }

async function buildServeUrl() {
  const serveUrl = await buildBundle(undefined);
  // Live-link runtime uploads: push_asset / upload / paste / image-gen write files
  // AFTER this one-time snapshot, and a stale snapshot makes the headless renderer
  // 404 them (stills come out blank; <video> decodes the 404 page as
  // MEDIA_ELEMENT_ERROR). Replace the snapshot dir with a symlink to the real
  // uploads dir so every render sees the live files — no per-render copying.
  await relinkUploads(serveUrl);
  return serveUrl;
}

/** webpack hits the serve bundle + public override (not relink - that's a runtime responsibility).*/
async function buildBundle(outDir) {
  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    // Product static at assets/ (same URL paths as before when under public/).
    publicDir: ASSETS_DIR,
    ...(outDir ? { outDir } : {}),
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
  // Remotion copies publicDir under serveUrl/public; app uses root-absolute
  // paths (/fonts, /audio, …) like Vite — overlay product assets at serve root.
  await cp(ASSETS_DIR, serveUrl, { recursive: true });
  // User uploads live separately under public/media/uploads (or MEDIA_DIR);
  // relinkUploads() points serveUrl/media/uploads at the live upload dir.
  return serveUrl;
}

/** During the packaging period, pre-load serve bundle to outDir (desktop/prebuild-remotion.mts).*/
export async function prebuildServeBundle(outDir) {
  await rm(outDir, { recursive: true, force: true });
  return buildBundle(outDir);
}

// Point <serveUrl>/media/uploads to the current asset directory (default or MEDIA_DIR custom).
async function relinkUploads(serveUrl) {
  const dir = uploadsDirProvider();
  await mkdir(dir, { recursive: true });
  const linkPath = path.join(serveUrl, 'media', 'uploads');
  try {
    await rm(linkPath, { recursive: true, force: true });
    // Win32 uses junction: the directory soft link requires administrator/developer mode, junction is privilege-free (requires absolute path, dir is always absolute)
    await symlink(dir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    uploadsLive = true;
    linkedDir = dir;
  } catch {
    uploadsLive = false; // symlink unavailable → getServeUrl falls back to per-call copy
  }
}

// True when <serveUrl>/media/uploads is a symlink to the live uploads dir.
let uploadsLive = false;

// Return the cached serve bundle. Normal path: uploads are symlinked (live), nothing to
// sync. Fallback (no symlink support): re-copy the uploads dir on each call so runtime
// uploads still render, at the old per-render copy cost.
async function getServeUrl() {
  if (!bundlePromise) {
    const prebuilt = process.env.CC_REMOTION_BUNDLE;
    bundlePromise = prebuilt
      ? relinkUploads(prebuilt).then(() => prebuilt)  // Pre-bundle: skip webpack and only take over uploads
      : buildServeUrl();
  }
  const serveUrl = await bundlePromise;
  const dir = uploadsDirProvider();
  if (uploadsLive && dir !== linkedDir) {
    await relinkUploads(serveUrl); // MEDIA_DIR changes during runtime (the normal path is.env change→machine restart)
  }
  if (!uploadsLive) {
    await mkdir(dir, { recursive: true }); // ensure exists: cp must never ENOENT-race
    await cp(dir, path.join(serveUrl, 'media', 'uploads'), { recursive: true });
  }
  return serveUrl;
}

/**
 * Render a timeline state to video or audio at outputLocation.
 * @param {object} args
 * @param {import('../src/editor/types').TimelineState} args.state
 * @param {string} args.outputLocation  absolute output path
 * @param {'h264'|'vp8'|'mp3'|'wav'} [args.codec]
 * @param {[number, number]} [args.frameRange] inclusive Remotion frame range
 * @param {number} [args.videoBitrate] video bitrate in bits per second
 * @param {{id:string,label:string,hardware:boolean,transport:'server'}} [args.h264Profile]
 * @param {string} [args.vaapiDevice]
 * @param {(progress: number) => void} [args.onProgress]  0..1
 * @param {AbortSignal} [args.signal]
 */
export async function renderTimeline({
  state,
  outputLocation,
  onProgress,
  codec = 'h264',
  frameRange,
  scale,
  videoBitrate,
  h264Profile,
  vaapiDevice,
  signal,
}) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.items)) {
    throw new Error('renderTimeline: a valid TimelineState (with items[]) is required');
  }
  if (!outputLocation) throw new Error('renderTimeline: outputLocation is required');
  signal?.throwIfAborted();
  const cancelSignal = remotionCancelSignal(signal);

  const serveUrl = await getServeUrl();
  const inputProps = { state };
  const composition = await selectComposition({
    serveUrl, id: COMPOSITION_ID, inputProps, browserExecutable: browserExecutable(),
  });
  signal?.throwIfAborted();
  const rendered = await renderMediaOptimized({
    serveUrl,
    composition,
    codec,
    frameRange,
    inputProps,
    outputLocation,
    h264Profile,
    vaapiDevice,
    scale: scale && Number.isFinite(scale) && scale > 0 ? scale : 1,
    videoBitrate: Number.isFinite(videoBitrate) && videoBitrate > 0
      ? `${Math.round(videoBitrate / 1000)}k`
      : undefined,
    chromiumOptions: { gl: 'angle' },
    browserExecutable: browserExecutable(),
    onProgress: onProgress ? ({ progress }) => onProgress(progress) : undefined,
    cancelSignal,
  });
  return {
    outputLocation,
    ...(rendered.encoder ? { encoder: rendered.encoder } : {}),
    ...(rendered.encoderFallbackReason
      ? { encoderFallbackReason: rendered.encoderFallbackReason }
      : {}),
  };
}

/**
 * Render a single-clip sub-timeline to a video, optionally with alpha over a
 * transparent background (export MG animation = ProRes 4444 alpha; convert to video =
 * bake to an alpha webm). `state` should be a one-item timeline (item at frame 0).
 * @param {object} args
 * @param {import('../src/editor/types').TimelineState} args.state
 * @param {string} args.outputLocation
 * @param {'prores'|'vp8'|'h264'} [args.codec]
 * @param {boolean} [args.transparent]  render over transparency + carry alpha
 */
export async function renderClip({
  state,
  outputLocation,
  codec = 'vp8',
  transparent = true,
  h264Profile,
  vaapiDevice,
}) {
  if (!state || !Array.isArray(state.items) || !state.items.length) {
    throw new Error('renderClip: a single-item TimelineState is required');
  }
  if (!outputLocation) throw new Error('renderClip: outputLocation is required');
  const serveUrl = await getServeUrl();
  const inputProps = { state, transparent };
  const composition = await selectComposition({
    serveUrl, id: COMPOSITION_ID, inputProps, browserExecutable: browserExecutable(),
  });
  await renderMediaOptimized({
    serveUrl,
    composition,
    codec,
    inputProps,
    outputLocation,
    h264Profile,
    vaapiDevice,
    ...(transparent && codec === 'prores'
      ? { proResProfile: '4444', imageFormat: 'png', pixelFormat: 'yuva444p10le' }
      : {}),
    chromiumOptions: { gl: 'angle' },
    browserExecutable: browserExecutable(),
  });
  return outputLocation;
}

/**
 * Render still frames of a timeline as small JPEGs (backs view_timeline_frames
 * — the agent "sees" its own draft edits). Returns [{frame, base64}].
 * @param {object} args
 * @param {import('../src/editor/types').TimelineState} args.state
 * @param {number[]} args.frames  frame numbers to render
 * @param {unknown} [args.puppeteerInstance] Reused headless browser (when rendering thumbnails in batches
 *   Every cold start of Chrome is too slow); the caller passes in openBrowser once and closes it after use.
 */
/** Cap stills per call (contact-sheet path further compresses into one image). */
const STILL_MAX_FRAMES = 16;

export async function renderTimelineStills({ state, frames, puppeteerInstance }) {
  if (!state || !Array.isArray(state.items)) throw new Error('renderTimelineStills: state.items required');
  if (!Array.isArray(frames) || !frames.length) throw new Error('renderTimelineStills: frames[] required');
  const serveUrl = await getServeUrl();
  const inputProps = { state };
  // Reuse one browser for the batch when caller doesn't pass one — opening Chrome
  // per frame was the dominant cost of view_*_frames.
  const { openBrowser } = await import('@remotion/renderer');
  const ownBrowser = !puppeteerInstance;
  const browser = puppeteerInstance ?? await openBrowser('chrome', {
    browserExecutable: browserExecutable(),
    chromiumOptions: { gl: 'angle' },
  });
  try {
    const composition = await selectComposition({
      serveUrl, id: COMPOSITION_ID, inputProps,
      puppeteerInstance: browser,
      browserExecutable: browserExecutable(),
    });
    const out = [];
    const list = frames.slice(0, STILL_MAX_FRAMES);
    for (const frame of list) {
      const f = Math.max(0, Math.min(composition.durationInFrames - 1, Math.round(frame)));
      const { buffer } = await renderStill({
        serveUrl, composition, inputProps, frame: f,
        imageFormat: 'jpeg', jpegQuality: 72,
        // Slightly smaller cells when many frames → cheaper vision payload
        scale: (list.length > 6 ? 480 : 640) / composition.width,
        chromiumOptions: { gl: 'angle' },
        browserExecutable: browserExecutable(),
        offthreadVideoThreads: offthreadVideoThreads(),
        output: null,
        puppeteerInstance: browser,
      });
      out.push({ frame: f, base64: buffer.toString('base64') });
    }
    return out;
  } finally {
    if (ownBrowser) {
      try { await browser.close({ silent: true }); } catch { /* ignore */ }
    }
  }
}
