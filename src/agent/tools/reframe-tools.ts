export { REFRAME_TOOL_SCHEMAS, REFRAME_TOOL_NAMES } from './schemas/reframe-tools';
import type { AgentContext } from '../context';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { detectFocalPoints, magnificationForAspect } from '../../reframe/detect';
import { focalFramesFromGeometry } from '../../reframe/geometry-focus';
import { analyzeAssetGeometry } from '../../geometry/visual-geometry';

// auto_reframe — Custom tool.
// reframe originally only had the "write/render" infrastructure (builtin:zoom + reserved
// __openchatcutReframeCurve = ReframeCurveV1), there is no "sample video → detect subject → automatically generate key frames"
// Agent tool. This tool connects the heuristic detection of src/reframe/detect.ts to EditorCore:
// Sampling target video → detect focus every intervalFrames → write frame by frame setReframeKeyframe,
// Let a cropping window like 16:9→9:16 follow the subject. Pixel sampling can only be run in the browser (headless and graceful error reporting).

type Args = Record<string, unknown>;

/** Prefix matching parsing target clip (same semantics as findItem of tools.ts/effect-tools.ts) */
function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const q = String(id ?? '');
  if (!q) return null;
  return items.find((it) => it.id === q || it.id.startsWith(q)) ?? null;
}

/** Use media src to create an off-screen <video>, wait for the metadata to be ready (get videoWidth/Height), and time out */
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
      reject(new Error(`auto_reframe: 视频加载失败 (${src})`));
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

/** Clear all existing reframe keyframes for this clip (automatic reframe = full replacement, not superposition)*/
function clearReframe(ctx: AgentContext, item: TimelineItem): void {
  const kfs = item.zoom?.reframeCurve?.keyframes ?? [];
  for (const k of kfs) ctx.commands.removeReframeKeyframe(item.id, k.frame);
}

export async function execReframeTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'auto_reframe') return { error: `unknown tool ${name}` };

  // —— Boundary verification: environment (pixel sampling requires a browser) ——
  if (typeof document === 'undefined' || typeof HTMLVideoElement === 'undefined') {
    return { error: 'auto_reframe 需要浏览器环境(视频像素采样),当前无 DOM,无法运行。' };
  }

  const state: TimelineState = ctx.getState();
  const videos = state.items.filter((it) => it.kind === 'video');
  const item = findItem(videos, args.itemId);
  if (!item) {
    return { error: `找不到视频 clip ${args.itemId ?? '(缺 itemId)'}`, available: videos.map((v) => ({ itemId: v.id, name: v.name })) };
  }
  if (!item.src) return { error: `clip ${item.id} 没有可采样的视频源(src 缺失)` };

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

    // Geometry-first: when the visual-geometry cache (person/face segments) is
    // available, focal points come from subject centers — no pixel sampling,
    // robust on complex backgrounds. Falls back to the energy-grid heuristic.
    const asset = item.src ? ctx.getDoc().assets.find((candidate) => candidate.src === item.src) : undefined;
    const geometryResult = asset ? await analyzeAssetGeometry(asset) : undefined;
    const geometry = geometryResult?.geometry;
    const usedGeometry = Boolean(geometry && geometry.segments.some((segment) => segment.zone.subject || segment.zone.face));

    const keyframes = usedGeometry
      ? focalFramesFromGeometry(geometry!, item.durationInFrames, state.fps, {
        srcInFrame: item.srcInFrame ?? 0,
        playbackRate: item.playbackRate,
        intervalFrames,
      })
      : await detectFocalPoints(video, {
        durationInFrames: item.durationInFrames,
        fps: state.fps,
        dstAspect,
        srcInFrame: item.srcInFrame ?? 0,
        playbackRate: item.playbackRate,
        intervalFrames,
        sensitivity,
        smooth,
        maxSamples,
        srcWidth,
        srcHeight,
      });

    if (!keyframes.length) {
      return { error: `auto_reframe: 未能从 clip ${item.id} 采到任何帧(视频可能不可读)`, keyframes: 0 };
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
      source: usedGeometry ? 'geometry' : 'energy-grid',
      note: usedGeometry
        ? '基于人像/人脸几何生成焦点（无需像素采样）。'
        : mag <= 1.05
          ? '画布与源画幅接近，裁切倍率≈1；关键帧已写入，换竖屏画布后更明显。'
          : 'reframe 关键帧已写入；用 view_timeline_frames 自检裁切是否跟主体。',
    };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : 'auto_reframe 失败' };
  }
}
