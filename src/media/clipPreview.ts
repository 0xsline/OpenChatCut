import { useEffect, useState } from 'react';

// 时间线片段的预览数据(音波峰值 + 视频缩略帧条)。服务端 /api/waveform、
// /api/filmstrip 产出并落盘缓存(见 server/plugins/media-preview.ts);本模块只管
// 「按 src 去重 + 进程内缓存 + 订阅」——同一素材被切成 N 段时只发一次请求。
// 波形与帧条由本地 ffmpeg 生成，客户端负责时间映射。

export interface ClipPreview {
  /** 0..1 振幅包络,每秒 peaksPerSecond 个;无音轨为空数组 */
  peaks: number[];
  peaksPerSecond: number;
  /** 源文件真实时长(不是片段裁剪后的时长) */
  durationMs: number;
  /** 视频帧条 URL(仅 video;未就绪/失败为 null) */
  stripUrl: string | null;
}

type Entry = { value: ClipPreview | null; promise: Promise<void> | null; listeners: Set<() => void> };

const entries = new Map<string, Entry>();

/** 仅本机素材可预览(blob:/远程 URL 服务端够不到) */
export function isPreviewable(src: string | undefined): src is string {
  return !!src && src.startsWith('/media/uploads/');
}

function entryFor(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { value: null, promise: null, listeners: new Set() };
    entries.set(key, e);
  }
  return e;
}

async function load(src: string, wantStrip: boolean, e: Entry): Promise<void> {
  const q = `src=${encodeURIComponent(src)}`;
  const wave = await fetch(`/api/waveform?${q}`)
    .then((r) => (r.ok ? r.json() as Promise<{ peaks?: number[]; peaksPerSecond?: number; durationMs?: number }> : null))
    .catch(() => null);
  // 帧条只探一次可用性:成功就把 URL 交给 CSS 背景(浏览器自己缓存字节)
  const stripUrl = wantStrip
    ? await fetch(`/api/filmstrip?${q}`).then((r) => (r.ok ? `/api/filmstrip?${q}` : null)).catch(() => null)
    : null;
  e.value = {
    peaks: wave?.peaks ?? [],
    peaksPerSecond: wave?.peaksPerSecond ?? 100,
    durationMs: wave?.durationMs ?? 0,
    stripUrl,
  };
  for (const fn of e.listeners) fn();
}

/**
 * 片段预览数据。同一 src 的多个片段共享一次请求与一份结果。
 * kind 决定要不要帧条(video 才要);非本机素材直接返回 null。
 */
export function useClipPreview(src: string | undefined, kind: string): ClipPreview | null {
  const key = isPreviewable(src) ? src : '';
  const wantStrip = kind === 'video';
  const [, bump] = useState(0);

  useEffect(() => {
    if (!key) return;
    const e = entryFor(key);
    const onChange = () => bump((n) => n + 1);
    e.listeners.add(onChange);
    if (!e.value && !e.promise) {
      e.promise = load(key, wantStrip, e).finally(() => { e.promise = null; });
    }
    return () => { e.listeners.delete(onChange); };
  }, [key, wantStrip]);

  return key ? entryFor(key).value : null;
}

/**
 * 片段内的几何映射:
 * 片段左边缘对齐源帧 srcIn,每个时间线像素前进 playbackRate/px 源帧。
 * 帧条整条覆盖 [0, 源时长),故 CSS 背景横向尺寸 = 源帧数 × px / rate,
 * 横向位移 = -srcIn × px / rate。
 */
export function filmstripBackground(
  preview: ClipPreview,
  { px, fps, srcInFrame, playbackRate }: { px: number; fps: number; srcInFrame: number; playbackRate: number },
): { backgroundImage: string; backgroundSize: string; backgroundPositionX: string } | null {
  if (!preview.stripUrl || !preview.durationMs) return null;
  const rate = playbackRate > 0 ? playbackRate : 1;
  const srcFrames = (preview.durationMs / 1000) * fps;
  const fullW = (srcFrames * px) / rate;
  if (!(fullW > 0)) return null;
  return {
    backgroundImage: `url(${preview.stripUrl})`,
    backgroundSize: `${fullW.toFixed(1)}px 100%`,
    backgroundPositionX: `${(-(srcInFrame * px) / rate).toFixed(1)}px`,
  };
}

/**
 * 片段可见窗口内的音波路径(与帧条同一映射)。返回 SVG path;无峰值返回空串。
 * 纵坐标以 height/2 为轴对称,x 按像素逐列取该列覆盖的峰值最大者(避免抽样闪烁)。
 */
export function peaksPath(
  preview: ClipPreview,
  { widthPx, height, fps, srcInFrame, durationInFrames, playbackRate }: {
    widthPx: number; height: number; fps: number;
    srcInFrame: number; durationInFrames: number; playbackRate: number;
  },
): string {
  const { peaks, peaksPerSecond } = preview;
  if (!peaks.length || widthPx <= 0) return '';
  const rate = playbackRate > 0 ? playbackRate : 1;
  const cols = Math.max(1, Math.min(2000, Math.floor(widthPx / 2)));
  const mid = height / 2;
  const perFrame = peaksPerSecond / fps; // 一源帧对应多少个峰值
  const startIdx = srcInFrame * perFrame;
  const spanIdx = durationInFrames * rate * perFrame;
  const out: string[] = [];
  for (let c = 0; c < cols; c += 1) {
    const from = startIdx + (c / cols) * spanIdx;
    const to = startIdx + ((c + 1) / cols) * spanIdx;
    let peak = 0;
    const lo = Math.max(0, Math.floor(from));
    const hi = Math.min(peaks.length - 1, Math.max(lo, Math.ceil(to) - 1));
    for (let i = lo; i <= hi; i += 1) if (peaks[i]! > peak) peak = peaks[i]!;
    const amp = Math.max(0.5, peak * (mid - 0.5));
    const x = ((c + 0.5) / cols) * widthPx;
    out.push(`M${x.toFixed(1)} ${(mid - amp).toFixed(1)}V${(mid + amp).toFixed(1)}`);
  }
  return out.join(' ');
}
