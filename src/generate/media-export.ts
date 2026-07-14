import type { TimelineState } from '../editor/types';

export interface SubmitMediaExportArgs {
  format: 'video' | 'audio';
  codec?: 'h264' | 'vp8' | 'mp3' | 'wav';
  name?: string;
  startFrame?: number;
  endFrameExclusive?: number;
  startSeconds?: number;
  endSeconds?: number;
}

export interface MediaExportResult {
  status: 'completed';
  format: 'video' | 'audio';
  codec: 'h264' | 'vp8' | 'mp3' | 'wav';
  name: string;
  sizeBytes: number;
  startFrame?: number;
  endFrameExclusive?: number;
  startSeconds?: number;
  endSeconds?: number;
}

export async function submitMediaExport(args: SubmitMediaExportArgs, state: TimelineState): Promise<MediaExportResult> {
  const codec = args.codec ?? (args.format === 'video' ? 'h264' : 'mp3');
  const ext = codec === 'h264' ? 'mp4' : codec === 'vp8' ? 'webm' : codec;
  const response = await fetch('/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, ...args }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? `media export failed (${response.status})`);
  }
  const blob = await response.blob();
  // 客户端本就有正确的 UTF-8 名字，直接用它做 anchor.download（anchor 走 JS 字符串，
  // 中文安全）；不再回解析服务端的 Content-Disposition 头（headers.get 按 ISO-8859-1 会乱码）。
  const base = (args.name ?? 'export').replace(/\.(?:mp4|webm|mp3|wav)$/i, '');
  const name = `${base}.${ext}`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return {
    status: 'completed',
    format: args.format,
    codec,
    name,
    sizeBytes: blob.size,
    startFrame: args.startFrame,
    endFrameExclusive: args.endFrameExclusive,
    startSeconds: args.startSeconds,
    endSeconds: args.endSeconds,
  };
}
