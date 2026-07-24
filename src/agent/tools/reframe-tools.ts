import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { detectFocalPoints, magnificationForAspect } from '../../reframe/detect';

// auto_reframe — Custom tool.
// reframe originally only had the "write/render" infrastructure (builtin:zoom + reserved
// __openchatcutReframeCurve = ReframeCurveV1), there is no "sample video → detect subject → automatically generate key frames"
// Agent tool. This tool connects the heuristic detection of src/reframe/detect.ts to EditorCore:
// Sampling target video → detect focus every intervalFrames → write setReframeKeyframe, frame by frame,
// Let a crop window like 16:9→9:16 follow the subject. Pixel sampling can only be run in the browser (headless and graceful error reporting).

type Args = Record<string, unknown>;

export const REFRAME_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'auto_reframe',
    description:
      "Auto-reframe a video clip: sample its frames, detect the subject/focal point per interval, and write reframe keyframes (builtin:zoom __openchatcutReframeCurve) so the crop window follows the subject when the canvas aspect differs (e.g. 16:9→9:16). Clears the clip's existing reframe keyframes first, then re-detects. Browser-only (needs the actual video pixels); returns an error if run headless or if the target isn't a video with a source.",
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Target video clip id (prefix ok).' },
        intervalFrames: { type: 'number', description: 'Sample the video every N frames (default 15, min 1). Smaller = more keyframes, slower.' },
        sensitivity: { type: 'number', description: '0..1 focus sharpness: higher snaps the focal point harder to the strongest-detail region (default 0.5).' },
        smooth: { type: 'number', description: '0..1 temporal EMA on focal path (default 0.45). Higher = less crop jitter; 0 = raw per-frame energy.' },
        maxSamples: { type: 'number', description: 'Cap on seek samples for long clips (default 60).' },
      },
      required: ['itemId'],
    },
  },
];

export const REFRAME_TOOL_NAMES = new Set(REFRAME_TOOL_SCHEMAS.map((t) => t.name));

/** Prefix matching parsing target clip(with tools.ts/effect-tools.ts of findItem Semantic consistency) */
function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const q = String(id ?? '');
  if (!q) return null;
  return items.find((it) => it.id === q || it.id.startsWith(q)) ?? null;
}

/** use media src Create an off-screen <video>,Wait until metadata is ready(take videoWidth/Height),Timeout */
function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.crossOrigin = 'anonymous'; // Same source /media/uploads has no impact; avoid contaminating read pixels when crossing sources
    video.preload = 'auto';
    const cleanup = (): void => {
      video.removeEventListener('loadedmetadata', onOk);
      video.removeEventListener('error', onErr);
    };
    const onOk = (): void => {
      cleanup();
      resolve(video);
    };
    const onErr = (): void => {
      cleanup();
      reject(new Error(`auto_reframe: Video loading failed (${src})`));
    };
    video.addEventListener('loadedmetadata', onOk, { once: true });
    video.addEventListener('error', onErr, { once: true });
    video.src = src;
    setTimeout(() => {
      if (video.readyState >= 1) onOk();
      else onErr();
    }, 8000);
  });
}

/** clear that clip all existing reframe keyframe(Automatic rerun = Full replacement,rather than superimposed) */
function clearReframe(ctx: AgentContext, item: TimelineItem): void {
  const kfs = item.zoom?.reframeCurve?.keyframes ?? [];
  for (const k of kfs) ctx.commands.removeReframeKeyframe(item.id, k.frame);
}

export async function execReframeTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'auto_reframe') return { error: `unknown tool ${name}` };

  // —— Boundary verification: environment (pixel sampling requires a browser) ——
  if (typeof document === 'undefined' || typeof HTMLVideoElement === 'undefined') {
    return { error: 'auto_reframe Requires browser environment(Video pixel sampling),None currently DOM,Unable to run.' };
  }

  const state: TimelineState = ctx.getState();
  const videos = state.items.filter((it) => it.kind === 'video');
  const item = findItem(videos, args.itemId);
  if (!item) {
    return { error: `Video not found clip ${args.itemId ?? '(missing itemId)'}`, available: videos.map((v) => ({ itemId: v.id, name: v.name })) };
  }
  if (!item.src) return { error: `clip ${item.id} No video source to sample(src Missing)` };

  // ——Parameter cleaning——
  const intervalFrames = Number.isFinite(Number(args.intervalFrames)) ? Math.max(1, Math.floor(Number(args.intervalFrames))) : undefined;
  const sensitivity = Number.isFinite(Number(args.sensitivity)) ? Math.max(0, Math.min(1, Number(args.sensitivity))) : undefined;
  const smooth = Number.isFinite(Number(args.smooth)) ? Math.max(0, Math.min(1, Number(args.smooth))) : undefined;
  const maxSamples = Number.isFinite(Number(args.maxSamples)) ? Math.max(4, Math.floor(Number(args.maxSamples))) : undefined;
  const dstAspect = state.height > 0 ? state.width / state.height : 16 / 9;

  // Same aspect as source → reframe is a no-op (magnification ≈ 1); still write center keyframes so UI shows a curve.
  try {
    const video = await loadVideo(item.src);
    const srcWidth = video.videoWidth || item.width || undefined;
    const srcHeight = video.videoHeight || item.height || undefined;
    const keyframes = await detectFocalPoints(video, {
      durationInFrames: item.durationInFrames,
      fps: state.fps,
      dstAspect,
      srcInFrame: item.srcInFrame ?? 0,
      intervalFrames,
      sensitivity,
      smooth,
      maxSamples,
      srcWidth,
      srcHeight,
    });

    if (!keyframes.length) {
      return { error: `auto_reframe: Unable to get from clip ${item.id} capture any frame(Video may not be readable)`, keyframes: 0 };
    }

    clearReframe(ctx, item);
    for (const k of keyframes) ctx.commands.setReframeKeyframe(item.id, k.frame, k.focalPointX, k.focalPointY, k.magnification);

    const mag = magnificationForAspect(srcWidth ?? 0, srcHeight ?? 0, dstAspect);
    return {
      ok: true,
      itemId: item.id,
      keyframes: keyframes.length,
      magnification: mag,
      dstAspect: Number(dstAspect.toFixed(4)),
      smooth: smooth ?? 0.45,
      note: mag <= 1.05
        ? 'The canvas is close to the source frame, and the cropping ratio≈1;The keyframe has been written, which is more obvious after changing the portrait canvas.'
        : 'reframe Keyframes have been written; use view_timeline_frames Self-check whether the cutting is in line with the main body.',
    };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : 'auto_reframe failed' };
  }
}
