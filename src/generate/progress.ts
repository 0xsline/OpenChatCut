import type { MediaAsset, TimelineState } from '../editor/types';
import { isComplete, type JobReportBase } from '../agent/progress/job-model';

export interface TrackGenerationProgressArgs {
  action: 'params' | 'status' | 'wait';
  jobIds: string[];
  timeoutSeconds?: number;
}

interface GenerationJobResult {
  assetId?: string;
  kind?: 'audio' | 'video' | 'image';
  name?: string;
  path?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export interface GenerationJobReport extends JobReportBase<'queued' | 'running' | 'succeeded' | 'failed' | 'not_found'> {
  jobId: string;
  params?: Record<string, unknown>;
  result?: GenerationJobResult;
  results?: GenerationJobResult[];
}

interface ProgressResponse {
  reports?: GenerationJobReport[];
  error?: string;
}

export async function trackGenerationProgress(
  args: TrackGenerationProgressArgs,
  state: TimelineState,
): Promise<{ reports: GenerationJobReport[]; completedAssets: MediaAsset[] }> {
  const response = await fetch('/generate/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...args, target: 'generation' }),
  });
  const data = await response.json().catch(() => ({})) as ProgressResponse;
  if (!response.ok) throw new Error(data.error ?? `generation progress failed (${response.status})`);
  const reports = data.reports ?? [];
  const existing = new Set((state.assets ?? []).map((asset) => asset.id));
  const completedAssets: MediaAsset[] = [];

  for (const report of reports) {
    const results = report.results?.length ? report.results : report.result ? [report.result] : [];
    if (args.action === 'params' || !isComplete(report.status)) continue;
    for (const result of results) {
      if (existing.has(String(result.assetId))) continue;
      if (!result.assetId || !result.name || !result.path || !result.kind || !result.durationSeconds) continue;
      const asset: MediaAsset = {
        id: result.assetId,
        name: result.name,
        kind: result.kind,
        src: result.path,
        durationInFrames: Math.max(1, Math.round(result.durationSeconds * state.fps)),
        width: result.width,
        height: result.height,
      };
      completedAssets.push(asset);
      existing.add(asset.id);
    }
  }

  return { reports, completedAssets };
}
