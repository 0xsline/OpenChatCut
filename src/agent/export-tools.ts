import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';

// ═══════════════════════════════════════════════════════════════════════════
// 异步渲染 job 工具（对标源站 §10）
// ---------------------------------------------------------------------------
// 源站真名：异步导出在源站是 submit_export(format=video/audio → 返回 renderId)。
// 但 `submit_export` 已被同步版工具占用(generate-tools.ts)，为避免同名冲突，异步
// 渲染提交器取名 submit_render_job（源站无据，自定）。轮询用源站真名 track_export。
// track_export 源站参数含 action(含 wait)/renderIds/latest/onlyActive/timeoutSeconds；
// 克隆简化为单 renderId + action(status|wait) + timeoutSeconds（一次一个渲染任务）。
//
// Agent 跑在浏览器里，工具用 fetch 打 dev-server 的 /export/job 端点：
//   POST /export/job     → { renderId }
//   GET  /export/job/:id → { id, status, progress, result?, error? }
// 完成后 result.path = /media/uploads/<uuid>.<ext>，即工具返回的 downloadUrl。
//
// 接线（集成方在 tools.ts 做，本文件不碰 tools.ts）：
//   import { EXPORT_TOOL_SCHEMAS, EXPORT_TOOL_NAMES, execExportTool } from './export-tools';
//   ...EXPORT_TOOL_SCHEMAS  /  if (EXPORT_TOOL_NAMES.has(name)) return execExportTool(name, args, ctx);
// ═══════════════════════════════════════════════════════════════════════════

type Args = Record<string, unknown>;

const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 1800;
const POLL_INTERVAL_MS = 500;

export const EXPORT_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'submit_render_job',
    description:
      'Render the active timeline ASYNCHRONOUSLY as MP4/WebM video or MP3/WAV audio. Returns immediately with a renderId instead of blocking; the render runs in a background job. Poll track_export for status/progress and the download URL. Prefer this over the synchronous submit_export for long timelines. Optional frame boundaries use a half-open [startFrame, endFrameExclusive) range.',
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['video', 'audio'], description: 'Defaults to video.' },
        codec: { type: 'string', enum: ['h264', 'vp8', 'mp3', 'wav'], description: 'Video: h264 (default) or vp8. Audio: mp3 (default) or wav.' },
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
      'Inspect or wait for an asynchronous render job started by submit_render_job. action=status checks once and returns immediately; action=wait polls until the render is completed or failed, or until timeoutSeconds elapses. Returns status, progress, and — when completed — a downloadUrl the browser can fetch.',
    input_schema: {
      type: 'object',
      properties: {
        renderId: { type: 'string', minLength: 1, description: 'The renderId returned by submit_render_job.' },
        action: { type: 'string', enum: ['status', 'wait'], description: 'status checks immediately; wait polls until terminal or timeout.' },
        timeoutSeconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'wait timeout; defaults to 300 seconds.' },
      },
      required: ['renderId', 'action'],
    },
  },
];

export const EXPORT_TOOL_NAMES = new Set(EXPORT_TOOL_SCHEMAS.map((t) => t.name));

/** 源站 job 状态 → 工具面向词汇：succeeded 读作 completed（与同步导出 status:'completed' 对齐）。 */
function mapStatus(status: string): string {
  return status === 'succeeded' ? 'completed' : status;
}

/** 后端 /export/job/:id 快照里工具关心的字段（其余忽略）。 */
interface JobSnapshot {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  result?: { path?: string; name?: string; sizeBytes?: number; codec?: string };
  error?: string;
}

type PollResult =
  | { ok: true; renderId: string; status: string; progress: number; downloadUrl?: string; name?: string; sizeBytes?: number; codec?: string; error?: string }
  | { error: string };

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** GET /export/job/:id 一次，把快照映射成工具结果；传输/未知 renderId 都返回干净 error，绝不抛裸异常。 */
async function pollOnce(renderId: string): Promise<PollResult> {
  const response = await fetch(`/export/job/${encodeURIComponent(renderId)}`, { method: 'GET' });
  if (response.status === 404) return { error: `render job ${renderId} not found` };
  const snapshot = (await response.json().catch(() => null)) as JobSnapshot | { error?: string } | null;
  if (!response.ok || !snapshot || !('status' in snapshot)) {
    const message = snapshot && 'error' in snapshot ? snapshot.error : undefined;
    return { error: message ?? `track_export failed (${response.status})` };
  }
  const completed = snapshot.status === 'succeeded';
  const result = snapshot.result;
  return {
    ok: true,
    renderId: snapshot.id,
    status: mapStatus(snapshot.status),
    progress: snapshot.progress,
    ...(completed && result?.path ? { downloadUrl: result.path, name: result.name, sizeBytes: result.sizeBytes, codec: result.codec } : {}),
    ...(snapshot.status === 'failed' && snapshot.error ? { error: snapshot.error } : {}),
  };
}

async function submitRenderJob(args: Args, ctx: AgentContext): Promise<unknown> {
  try {
    const format = args.format === 'audio' ? 'audio' : 'video';
    const body: Record<string, unknown> = { state: ctx.getState(), format };
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
    return { ok: true, renderId: data.renderId, format, next: `Call track_export with renderId=${data.renderId} and action=status or action=wait.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function trackExport(args: Args): Promise<unknown> {
  try {
    const renderId = String(args.renderId ?? '').trim();
    if (!renderId) return { error: 'renderId is required' };
    const action = args.action === 'wait' ? 'wait' : 'status';

    if (action === 'status') return await pollOnce(renderId);

    const requested = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds) ? args.timeoutSeconds : DEFAULT_WAIT_SECONDS;
    const timeoutSeconds = Math.min(Math.max(requested, 0), MAX_WAIT_SECONDS);
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      const result = await pollOnce(renderId);
      if (!('ok' in result)) return result; // 传输错误/未知 renderId：立即返回
      if (result.status === 'completed' || result.status === 'failed') return result;
      if (Date.now() >= deadline) return result; // 超时：返回最近一次 queued/running 快照
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
    default:
      return { error: `export tool not implemented: ${name}` };
  }
}
