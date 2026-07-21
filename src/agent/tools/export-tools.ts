import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { recordExport, listExportHistory } from '../../persist/exportHistoryStore';
import { isTerminal, isComplete, isFailed, type JobReportBase } from '../progress/job-model';

// ═══════════════════════════════════════════════════════════════════════════
// 异步渲染 job 工具
// ---------------------------------------------------------------------------
// 异步导出的标准名是 submit_export(format=video/audio → 返回 renderId)。
// 但 `submit_export` 已被同步版工具占用(generate-tools.ts)，为避免同名冲突，异步
// 渲染提交器取名 submit_render_job。轮询用 track_export。
// track_export 参数面：required=['action']；renderIds(逗号分隔 id/前缀)、
// latest(renderIds 省略时默认 true)、onlyActive、timelineId、timeoutSeconds(默认 90，0=无界)。
// 旧单数 renderId 仍作兼容别名。latest/前缀解析基于本会话的提交记录(见 sessionJobs)。
//
// Agent 跑在浏览器里，工具用 fetch 打 dev-server 的 /export/job 端点：
//   POST /export/job     → { renderId }
//   GET  /export/job/:id → { id, status, progress, result?, error? }
// 完成后 result.path 指向 /media/uploads/ 下的临时导出文件，即工具返回的 downloadUrl。
//
// 接线（集成方在 tools.ts 做，本文件不碰 tools.ts）：
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

// 导出族 agent 面向词汇:server 的 succeeded 读作 completed（与同步导出 submit_export
// 的 status:'completed' 对齐——那是导出家族的终态 wire）。终态"判定"本身走共享 job-model
// 的 isComplete/isFailed/isTerminal(见下),此函数只负责家族 wire 的呈现。
function mapStatus(status: string): string {
  return status === 'succeeded' ? 'completed' : status;
}

/** 后端 /export/job/:id 快照里工具关心的字段（其余忽略）。 */
interface JobSnapshot extends JobReportBase<'queued' | 'running' | 'succeeded' | 'failed'> {
  id: string;
  progress: number;
  result?: { path?: string; name?: string; sizeBytes?: number; codec?: string };
}

export type PollResult =
  | { ok: true; renderId: string; status: string; progress: number; downloadUrl?: string; name?: string; sizeBytes?: number; codec?: string; error?: string }
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

/** GET /export/job/:id 一次，把快照映射成工具结果；传输/未知 renderId 都返回干净 error，绝不抛裸异常。
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
    ...(completed && result?.path ? { downloadUrl: result.path, name: result.name, sizeBytes: result.sizeBytes, codec: result.codec } : {}),
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

/** 逗号分隔的 id/前缀 → 完整 renderId 列表。前缀对本会话提交记录解析；不认识的
 *  token 原样透传给服务器（可能是别处拿到的完整 id）。歧义前缀报清晰错误。 */
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

/** renderIds 省略时的 latest 语义：newest matching job；onlyActive 只留进行中；
 *  latest=false 列出全部近期 job。基于本会话提交记录 + 实时轮询状态。 */
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

/** 一组 job 各 poll 一次。 */
async function pollAll(ids: string[]): Promise<PollResult[]> {
  const results = await Promise.all(ids.map((id) => pollOnce(id)));
  for (const r of results) recordIfCompleted(r);
  return results;
}

/** 单 job 保持旧扁平返回；多 job 返回 { ok, count, jobs } 聚合。 */
function presentJobs(results: PollResult[], note?: string): unknown {
  if (results.length === 1 && !note) return results[0];
  return { ok: true, count: results.length, jobs: results, ...(note ? { note } : {}) };
}

async function trackExport(args: Args): Promise<unknown> {
  try {
    const action = args.action === 'wait' ? 'wait' : args.action === 'status' ? 'status' : null;
    if (!action) return { error: 'action is required: "status" or "wait"' };

    // renderIds（逗号分隔）优先；旧单数 renderId 仍兼容；都缺 → latest 语义。
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

    // action=wait：轮询直到所选 job 全部终态，或 timeoutSeconds 到期（默认 90，0=无界）。
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

/** 执行一个异步渲染工具。返回 JSON 可序列化结果，绝不抛裸异常。 */
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
