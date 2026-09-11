// Shared server-side render pipeline: bundle → selectComposition → renderMedia.
// Used by the server export endpoint and Electron packaging.
// Headless Lambda-style render: templates are compiled
// at render time in headless Chrome exactly as the Player does, so audio muxes
// natively and no template porting is needed.
import { makeCancelSignal, openBrowser, RenderInternals, selectComposition, renderMedia, renderStill } from '@remotion/renderer';
import { rm } from 'node:fs/promises';
import {
  h264FfmpegOverride,
  remotionHardwareAcceleration,
  resolveH264VideoBitrate,
  resolveOffthreadVideoThreads,
  resolveRenderConcurrency,
  withEncoderProfileFallback,
  h264HardwareSupportsDimensions,
  SOFTWARE_H264_PROFILE,
} from './performance.mjs';
import { renderDirectHardware } from './direct-hardware.mjs';
import { assertMaterializedRenderSnapshot, normalizeH264Profile } from './render-contract.mjs';
import { resolveRenderTimeout } from './render-timeout.mjs';
import { getServeUrl } from './serve-bundle.mjs';

export { prebuildServeBundle, setUploadsDirProvider } from './serve-bundle.mjs';

export { assertMaterializedRenderSnapshot } from './render-contract.mjs';

const COMPOSITION_ID = 'timeline';
const renderTimeoutInMilliseconds = () => resolveRenderTimeout();

/** Renderer GL backend. Default angle (Metal on macOS, D3D on Windows);
 *  Linux prefers angle-egl (works without X11). CC_RENDER_GL overrides for
 *  diagnosis or GPU-less machines ('swangle' forces software). */
const RENDER_GL_OVERRIDES = new Set(['angle', 'angle-egl', 'egl', 'vulkan', 'swangle', 'null']);
function resolveRenderGlBackend() {
  const override = process.env.CC_RENDER_GL;
  if (override && RENDER_GL_OVERRIDES.has(override)) return override;
  return process.platform === 'linux' ? 'angle-egl' : 'angle';
}
const browserExecutable = () => process.env.CC_BROWSER_EXECUTABLE || undefined;
const binariesDirectory = () => process.env.CC_REMOTION_BINARIES_DIR || null;

export function currentRenderConcurrency() {
  return resolveRenderConcurrency();
}

export function remotionFfmpegPath() {
  return RenderInternals.getExecutablePath({
    type: 'ffmpeg',
    indent: false,
    logLevel: 'error',
    binariesDirectory: binariesDirectory(),
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
/**
 * Own one browser across composition selection and the render which consumes it.
 * Closing that browser is the supported cancellation boundary for selectComposition.
 */
export async function withAbortableCompositionSelection({
  signal,
  selectionOptions,
  run,
  openBrowserImpl = openBrowser,
  selectCompositionImpl = selectComposition,
}) {
  signal?.throwIfAborted();
  const browser = await openBrowserImpl('chrome', {
    browserExecutable: browserExecutable(),
    chromiumOptions: { gl: resolveRenderGlBackend() },
  });
  let closePromise;
  const closeBrowser = () => closePromise ??= Promise.resolve(browser.close({ silent: true })).catch(() => undefined);
  const onAbort = () => { void closeBrowser(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const composition = await selectCompositionImpl({
      ...selectionOptions,
      puppeteerInstance: browser,
    });
    signal?.throwIfAborted();
    return await run(composition, browser);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await closeBrowser();
  }
}

function directHardwareRenderer(directBinaries, abortSignal) {
  if (!directBinaries) return renderMedia;
  // The custom ffmpeg override marks the hardware attempt; the software retry drops it
  // but keeps binariesDirectory, which every attempt needs once the app ships as an asar.
  return (attempt) => attempt.ffmpegOverride
    ? renderDirectHardware({ render: renderMedia, options: attempt, binariesDirectory: directBinaries, signal: abortSignal })
    : renderMedia(attempt);
}

/** Render with the selected probed engine, then make a truthful software retry. */
async function renderMediaOptimized(options) {
  const { abortSignal, h264Profile, vaapiDevice, ...renderOptions } = options;
  const requestedProfile = normalizeH264Profile(renderOptions.codec, h264Profile);
  // The output frame, not the composition frame: `scale` is what turns a 1080p
  // timeline into a 4k render, and the encoder only ever sees the scaled size.
  const outputScale = renderOptions.scale ?? 1;
  const outputWidth = renderOptions.composition?.width * outputScale;
  const outputHeight = renderOptions.composition?.height * outputScale;
  // Hardware H.264 stops at 4096 per dimension. Discovering that mid-render
  // costs the whole render and, with hardwareAcceleration 'required', surfaces
  // as an opaque failure rather than degrading — so rule it out up front and
  // render in software instead of not at all.
  const oversizedForHardware = requestedProfile?.hardware
    && !h264HardwareSupportsDimensions(outputWidth, outputHeight);
  const profile = oversizedForHardware ? SOFTWARE_H264_PROFILE : requestedProfile;
  // Report the size Remotion actually encodes. The server renderer rounds
  // (mediaSettings.safeRenderPlan picks serverScale so the rounded result is
  // even), so ceiling here would name an odd frame the encoder never sees.
  const oversizeFallbackReason = oversizedForHardware
    ? `${requestedProfile.id}: frame ${Math.round(outputWidth)}x${Math.round(outputHeight)} exceeds the hardware H.264 limit of 4096`
    : null;
  if (oversizeFallbackReason) {
    console.warn(`[render] ${oversizeFallbackReason}; encoding with software libx264`);
  }
  const hardwareAcceleration = remotionHardwareAcceleration(renderOptions.codec, { encoder: profile?.id });
  const customOverride = profile?.hardware && hardwareAcceleration === 'disable'
    ? h264FfmpegOverride(profile.id, { vaapiDevice })
    : undefined;
  const directBinaries = customOverride ? binariesDirectory() : null;
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
    // The packaged app cannot chmod or spawn the compositor inside app.asar, so every
    // attempt renders from the mirrored directory (CC_REMOTION_BINARIES_DIR); dev keeps null.
    binariesDirectory: binariesDirectory(),
    ...(automaticBitrate ? { videoBitrate: automaticBitrate } : {}),
  };
  const render = directHardwareRenderer(directBinaries, abortSignal);
  if (!profile) return { result: await render(hardwareOptions), encoder: undefined };
  if (oversizeFallbackReason) {
    return {
      result: await render(hardwareOptions),
      encoder: profile,
      encoderFallbackReason: oversizeFallbackReason,
    };
  }
  return withEncoderProfileFallback({
    render,
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

/**
 * Render a timeline state to video or audio at outputLocation.
 * @param {object} args
 * @param {import('../src/editor/types').TimelineState} args.state
 * @param {import('../src/editor/types').ProjectDoc} [args.project]
 * @param {string} [args.timelineId]
 * @param {string} args.outputLocation  absolute output path
 * @param {'h264'|'vp8'|'prores'|'mp3'|'wav'} [args.codec]
 * @param {[number, number]} [args.frameRange] inclusive Remotion frame range
 * @param {number} [args.videoBitrate] video bitrate in bits per second
 * @param {{id:string,label:string,hardware:boolean,transport:'server'}} [args.h264Profile]
 * @param {string} [args.vaapiDevice]
 * @param {(progress: number) => void} [args.onProgress]  0..1
 * @param {AbortSignal} [args.signal]
 */
export async function renderTimeline({
  state,
  project,
  timelineId,
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
  assertMaterializedRenderSnapshot(state, 'renderTimeline');
  if (project) assertMaterializedRenderSnapshot(project, 'renderTimeline', timelineId);
  const cancelSignal = remotionCancelSignal(signal);

  const serveUrl = await getServeUrl();
  signal?.throwIfAborted();
  const inputProps = { state, project, timelineId };
  // Full-timeline mezzanine: ProRes 422 HQ (not 4444 alpha — that is clip/MG only).
  const proresOptions = codec === 'prores'
    ? { proResProfile: 'hq', imageFormat: 'png' }
    : {};
  const rendered = await withAbortableCompositionSelection({
    signal,
    selectionOptions: {
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
      binariesDirectory: binariesDirectory(),
      browserExecutable: browserExecutable(),
      timeoutInMilliseconds: renderTimeoutInMilliseconds(),
    },
    run: (composition, browser) => renderMediaOptimized({
      serveUrl,
      composition,
      codec,
      frameRange,
      inputProps,
      outputLocation,
      h264Profile,
      vaapiDevice,
      scale: scale && Number.isFinite(scale) && scale > 0 ? scale : 1,
      videoBitrate: codec === 'prores'
        ? undefined
        : Number.isFinite(videoBitrate) && videoBitrate > 0
          ? `${Math.round(videoBitrate / 1000)}k`
          : undefined,
      ...proresOptions,
      chromiumOptions: { gl: resolveRenderGlBackend() },
      browserExecutable: browserExecutable(),
      puppeteerInstance: browser,
      onProgress: onProgress ? ({ progress }) => onProgress(progress) : undefined,
      cancelSignal,
      abortSignal: signal,
      timeoutInMilliseconds: renderTimeoutInMilliseconds(),
    }),
  });
  signal?.throwIfAborted();
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
  signal,
}) {
  if (!state || !Array.isArray(state.items) || !state.items.length) {
    throw new Error('renderClip: a single-item TimelineState is required');
  }
  if (!outputLocation) throw new Error('renderClip: outputLocation is required');
  signal?.throwIfAborted();
  assertMaterializedRenderSnapshot(state, 'renderClip');
  const cancelSignal = remotionCancelSignal(signal);
  const serveUrl = await getServeUrl();
  signal?.throwIfAborted();
  const inputProps = { state, transparent };
  await withAbortableCompositionSelection({
    signal,
    selectionOptions: {
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
      binariesDirectory: binariesDirectory(),
      browserExecutable: browserExecutable(),
      timeoutInMilliseconds: renderTimeoutInMilliseconds(),
    },
    run: (composition, browser) => renderMediaOptimized({
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
      chromiumOptions: { gl: resolveRenderGlBackend() },
      browserExecutable: browserExecutable(),
      puppeteerInstance: browser,
      timeoutInMilliseconds: renderTimeoutInMilliseconds(),
      cancelSignal,
      abortSignal: signal,
    }),
  });
  signal?.throwIfAborted();
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
 * @param {AbortSignal} [args.signal]
 */
/** Cap stills per call (contact-sheet path further compresses into one image). */
const STILL_MAX_FRAMES = 16;

export async function renderTimelineStills({
  state,
  project,
  timelineId,
  frames,
  puppeteerInstance,
  signal,
}) {
  if (!state || !Array.isArray(state.items)) throw new Error('renderTimelineStills: state.items required');
  if (!Array.isArray(frames) || !frames.length) throw new Error('renderTimelineStills: frames[] required');
  signal?.throwIfAborted();
  assertMaterializedRenderSnapshot(state, 'renderTimelineStills');
  if (project) assertMaterializedRenderSnapshot(project, 'renderTimelineStills', timelineId);
  const serveUrl = await getServeUrl();
  signal?.throwIfAborted();
  const inputProps = { state, project, timelineId };
  // Reuse one browser for the batch when caller doesn't pass one — opening Chrome
  // per frame was the dominant cost of view_*_frames.
  const ownBrowser = !puppeteerInstance;
  const browser = puppeteerInstance ?? await openBrowser('chrome', {
    browserExecutable: browserExecutable(),
    chromiumOptions: { gl: resolveRenderGlBackend() },
  });
  const closeOnAbort = () => {
    if (ownBrowser) void browser.close({ silent: true }).catch(() => undefined);
  };
  signal?.addEventListener('abort', closeOnAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const composition = await selectComposition({
      serveUrl, id: COMPOSITION_ID, inputProps,
      puppeteerInstance: browser,
      browserExecutable: browserExecutable(),
      binariesDirectory: binariesDirectory(),
      timeoutInMilliseconds: renderTimeoutInMilliseconds(),
    });
    signal?.throwIfAborted();
    const out = [];
    const list = frames.slice(0, STILL_MAX_FRAMES);
    for (const frame of list) {
      signal?.throwIfAborted();
      const f = Math.max(0, Math.min(composition.durationInFrames - 1, Math.round(frame)));
      const { buffer } = await renderStill({
        serveUrl, composition, inputProps, frame: f,
        imageFormat: 'jpeg', jpegQuality: 72,
        // Slightly smaller cells when many frames → cheaper vision payload
        scale: (list.length > 6 ? 480 : 640) / composition.width,
        chromiumOptions: { gl: resolveRenderGlBackend() },
        browserExecutable: browserExecutable(),
        binariesDirectory: binariesDirectory(),
        offthreadVideoThreads: offthreadVideoThreads(),
        output: null,
        puppeteerInstance: browser,
        timeoutInMilliseconds: renderTimeoutInMilliseconds(),
      });
      signal?.throwIfAborted();
      out.push({ frame: f, base64: buffer.toString('base64') });
    }
    return out;
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
    if (ownBrowser) {
      try { await browser.close({ silent: true }); } catch { /* ignore */ }
    }
  }
}
