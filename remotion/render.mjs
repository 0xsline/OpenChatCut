// Shared server-side render pipeline: bundle → selectComposition → renderMedia.
// Used by the server export endpoint and Electron packaging.
// Headless Lambda-style render: templates are compiled
// at render time in headless Chrome exactly as the Player does, so audio muxes
// natively and no template porting is needed.
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, renderStill } from '@remotion/renderer';
import path from 'node:path';
import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  remotionHardwareAcceleration,
  resolveH264VideoBitrate,
  resolveOffthreadVideoThreads,
  resolveRenderConcurrency,
  withHardwareEncoderFallback,
} from './performance.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_POINT = path.join(REPO_ROOT, 'remotion', 'index.ts');
/** Product-bundled static files (fonts, thumbs, SFX, …) — NOT user uploads. */
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
/** User/runtime media root (only media/uploads under public/). */
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'media', 'uploads');
const COMPOSITION_ID = 'timeline';

// Bundling is expensive (webpack over the whole app + @babel/standalone), so we
// build the serve bundle once and reuse the serveUrl across every render.
let bundlePromise;

// 桌面打包版:运行时没有 src/ 源码与 webpack,serve bundle 在打包期预打好,
// 启动时经 CC_REMOTION_BUNDLE 指进来(可写目录——uploads symlink 要写进去);
// 无头浏览器同理经 CC_BROWSER_EXECUTABLE 指向随包分发的 chrome-headless-shell
// (默认 undefined = Remotion 自寻/自下载,dev 行为不变)。
const browserExecutable = () => process.env.CC_BROWSER_EXECUTABLE || undefined;

const renderConcurrency = () => resolveRenderConcurrency();
const offthreadVideoThreads = () => resolveOffthreadVideoThreads();

/**
 * Prefer the platform encoder, but retry with software when the encoder exists
 * in FFmpeg yet the actual GPU/driver is unavailable (common on Windows VMs and
 * systems without an NVIDIA device). Remotion's own probe only checks whether
 * the encoder is listed in the bundled FFmpeg build.
 */
async function renderMediaOptimized(options) {
  const hardwareAcceleration = remotionHardwareAcceleration(options.codec);
  const automaticHardwareBitrate = hardwareAcceleration !== 'disable' && !options.videoBitrate
    ? resolveH264VideoBitrate({
      width: options.composition.width,
      height: options.composition.height,
      fps: options.composition.fps,
      scale: options.scale ?? 1,
    })
    : null;
  const optimized = {
    ...options,
    concurrency: renderConcurrency(),
    offthreadVideoThreads: offthreadVideoThreads(),
    hardwareAcceleration,
    ...(automaticHardwareBitrate ? { videoBitrate: automaticHardwareBitrate } : {}),
  };
  return withHardwareEncoderFallback({
    render: renderMedia,
    hardwareOptions: optimized,
    softwareOptions: {
      ...optimized,
      hardwareAcceleration: 'disable',
      ...(automaticHardwareBitrate ? { videoBitrate: null } : {}),
    },
    cleanup: async () => {
      if (options.outputLocation) await rm(options.outputLocation, { force: true }).catch(() => {});
    },
    onFallback: () => {
      console.warn(`[render] hardware encoder unavailable; retrying ${options.codec} with software encoding`);
    },
  });
}

// 素材目录默认 public/media/uploads;dev server 侧可被 MEDIA_DIR 自定义——
// server/plugins/export 注入 provider(读 keystore)。standalone 脚本保持默认。
let uploadsDirProvider = () => UPLOAD_DIR;
let linkedDir = null; // <serveUrl>/media/uploads symlink 当前指向;目录变化时重连

/** @param {() => string} fn 返回当前素材目录绝对路径 */
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

/** webpack 打 serve bundle + public 覆盖(不 relink——那是运行时职责)。 */
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

/** 打包期预打 serve bundle 到 outDir(desktop/prebuild-remotion.mts 调)。 */
export async function prebuildServeBundle(outDir) {
  await rm(outDir, { recursive: true, force: true });
  return buildBundle(outDir);
}

// 把 <serveUrl>/media/uploads 指到当前素材目录(默认或 MEDIA_DIR 自定义)。
async function relinkUploads(serveUrl) {
  const dir = uploadsDirProvider();
  await mkdir(dir, { recursive: true });
  const linkPath = path.join(serveUrl, 'media', 'uploads');
  try {
    await rm(linkPath, { recursive: true, force: true });
    // win32 用 junction:目录软链要管理员/开发者模式,junction 免特权(需绝对路径,dir 恒绝对)
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
      ? relinkUploads(prebuilt).then(() => prebuilt)  // 预打 bundle:跳过 webpack,只接管 uploads
      : buildServeUrl();
  }
  const serveUrl = await bundlePromise;
  const dir = uploadsDirProvider();
  if (uploadsLive && dir !== linkedDir) {
    await relinkUploads(serveUrl); // MEDIA_DIR 运行时改动兜底(正常路径是 .env 变更→整机重启)
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
 * @param {(progress: number) => void} [args.onProgress]  0..1
 * @returns {Promise<string>} the outputLocation
 */
export async function renderTimeline({ state, outputLocation, onProgress, codec = 'h264', frameRange, scale }) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.items)) {
    throw new Error('renderTimeline: a valid TimelineState (with items[]) is required');
  }
  if (!outputLocation) throw new Error('renderTimeline: outputLocation is required');

  const serveUrl = await getServeUrl();
  const inputProps = { state };

  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, browserExecutable: browserExecutable() });

  await renderMediaOptimized({
    serveUrl,
    composition,
    codec,
    frameRange,
    inputProps,
    outputLocation,
    // 分辨率导出:按短边缩放(1080p 时间线选 720p → scale 2/3);默认 1 不缩放
    scale: scale && Number.isFinite(scale) && scale > 0 ? scale : 1,
    // GLSL transitions need WebGL2 in headless Chrome; 'angle' uses the native
    // GPU backend (Metal on macOS). Swap to 'swangle' (SwiftShader) on servers.
    chromiumOptions: { gl: 'angle' },
    browserExecutable: browserExecutable(),
    onProgress: onProgress ? ({ progress }) => onProgress(progress) : undefined,
  });

  return outputLocation;
}

/**
 * Render a single-clip sub-timeline to a video, optionally with alpha over a
 * transparent background (导出 MG 动画 = ProRes 4444 alpha; 转为视频 =
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
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, browserExecutable: browserExecutable() });
  await renderMediaOptimized({
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
 * @param {unknown} [args.puppeteerInstance]  复用的无头浏览器(批量渲缩略图时
 *   每次冷启 Chrome 太慢);调用方 openBrowser 一次传入、用完自己 close。
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
