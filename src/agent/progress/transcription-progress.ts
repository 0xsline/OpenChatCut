// track_progress target=transcription — readiness of the "upload-and-transcribe" ASR jobs
// track_progress reads the job table; transcription runs client-side, so the
// "table" is the in-browser transcribe-jobs registry). generate-tools.ts owns
// target=generation; this Claude-owned handler is dispatched from tools.ts for
// target=transcription so that file stays untouched. On a terminal job it writes the
// words onto the pool asset (drafted like generation's completedAssets), so clips
// placed afterwards inherit the transcript while preserving word/frame alignment.
import type { AgentContext } from '../context';
import type { MediaAsset } from '../../editor/types';
import { getTranscribeJob, waitForTranscribeJobs, transcriptionReport } from '../../transcript/transcribe-jobs';
import { isComplete } from './job-model';

const DEFAULT_WAIT_SECONDS = 90;
const MAX_WAIT_SECONDS = 3600;

type Args = Record<string, unknown>;

function poolAssets(ctx: AgentContext): MediaAsset[] {
  return ctx.getDoc().assets ?? ctx.getState().assets ?? [];
}

/** G2 prefix match: comma-separated asset ids/prefixes → concrete pool asset ids.
 *  Ambiguous or unmatched queries are returned in `unresolved` (never silently dropped). */
function resolveAssetIds(ctx: AgentContext, raw: unknown): { ids: string[]; unresolved: string[] } {
  const assets = poolAssets(ctx);
  const queries = String(raw ?? '').split(',').map((q) => q.trim()).filter(Boolean);
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const q of queries) {
    const exact = assets.find((a) => a.id === q);
    if (exact) { ids.push(exact.id); continue; }
    const hits = assets.filter((a) => a.id.startsWith(q));
    if (hits.length === 1) ids.push(hits[0]!.id);
    else unresolved.push(q); // 0 hits or ambiguous prefix
  }
  return { ids: [...new Set(ids)], unresolved };
}

export async function execTranscriptionProgress(args: Args, ctx: AgentContext): Promise<unknown> {
  const action = args.action as 'params' | 'status' | 'wait';
  if (!['params', 'status', 'wait'].includes(action)) return { error: 'action must be params, status, or wait' };

  const { ids, unresolved } = resolveAssetIds(ctx, args.assetIds ?? args.jobIds);
  if (ids.length === 0) {
    return { error: `no matching asset for target=transcription assetIds=${String(args.assetIds ?? args.jobIds ?? '')}`, unresolved };
  }

  if (action === 'wait') {
    const seconds = typeof args.timeoutSeconds === 'number'
      ? Math.min(Math.max(0, args.timeoutSeconds), MAX_WAIT_SECONDS)
      : DEFAULT_WAIT_SECONDS;
    await waitForTranscribeJobs(ids, seconds * 1000);
  }

  const assets = poolAssets(ctx);
  const reports = ids.map((id) => {
    const asset = assets.find((a) => a.id === id);
    return transcriptionReport(id, getTranscribeJob(id), asset?.transcript?.length ?? 0);
  });

  // Persist terminal ASR results onto the pool asset as completed or failed.
  // Skip on action=params (params never mutates, mirroring generation progress).
  if (action !== 'params') {
    for (const id of ids) {
      const asset = assets.find((a) => a.id === id);
      if (!asset) continue;
      const job = getTranscribeJob(id);
      if (job?.status === 'done' && job.words && !(asset.transcript?.length)) {
        ctx.commands.setAssetTranscription(id, { transcript: job.words, transcribeStatus: 'done', transcribeError: undefined });
      } else if (job?.status === 'failed' && asset.transcribeStatus !== 'failed') {
        ctx.commands.setAssetTranscription(id, { transcribeStatus: 'failed', transcribeError: job.error });
      }
    }
  }

  const ready = reports.filter((r) => isComplete(r.status)).map((r) => r.assetId);
  return {
    ok: true,
    target: 'transcription',
    action,
    reports,
    ready,
    ...(unresolved.length ? { unresolved } : {}),
  };
}
