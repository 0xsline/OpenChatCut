// track_progress target extension. generate-tools.ts owns target=generation;
// this module adds upload and visual-analysis while transcription remains in
// transcription-progress.ts. Missing targets default to generation.
import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { isMediaSrcReachable } from '../../persist/mediaBlobStore';
import {
  enqueueVisualAnalysis,
  getVisualAnalysisJob,
  visualAnalysisReport,
  waitForVisualAnalysisJobs,
  type VisualAnalysisStatus,
} from './visual-analysis-jobs';

type Args = Record<string, unknown>;

/** Immutably extend the track_progress schema with every supported target. */
export function withProgressTargets(schemas: AgentToolSchema[]): AgentToolSchema[] {
  return schemas.map((tool) => {
    if (tool.name !== 'track_progress') return tool;
    const properties = (tool.input_schema.properties ?? {}) as Record<string, unknown>;
    return {
      ...tool,
      description: `${tool.description} For target=transcription, poll ingest ASR readiness (Upload and transcribe) by assetIds instead of jobIds; a succeeded asset then carries a word-level transcript that clips inherit. target=upload checks whether each asset's media file is reachable (blob placeholders report running until relinked to /media/uploads); target=visual-analysis polls contact-sheet warm / frame-readiness jobs (enqueue on ingest; use view_asset_frames / view_timeline_frames for actual vision).`,
      input_schema: {
        ...tool.input_schema,
        properties: {
          ...properties,
          target: { type: 'string', enum: ['generation', 'transcription', 'upload', 'visual-analysis'], description: 'Which async task kind to inspect: generation (default), transcription, upload, or visual-analysis.' },
          assetIds: { type: 'string', description: 'Comma-separated asset IDs/prefixes, for target=transcription / upload / visual-analysis.' },
        },
        required: ['action'],
      },
    };
  });
}

type UploadStatus = 'succeeded' | 'running' | 'failed' | 'not_found';

/**
 * target=upload — for each asset, report whether bytes are ready for export / remote views.
 * - blob: / data: → still uploading (UI placeholder)
 * - /media/uploads → HEAD/range probe
 * - other remote URLs → treat as ready
 */
export async function execUploadProgress(args: Args, ctx: AgentContext): Promise<unknown> {
  const assets = ctx.getDoc().assets ?? [];
  const queried = String(args.assetIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const list = queried.length
    ? queried.map((q) => {
      const hit = assets.find((a) => a.id === q) ?? assets.find((a) => a.id.startsWith(q));
      return { q, hit };
    })
    : assets.map((hit) => ({ q: hit.id, hit }));

  const statuses: Array<{ assetId: string; status: UploadStatus; src?: string }> = [];
  for (const { q, hit } of list) {
    if (!hit) {
      statuses.push({ assetId: q, status: 'not_found' });
      continue;
    }
    const src = hit.src ?? '';
    if (src.startsWith('blob:') || src.startsWith('data:')) {
      statuses.push({ assetId: hit.id, status: 'running', src });
      continue;
    }
    if (!src) {
      statuses.push({ assetId: hit.id, status: 'failed', src });
      continue;
    }
    if (!src.startsWith('/media/uploads/')) {
      // Library / remote / generated — no local upload job.
      statuses.push({ assetId: hit.id, status: 'succeeded', src });
      continue;
    }
    const ok = await isMediaSrcReachable(src);
    statuses.push({ assetId: hit.id, status: ok ? 'succeeded' : 'running', src });
  }

  const action = String(args.action ?? 'status');
  if (action === 'wait') {
    const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0
      ? Math.min(args.timeoutMs, 30 * 60_000)
      : 10 * 60_000;
    const deadline = Date.now() + timeoutMs;
    // Re-poll until none running or timeout
    let current = statuses;
    while (current.some((s) => s.status === 'running') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      // re-run without recursion explosion — inline one probe pass
      current = [];
      for (const { q, hit } of list) {
        if (!hit) {
          current.push({ assetId: q, status: 'not_found' });
          continue;
        }
        const src = hit.src ?? '';
        // Refresh asset from live doc (src may have relinked mid-wait)
        const live = (ctx.getDoc().assets ?? []).find((a) => a.id === hit.id) ?? hit;
        const liveSrc = live.src ?? '';
        if (liveSrc.startsWith('blob:') || liveSrc.startsWith('data:')) {
          current.push({ assetId: live.id, status: 'running', src: liveSrc });
          continue;
        }
        if (liveSrc.startsWith('/media/uploads/')) {
          const ok = await isMediaSrcReachable(liveSrc);
          current.push({ assetId: live.id, status: ok ? 'succeeded' : 'running', src: liveSrc });
          continue;
        }
        current.push({ assetId: live.id, status: liveSrc ? 'succeeded' : 'failed', src: liveSrc || src });
      }
    }
    const pending = current.filter((s) => s.status === 'running').map((s) => s.assetId);
    return {
      ok: pending.length === 0,
      target: 'upload',
      action: 'wait',
      assets: current,
      ...(pending.length ? { stillRunning: pending, note: 'timeout or still uploading' } : {}),
    };
  }

  return {
    ok: true,
    target: 'upload',
    action: 'status',
    assets: statuses,
    note: 'blob: placeholders = running; /media/uploads probed for reachability; ready assets can export.',
  };
}

/**
 * target=visual-analysis — poll contact-sheet warm jobs per asset.
 * Auto-enqueues missing jobs for pool assets so wait/status always has something to say.
 */
export async function execVisualAnalysisProgress(
  args: Args = {},
  ctx?: AgentContext,
): Promise<unknown> {
  const assets = ctx?.getDoc().assets ?? [];
  const queried = String(args.assetIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  type Hit = { q: string; hit: (typeof assets)[number] | undefined };
  const list: Hit[] = queried.length
    ? queried.map((q) => {
      const hit = assets.find((a) => a.id === q) ?? assets.find((a) => a.id.startsWith(q));
      return { q, hit };
    })
    : assets.map((hit) => ({ q: hit.id, hit }));

  // Kick jobs for known assets that never started analysis.
  for (const { hit } of list) {
    if (!hit?.src) continue;
    if (!getVisualAnalysisJob(hit.id)) {
      enqueueVisualAnalysis({ id: hit.id, src: hit.src, kind: hit.kind });
    }
  }

  const reportOne = (q: string, hit: Hit['hit']) => {
    if (!hit) return visualAnalysisReport(q, undefined);
    return visualAnalysisReport(hit.id, getVisualAnalysisJob(hit.id));
  };

  let reports = list.map(({ q, hit }) => reportOne(q, hit));

  const action = String(args.action ?? 'status');
  if (action === 'wait') {
    const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0
      ? Math.min(args.timeoutMs, 15 * 60_000)
      : 3 * 60_000;
    const ids = reports
      .filter((r) => r.status === 'running')
      .map((r) => r.assetId);
    if (ids.length) await waitForVisualAnalysisJobs(ids, timeoutMs);
    // refresh
    reports = list.map(({ q, hit }) => {
      if (hit?.src && getVisualAnalysisJob(hit.id)?.status === 'running') {
        // blob may have relinked — re-enqueue with live src
        const live = (ctx?.getDoc().assets ?? []).find((a) => a.id === hit.id) ?? hit;
        if (live.src && !live.src.startsWith('blob:')) {
          enqueueVisualAnalysis({ id: live.id, src: live.src, kind: live.kind });
        }
      }
      const liveHit = hit
        ? (ctx?.getDoc().assets ?? []).find((a) => a.id === hit.id) ?? hit
        : undefined;
      return reportOne(q, liveHit);
    });
    // brief second wait if we just re-enqueued
    const stillIds = reports.filter((r) => r.status === 'running').map((r) => r.assetId);
    if (stillIds.length) {
      const left = Math.max(1000, timeoutMs - 1000);
      await waitForVisualAnalysisJobs(stillIds, left);
      reports = list.map(({ q, hit }) => {
        const liveHit = hit
          ? (ctx?.getDoc().assets ?? []).find((a) => a.id === hit.id) ?? hit
          : undefined;
        return reportOne(q, liveHit);
      });
    }
    const pending = reports.filter((r) => r.status === 'running').map((r) => r.assetId);
    return {
      ok: pending.length === 0,
      target: 'visual-analysis',
      action: 'wait',
      assets: reports,
      ...(pending.length
        ? { stillRunning: pending, note: 'timeout or still warming contact sheet' }
        : { note: 'visual analysis ready; use view_asset_frames / view_timeline_frames to SEE frames' }),
    };
  }

  return {
    ok: true,
    target: 'visual-analysis',
    action: 'status',
    assets: reports,
    note: 'running = warming; succeeded = source ready for view_asset_frames. Actual vision still uses frame tools.',
  };
}

/** @deprecated signature kept for older call sites that pass no ctx */
export type { VisualAnalysisStatus };
