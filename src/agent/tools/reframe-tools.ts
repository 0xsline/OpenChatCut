import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../context';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { detectFocalPoints, magnificationForAspect } from '../../reframe/detect';

// auto_reframe — 自定工具。
// reframe 原本只有“写入/渲染”基础设施(builtin:zoom + reserved
// __openchatcutReframeCurve = ReframeCurveV1),没有“采样视频→检测主体→自动生成关键帧”
// 的 Agent 工具。本工具把 src/reframe/detect.ts 的启发式检测接到 EditorCore:
// 采样目标视频 → 每隔 intervalFrames 检测焦点 → 逐帧写 setReframeKeyframe,
// 让 16:9→9:16 之类的裁剪窗口跟随主体。像素采样只能在浏览器跑(headless 优雅报错)。

type Args = Record<string, unknown>;

export const REFRAME_TOOL_SCHEMAS: Anthropic.Tool[] = [
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

/** 前缀匹配解析目标 clip(与 tools.ts/effect-tools.ts 的 findItem 语义一致) */
function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const q = String(id ?? '');
  if (!q) return null;
  return items.find((it) => it.id === q || it.id.startsWith(q)) ?? null;
}

/** 用媒体 src 建一个离屏 <video>,等元数据就绪(拿 videoWidth/Height),超时兜底 */
function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.crossOrigin = 'anonymous'; // 同源 /media/uploads 无影响;跨源时避免污染读像素
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

/** 清掉该 clip 已有的全部 reframe 关键帧(自动重跑 = 全量替换,而非叠加) */
function clearReframe(ctx: AgentContext, item: TimelineItem): void {
  const kfs = item.zoom?.reframeCurve?.keyframes ?? [];
  for (const k of kfs) ctx.commands.removeReframeKeyframe(item.id, k.frame);
}

export async function execReframeTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'auto_reframe') return { error: `unknown tool ${name}` };

  // —— 边界校验:环境(像素采样需浏览器) ——
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

  // —— 参数清洗 ——
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
      note: mag <= 1.05
        ? '画布与源画幅接近，裁切倍率≈1；关键帧已写入，换竖屏画布后更明显。'
        : 'reframe 关键帧已写入；用 view_timeline_frames 自检裁切是否跟主体。',
    };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : 'auto_reframe 失败' };
  }
}
