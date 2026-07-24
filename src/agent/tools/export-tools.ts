import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { recordExport, listExportHistory } from '../../persist/exportHistoryStore';
import { isTerminal, isComplete, isFailed, type JobReportBase } from '../progress/job-model';

// ═══════════════════════════════════════════════════════════════════════════
// Asynchronous rendering job tool
// ---------------------------------------------------------------------------
// The standard name for asynchronous export is submit_export(format=video/audio → return renderId).
// However, `submit_export` has been occupied by the synchronous version of the tool (generate-tools.ts). To avoid conflicts with the same name, asynchronous
// The render submitter is named submit_render_job. Use track_export for polling.
// track_export parameter surface: required=['action']; renderIds (comma separated id/prefix),
// latest (default is true when renderIds is omitted), onlyActive, timelineId, timeoutSeconds (default is 90, 0=unbounded).
// The old singular renderId is still used as a compatible alias. The latest/ prefix is resolved based on the commit records of this session (see sessionJobs).
//
// Agent runs in the browser, and the tool uses fetch to hit the /export/job endpoint of dev-server:
//   POST /export/job     → { renderId }
//   GET  /export/job/:id → { id, status, progress, result?, error? }
// After completion, result.path points to the temporary export file under /media/uploads/, which is the downloadUrl returned by the tool.
//
// Wiring (the integrator does it in tools.ts, this file does not touch tools.ts):
//   import { EXPORT_TOOL_SCHEMAS, EXPORT_TOOL_NAMES, execExportTool } from './export-tools';
//   ...EXPORT_TOOL_SCHEMAS  /  if (EXPORT_TOOL_NAMES.has(name)) return execExportTool(name, args, ctx);
// ═══════════════════════════════════════════════════════════════════════════

type Args = Record<string, unknown>;

const DEFAULT_WAIT_SECONDS = 90; // schema: "Defaults to 90. Use 0 for unbounded wait."
const MAX_WAIT_SECONDS = 3600;
const POLL_INTERVAL_MS = 500;

export const EXPORT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'submit_render_job',
    description:
      'Render the active timeline ASYNCHRONOUSLY as MP4/WebM video or MP3/WAV audio. Returns immediately with a renderId instead of blocking; the render runs in a background job. Poll track_export for status/progress and the download URL. Prefer this over the synchronous submit_export for long timelines. Optional frame boundaries use a half-open [startFrame, endFrameExclusive) range.',
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['video', 'audio'], description: 'Defaults to video.' },
        codec: { type: 'string', enum: ['h264', 'vp8', 'mp3', 'wav'], description: 'Video: h264 (default) or vp8. Audio: mp3 (default) or wav.' },
        resolution: { type: 'string', enum: ['480p', '720p', '1080p'], description: 'Video only. Scale by the short side; omit to use the timeline size.' },
        fps: { type: 'integer', enum: [24, 25, 30, 50, 60], description: 'Video only. Target frame rate; omit to use the timeline fps.' },
        name: { type: 'string', description: 'Download filename.' },
        startFrame: { type: 'integer', minimum: 0 },
        endFrameExclusive: { type: 'integer', minimum: 1 },
        startSeconds: { type: 'number', minimum: 0, description: 'Legacy; prefer startFrame.' },
        endSeconds: { type: 'number', minimum: 0, description: 'Legacy; prefer endFrameExclusive.' },
      },
    },
  },
  {
    name: 'track_export',
    description:
      'Inspect render/export jobs started by submit_render_job. action=status: return current status. action=wait: poll until the selected jobs are terminal or timeoutSeconds elapses. Pass renderIds when available. If renderIds is omitted, latest defaults to true and returns the most recent matching render job. Set latest=false to list recent render jobs so you can tell which exports are complete, still rendering, or failed. onlyActive=true narrows the latest lookup to currently rendering jobs. Returns status, progress, and — when completed — a downloadUrl the browser can fetch.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'wait'], description: 'status or wait' },
        renderIds: { type: 'string', description: 'Comma-separated render job IDs or prefixes returned by submit_render_job.' },
        latest: { type: 'boolean', description: 'When true, read the newest matching render job. Defaults to true when renderIds is omitted.' },
        onlyActive: { type: 'boolean', description: 'When latest=true, return only currently rendering jobs. Use false/omit to include recently completed or failed renders.' },
        timelineId: { type: 'string', description: 'Optional timeline ID or prefix to narrow latest lookup.' },
        timeoutSeconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'For action=wait, maximum seconds before returning the current non-terminal status. Defaults to 90. Use 0 for unbounded wait.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'read_export_history',
    description:
      'List recent finished exports (most recent first): filename, format, codec, size, frame range, and time. Use to remind the user what they have already exported this session and earlier. Read-only; does not export anything.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max records to return; defaults to 20.' },
      },
    },
  },
];

export const EXPORT_TOOL_NAMES = new Set(EXPORT_TOOL_SCHEMAS.map((t) => t.name));

// Export family agent oriented vocabulary: server's succeeded is read as completed (with the synchronous export submit_export
// The status:'completed' alignment - that's the final state of the exported family wire). The final state "judgment" itself takes the shared job-model
// of isComplete/isFailed/isTerminal (see below), this function is only responsible for the rendering of the family wire.
function mapStatus(status: string): string {
  return status === 'succeeded' ? 'completed' : status;
}

/** backend /export/job/:id Fields in the snapshot that the tool cares about (others are ignored). */
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
interface SessionJob { renderId: string; timelineId?: string }
// push order = submission order → newest is the LAST entry (no clock needed).
const sessionJobs: SessionJob[] = [];

/** Test seam: reset the session job registry. */
export function __resetExportSessionJobs(): void {
  sessionJobs.length = 0;
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

/** GET /export/job/:id Once, map the snapshot into tool results; transfer/unknown renderId all returned clean error, never throw naked exceptions.
 *  Exported for register_converted_video (mg-video-tools): resolve a finished render's downloadUrl by renderId. */
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
    const body: Record<string, unknown> = { state: ctx.getState(), format };
    if (typeof args.resolution === 'string') body.resolution = args.resolution;
    if (typeof args.fps === 'number') body.fps = args.fps;
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
    let timelineId: string | undefined;
    try { timelineId = ctx.getDoc().activeTimelineId; } catch { timelineId = undefined; }
    sessionJobs.push({ renderId: data.renderId, timelineId });
    return { ok: true, renderId: data.renderId, format, next: `Call track_export with renderIds=${data.renderId} and action=status or action=wait.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** comma separated id/prefix → complete renderId list. Prefix parses the session submission record; unknown
 *  token Pass it transparently to the server as it is (it may be a complete file obtained elsewhere) id). Ambiguous prefixes report clarity errors. */
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

/** renderIds when omitted latest Semantics:newest matching job；onlyActive Only stay in progress;
 *  latest=false List all recent job. Submit records based on this session + Real-time polling status. */
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

/** a group job each poll Once. */
async function pollAll(ids: string[]): Promise<PollResult[]> {
  const results = await Promise.all(ids.map((id) => pollOnce(id)));
  for (const r of results) recordIfCompleted(r);
  return results;
}

/** Single job Keep the old flat return; more job Return { ok, count, jobs } aggregation. */
function presentJobs(results: PollResult[], note?: string): unknown {
  if (results.length === 1 && !note) return results[0];
  return { ok: true, count: results.length, jobs: results, ...(note ? { note } : {}) };
}

async function trackExport(args: Args): Promise<unknown> {
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

    if (action === 'status') return presentJobs(await pollAll(ids), note);

    // action=wait: Poll until all selected jobs are finalized, or timeoutSeconds expires (default 90, 0=unbounded).
    const requested = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds) ? args.timeoutSeconds : DEFAULT_WAIT_SECONDS;
    const bounded = Math.min(Math.max(requested, 0), MAX_WAIT_SECONDS);
    const deadline = bounded === 0 ? Infinity : Date.now() + bounded * 1000;
    for (;;) {
      const results = await pollAll(ids);
      const allSettled = results.every((r) => !('ok' in r) || isTerminal(r.status));
      if (allSettled || Date.now() >= deadline) return presentJobs(results, note);
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Execute an asynchronous rendering tool. Return JSON Serializable results and never throw naked exceptions. */
export async function execExportTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  switch (name) {
    case 'submit_render_job':
      return submitRenderJob(args, ctx);
    case 'track_export':
      return trackExport(args);
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
