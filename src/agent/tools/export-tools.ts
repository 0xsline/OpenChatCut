export { EXPORT_TOOL_SCHEMAS, EXPORT_TOOL_NAMES } from './schemas/export-tools';
import type { AgentContext } from '../context';
import { recordExport, listExportHistory } from '../../persist/exportHistoryStore';
import { isTerminal, isComplete, isFailed, type JobReportBase } from '../progress/job-model';
import { materializeTimelineExport } from '../../export/materializeBlobMedia';
import { exportFailureFrom } from '../../export/exportFailure';
import { exportMediaExtension } from '../../export/exportMediaExtension';
import {
  agentExportMediaPoolState,
  notifyAgentExportSubmitted,
  resetAgentExportTrackingState,
  saveTrackedAgentExport,
  type AgentExportMediaPoolPlan,
} from '../../export/agentExportTracking';
import type { ExportJobResult } from '../../export/exportWorkflowTypes';
import type { ProjectDoc } from '../../editor/types';

// ═════════════════════════════════════ ══════════════════════════════════════
// Asynchronous rendering job tool
// --------------------------------------------------------------------------------
// The standard name for asynchronous export is submit_export(format=video/audio → return renderId).
// But `submit_export` has been occupied by the synchronous version of the tool (generate-tools.ts). To avoid conflicts with the same name, asynchronous
// The rendering submitter is named submit_render_job. Use track_export for polling.
// track_export parameters: required=['action']; renderIds (comma separated id/prefix),
// latest (default is true when renderIds is omitted), onlyActive, timelineId, timeoutSeconds (default is 20, 0=unbounded).
// The old singular renderId is still a compatible alias. The latest/ prefix is ​​resolved based on the commit records of this session (see sessionJobs).
//
// Agent runs in the browser, and the tool uses fetch to hit the /export/job endpoint of dev-server:
// POST /export/job → { renderId }
// GET /export/job/:id → { id, status, progress, result?, error? }
// After completion, result.path points to the temporary export file under /media/uploads/, which is the downloadUrl returned by the tool.
//
// Wiring is owned by tools.ts: schema metadata is imported from schemas/export-tools,
// while this executor module is loaded only after an export tool name is called.
// ═════════════════════════════════════ ══════════════════════════════════════

type Args = Record<string, unknown>;

const DEFAULT_WAIT_SECONDS = 20; // stays below the browser Agent's 30-second tool deadline
const MAX_WAIT_SECONDS = 3600;
const POLL_INTERVAL_MS = 500;

// Export family agent oriented vocabulary: server's succeeded is read as completed (with synchronous export submit_export
// The status:'completed' alignment - that's the final state of the exported family wire). The final state "judgment" itself takes the shared job-model
// of isComplete/isFailed/isTerminal (see below), this function is only responsible for the presentation of the family wire.
function mapStatus(status: string): string {
  return status === 'succeeded' ? 'completed' : status;
}

/** Backend /export/job/:id Fields that the tool cares about in the snapshot (others are ignored). */
interface JobSnapshot extends JobReportBase<'queued' | 'running' | 'succeeded' | 'failed'> {
  id: string;
  progress: number;
  result?: {
    path?: string;
    name?: string;
    sizeBytes?: number;
    codec?: string;
    durationSeconds?: number;
    width?: number;
    height?: number;
    fps?: number;
    sourceStartSeconds?: number;
  };
}

export type PollResult =
  | {
    ok: true;
    renderId: string;
    status: string;
    progress: number;
    downloadUrl?: string;
    name?: string;
    sizeBytes?: number;
    codec?: string;
    durationSeconds?: number;
    width?: number;
    height?: number;
    fps?: number;
    sourceStartSeconds?: number;
    mediaPoolStatus?: 'pending' | 'saved' | 'failed';
    mediaAssetId?: string;
    mediaPoolPath?: string;
    mediaPoolError?: string;
    error?: string;
  }
  | { error: string };

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Render jobs submitted THIS session — the lookup base for renderIds prefix
 * resolution and the latest/onlyActive/timelineId selectors. The local dev-server
 * has no list endpoint, so the session registry
 * stands in). Full ids not in the registry still pass straight through to the
 * server. ponytail: session-scoped; add a /export/jobs list endpoint if
 * cross-reload latest ever matters. */
interface SessionJob { renderId: string; timelineId?: string; saveToMediaPool: boolean }
// push order = submission order → newest is the LAST entry (no clock needed).
const sessionJobs: SessionJob[] = [];

/** Test seam: reset the session job registry. */
export function __resetExportSessionJobs(): void {
  sessionJobs.length = 0;
  resetAgentExportTrackingState();
}

// A completed job would be re-seen on every poll; dedupe by renderId so repeated
// status/wait calls record the export exactly once (per session).
const recordedRenderIds = new Set<string>();

/** Record a completed async render into the global export history (once per renderId). */
function recordIfCompleted(result: PollResult): void {
  if (!('ok' in result) || !isComplete(result.status) || !result.downloadUrl || recordedRenderIds.has(result.renderId)) return;
  recordedRenderIds.add(result.renderId);
  const format = result.codec === 'mp3' || result.codec === 'wav' ? 'audio' : 'video';
  void recordExport({ name: result.name ?? result.renderId, format, codec: result.codec, sizeBytes: result.sizeBytes, createdAt: Date.now() });
}

function mediaPoolPlan(
  project: ProjectDoc,
  timelineId: string,
  format: 'video' | 'audio',
): AgentExportMediaPoolPlan {
  const timeline = project.timelines.find((candidate) => candidate.id === timelineId);
  if (!timeline) throw new Error(`timeline ${timelineId} not found`);
  return {
    format,
    timelineId,
    timelineName: timeline.name,
    timelineFps: timeline.fps,
    items: timeline.items.flatMap((item) => item.sourceAssetId ? [{
      id: item.id,
      sourceAssetId: item.sourceAssetId,
      startFrame: item.startFrame,
      durationInFrames: item.durationInFrames,
      srcInFrame: item.srcInFrame,
      playbackRate: item.playbackRate,
    }] : []),
  };
}

function withMediaPoolState(result: PollResult): PollResult {
  if (!('ok' in result) || !isComplete(result.status)) return result;
  const job = sessionJobs.find((candidate) => candidate.renderId === result.renderId);
  if (!job?.saveToMediaPool) return result;
  const state = agentExportMediaPoolState(result.renderId) ?? { status: 'pending' as const };
  if (state.status === 'saved') {
    return { ...result, mediaPoolStatus: 'saved', mediaAssetId: state.mediaAssetId, mediaPoolPath: state.path };
  }
  if (state.status === 'failed') return { ...result, mediaPoolStatus: 'failed', mediaPoolError: state.error };
  return { ...result, mediaPoolStatus: 'pending' };
}

/** GET /export/job/:id once, mapping the snapshot to the tool result; transmission/unknown renderId will return a clean error and never throw a naked exception.
 * Exported for register_converted_video (mg-video-tools): resolve a finished render's downloadUrl by renderId. */
export async function fetchRenderJob(renderId: string): Promise<PollResult> {
  return pollOnce(renderId);
}

async function pollOnce(renderId: string): Promise<PollResult> {
  const response = await fetch(`/export/job/${encodeURIComponent(renderId)}`, { method: 'GET' });
  if (response.status === 404) return { error: `render job ${renderId} not found` };
  const snapshot = (await response.json().catch(() => null)) as JobSnapshot | { error?: string } | null;
  if (!response.ok || !snapshot || !('status' in snapshot)) {
    const message = snapshot && 'error' in snapshot ? snapshot.error : undefined;
    return { error: message ?? `track_export failed (${response.status})` };
  }
  const completed = isComplete(snapshot.status);
  const result = snapshot.result;
  return {
    ok: true,
    renderId: snapshot.id,
    status: mapStatus(snapshot.status),
    progress: snapshot.progress,
    ...(completed && result?.path ? {
      downloadUrl: result.path,
      name: result.name,
      sizeBytes: result.sizeBytes,
      codec: result.codec,
      durationSeconds: result.durationSeconds,
      width: result.width,
      height: result.height,
      fps: result.fps,
      sourceStartSeconds: result.sourceStartSeconds,
    } : {}),
    ...(isFailed(snapshot.status) && snapshot.error ? { error: snapshot.error } : {}),
  };
}

async function submitRenderJob(args: Args, ctx: AgentContext): Promise<unknown> {
  try {
    const format = args.format === 'audio' ? 'audio' : 'video';
    const project = ctx.getDoc();
    const timelineId = project.activeTimelineId;
    const projectId = ctx.getProjectId?.();
    const savePlan = args.saveToMediaPool === true
      ? mediaPoolPlan(project, timelineId, format)
      : undefined;
    if (savePlan && !projectId) return { error: 'saveToMediaPool requires an open project' };
    const snapshot = await materializeTimelineExport(project, timelineId);
    const body: Record<string, unknown> = {
      state: snapshot.state,
      project: snapshot.project,
      timelineId: snapshot.timelineId,
      format,
    };
    if (typeof args.resolution === 'string') body.resolution = args.resolution;
    if (typeof args.fps === 'number') body.fps = args.fps;
    if (typeof args.videoBitrate === 'number') body.videoBitrate = args.videoBitrate;
    if (typeof args.codec === 'string') body.codec = args.codec;
    if (typeof args.name === 'string') body.name = args.name;
    if (typeof args.startFrame === 'number') body.startFrame = args.startFrame;
    if (typeof args.endFrameExclusive === 'number') body.endFrameExclusive = args.endFrameExclusive;
    if (typeof args.startSeconds === 'number') body.startSeconds = args.startSeconds;
    if (typeof args.endSeconds === 'number') body.endSeconds = args.endSeconds;

    const response = await fetch('/export/job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as { renderId?: string; error?: string };
    if (!response.ok || !data.renderId) return { error: data.error ?? `render job submit failed (${response.status})` };
    sessionJobs.push({ renderId: data.renderId, timelineId, saveToMediaPool: !!savePlan });
    if (projectId) {
      const codec = format === 'audio' ? 'mp3' : args.codec === 'vp8' ? 'vp8' : 'h264';
      const extension = format === 'audio' && args.codec === 'wav'
        ? 'wav'
        : exportMediaExtension(format, codec);
      notifyAgentExportSubmitted({
        renderId: data.renderId,
        projectId,
        label: typeof args.name === 'string' && args.name.trim()
          ? args.name
          : `${snapshot.state.name || 'export'}.${extension}`,
        createdAt: Date.now(),
        saveToMediaPool: savePlan,
      });
    }
    return {
      ok: true,
      renderId: data.renderId,
      format,
      ...(savePlan ? { mediaPoolStatus: 'pending' } : {}),
      next: `This job is visible in the editor's top-right export queue. Call track_export once with renderIds=${data.renderId}, action=wait, timeoutSeconds=20. If it is still queued/running, report its background progress and end this turn; do not start another export for the same timeline.`,
    };
  } catch (error) {
    const failure = exportFailureFrom(error);
    if (failure) {
      return {
        error: failure.message,
        code: failure.code,
        retryable: failure.retryable,
      };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Comma separated ids/prefixes → complete list of renderIds. Prefix parses the session submission record; unknown
 *  The token is transparently transmitted to the server as it is (it may be the complete ID obtained elsewhere). Ambiguous prefixes report clarity errors.*/
function resolveRenderIds(raw: string): { ids: string[] } | { error: string } {
  const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return { error: 'renderIds is empty — pass comma-separated render job IDs or prefixes' };
  const ids: string[] = [];
  for (const token of tokens) {
    if (sessionJobs.some((j) => j.renderId === token)) { ids.push(token); continue; }
    const matches = sessionJobs.filter((j) => j.renderId.startsWith(token));
    if (matches.length > 1) return { error: `renderIds prefix "${token}" is ambiguous (${matches.map((m) => m.renderId).join(', ')})` };
    ids.push(matches.length === 1 ? matches[0]!.renderId : token);
  }
  return { ids: [...new Set(ids)] };
}

/** latest semantics when renderIds is omitted: latest matching job; onlyActive only leaves in progress;
 *  latest=false lists all recent jobs. Submit records based on this session + real-time polling status.*/
async function selectLatestJobs(args: Args): Promise<{ ids: string[]; note?: string } | { error: string }> {
  const timelineQ = typeof args.timelineId === 'string' ? args.timelineId.trim() : '';
  const candidates = sessionJobs
    .filter((j) => !timelineQ || (j.timelineId ?? '').startsWith(timelineQ))
    .reverse(); // newest (last submitted) first — filter() copies, reverse is safe
  if (!candidates.length) {
    return { error: timelineQ
      ? `no render jobs recorded this session for timeline "${timelineQ}"`
      : 'no render jobs recorded this session — pass renderIds from submit_render_job' };
  }
  if (args.latest === false) return { ids: candidates.map((j) => j.renderId), note: 'latest=false: all recent render jobs this session, newest first' };
  if (args.onlyActive === true) {
    for (const j of candidates) {
      const r = await pollOnce(j.renderId);
      if ('ok' in r && !isTerminal(r.status)) return { ids: [j.renderId] };
    }
    return { ids: [], note: 'no currently rendering job (onlyActive=true); use onlyActive=false to include completed/failed renders' };
  }
  return { ids: [candidates[0]!.renderId] };
}

/** Each group of jobs is polled once.*/
function completedExportResult(result: PollResult): ExportJobResult | null {
  if (!('ok' in result) || !isComplete(result.status)) return null;
  return {
    path: result.downloadUrl,
    name: result.name,
    sizeBytes: result.sizeBytes,
    durationSeconds: result.durationSeconds,
    width: result.width,
    height: result.height,
    fps: result.fps,
    sourceStartSeconds: result.sourceStartSeconds,
  };
}

async function pollAll(ids: string[], ctx: AgentContext): Promise<PollResult[]> {
  const polled = await Promise.all(ids.map((id) => pollOnce(id)));
  for (const result of polled) {
    const completed = completedExportResult(result);
    const job = 'ok' in result
      ? sessionJobs.find((candidate) => candidate.renderId === result.renderId)
      : undefined;
    if (completed && job?.saveToMediaPool) {
      await saveTrackedAgentExport(job.renderId, completed, {
        commands: ctx.commands,
        getDoc: ctx.getDoc,
      }).catch(() => undefined);
    }
  }
  const results = polled.map(withMediaPoolState);
  for (const r of results) recordIfCompleted(r);
  return results;
}

/** Single job keeps the old flat return; multi-job returns {ok, count, jobs} aggregation.*/
function presentJobs(results: PollResult[], note?: string): Record<string, unknown> {
  if (results.length === 1 && !note) return { ...results[0] };
  return { ok: true, count: results.length, jobs: results, ...(note ? { note } : {}) };
}

async function trackExport(args: Args, ctx: AgentContext): Promise<unknown> {
  try {
    const action = args.action === 'wait' ? 'wait' : args.action === 'status' ? 'status' : null;
    if (!action) return { error: 'action is required: "status" or "wait"' };

    // renderIds (comma separated) take precedence; old singular renderIds are still compatible; both lack → latest semantics.
    const rawIds = typeof args.renderIds === 'string' && args.renderIds.trim()
      ? args.renderIds
      : typeof args.renderId === 'string' && args.renderId.trim() ? args.renderId : '';
    let ids: string[];
    let note: string | undefined;
    if (rawIds) {
      const resolved = resolveRenderIds(rawIds);
      if ('error' in resolved) return resolved;
      ids = resolved.ids;
    } else {
      const selected = await selectLatestJobs(args);
      if ('error' in selected) return selected;
      ids = selected.ids;
      note = selected.note;
      if (!ids.length) return { ok: true, count: 0, jobs: [], ...(note ? { note } : {}) };
    }

    if (action === 'status') return presentJobs(await pollAll(ids, ctx), note);

    // action=wait: Poll until all selected jobs are finalized, or timeoutSeconds expires (default 20, 0=unbounded).
    const requested = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds) ? args.timeoutSeconds : DEFAULT_WAIT_SECONDS;
    const bounded = Math.min(Math.max(requested, 0), MAX_WAIT_SECONDS);
    const deadline = bounded === 0 ? Infinity : Date.now() + bounded * 1000;
    for (;;) {
      const results = await pollAll(ids, ctx);
      const allSettled = results.every((r) => !('ok' in r) || isTerminal(r.status));
      if (allSettled) return presentJobs(results, note);
      if (Date.now() >= deadline) return {
        ...presentJobs(results, note),
        waitExpired: true,
        background: true,
        next: 'The render continues in the background. Report renderId, status, and progress now and end this turn. Do not submit another render or direct the user to the Export button for the same timeline.',
      };
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Execute an asynchronous rendering tool. Returns JSON serializable results and never throws naked exceptions.*/
export async function execExportTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  switch (name) {
    case 'submit_render_job':
      return submitRenderJob(args, ctx);
    case 'track_export':
      return trackExport(args, ctx);
    case 'read_export_history': {
      const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 20;
      const limit = Math.min(Math.max(requested, 1), 100);
      const history = await listExportHistory(limit);
      return { ok: true, count: history.length, history };
    }
    default:
      return { error: `export tool not implemented: ${name}` };
  }
}
