import type { TimelineItem, TimelineState } from '../editor/types';
import { t } from '../i18n/locale';
import { sanitizeFileName } from './fileName';

// Single-clip render helpers for exporting MG animation or baking it to video. Build a one-item
// sub-timeline (the clip at frame 0, on the project's canvas) and POST it to
// /render-clip. Export downloads a ProRes 4444 alpha .mov;
// bake = opaque h264 saved under uploads, returned as a path.

function clipState(state: TimelineState, item: TimelineItem): TimelineState {
  return { ...state, selectedId: null, transitions: [], markers: [], items: [{ ...item, startFrame: 0 }] };
}

async function fail(res: Response, verb: string): Promise<never> {
  const info = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(info?.error ?? t('{verb}失败（{status}）', { verb: t(verb), status: res.status }));
}

export interface ClipMovExportOptions {
  /** Download filename or basename. A trailing .mov is normalized automatically. */
  filename?: string;
}

/** 导出 MG 动画 → ProRes 4444 alpha .mov, downloaded in the browser */
export async function exportClipMov(
  state: TimelineState,
  item: TimelineItem,
  options: ClipMovExportOptions = {},
): Promise<void> {
  const requestedName = options.filename?.replace(/\.mov$/i, '') ?? item.name;
  const filename = sanitizeFileName(requestedName, 'clip');
  const res = await fetch('/render-clip', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: clipState(state, item),
      codec: 'prores',
      transparent: true,
      mode: 'download',
      filename,
    }),
  });
  if (!res.ok) await fail(res, '导出');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.mov`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 转为视频 → opaque h264 mp4 saved under uploads; returns its path (alpha is
 * flattened — this env's ffmpeg can't encode alpha webm/vp9). */
export async function bakeClipToVideo(state: TimelineState, item: TimelineItem): Promise<string> {
  const res = await fetch('/render-clip', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: clipState(state, item), codec: 'h264', transparent: false, mode: 'bake' }),
  });
  if (!res.ok) await fail(res, '转换');
  return (await res.json() as { path: string }).path;
}

/** Bake a clip to a transparent ProRes 4444 .mov under uploads; returns its path. The
 *  local renderer CAN encode ProRes alpha (unlike alpha webm), so this is the intermediate
 *  the e2b transcode reads. */
async function bakeClipToProres(state: TimelineState, item: TimelineItem): Promise<string> {
  const res = await fetch('/render-clip', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: clipState(state, item), codec: 'prores', transparent: true, mode: 'bake' }),
  });
  if (!res.ok) await fail(res, '转换');
  return (await res.json() as { path: string }).path;
}

/** 转为视频（透明）→ VP9 alpha WebM under uploads; returns its path. Renders a transparent
 *  ProRes .mov locally, then transcodes it to alpha webm in the e2b sandbox (whose ffmpeg
 *  can do vp9-alpha, which the local build cannot). This is the true "转为视频 =
 *  alpha webm". Throws if the sandbox is unavailable — the caller falls back to opaque h264. */
export async function bakeClipToAlphaWebm(state: TimelineState, item: TimelineItem): Promise<string> {
  const source = await bakeClipToProres(state, item);
  const res = await fetch('/e2b/transcode-alpha', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  if (!res.ok) await fail(res, '透明编码');
  return (await res.json() as { path: string }).path;
}
