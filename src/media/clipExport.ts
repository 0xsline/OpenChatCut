import type { TimelineItem, TimelineState } from '../editor/types';

// Single-clip render helpers (source 导出 MG 动画 / 转为视频). Build a one-item
// sub-timeline (the clip at frame 0, on the project's canvas) and POST it to
// /render-clip. Export = ProRes 4444 alpha .mov download (source's NLE format);
// bake = opaque h264 saved under uploads, returned as a path.

function clipState(state: TimelineState, item: TimelineItem): TimelineState {
  return { ...state, selectedId: null, transitions: [], markers: [], items: [{ ...item, startFrame: 0 }] };
}

const safeName = (s: string) => (s || 'clip').replace(/[^\w.\-]+/g, '_');

async function fail(res: Response, verb: string): Promise<never> {
  const info = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(info?.error ?? `${verb}失败（${res.status}）`);
}

/** 导出 MG 动画 → ProRes 4444 alpha .mov, downloaded in the browser */
export async function exportClipMov(state: TimelineState, item: TimelineItem): Promise<void> {
  const res = await fetch('/render-clip', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: clipState(state, item), codec: 'prores', transparent: true, mode: 'download', filename: safeName(item.name) }),
  });
  if (!res.ok) await fail(res, '导出');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName(item.name)}.mov`;
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
