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

function responseFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get('Content-Disposition') ?? '';
  return disposition.match(/filename="([^"]+)"/i)?.[1] ?? fallback;
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
  const name = responseFilename(response, `${args.name ?? 'export'}.${ext}`);
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
