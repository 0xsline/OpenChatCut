// 统一异步 Job 模型(计划 A3)。
// ---------------------------------------------------------------------------
// 后端是一张 job 表(generation_job/analysis_job),字段 status/result 一套状态机,
// 通过两个"同构"轮询工具暴露给 agent:track_progress(generation/transcription/upload/
// visual-analysis)与 track_export(render)。
//
// 本仓把这套 job 拆成三个"家族",落在不同的执行地(locality),各自的 wire 状态词汇:
//   generation 家族 wire:  queued | running | succeeded | failed | not_found   (server 库, jobId)
//   export     家族 wire:  queued | running | completed | failed               (server 库, renderId)
//   transcription store:   running | done    | failed                          (浏览器内 Map, assetId)
// 这些 wire 字符串是各任务家族的固定协议值，保持原样不改:
//   · 同步 submit_export(generate-tools.ts,grok 冻结)返 status:'completed' → 导出族终态词就是 completed;
//   · 生成族终态词是 succeeded;两个家族本就是 track_progress vs track_export 两条线,词汇可不同。
//
// 本模块是它们**之下**的共享语义层:一套 canonical 生命周期 + 一个 terminal 权威,
// 让没有任何一处轮询循环再用手写字符串比较去判断"这个 job 完了没"(那是漏 not_found
// 之类的 bug 温床)。纯模块(无 DOM/网络),app / tsx check 都能安全 import。
//
// upload / visual-analysis 有独立 client 表(track-progress-targets + visual-analysis-jobs),
// 不并入本模块的 JobKind 枚举(wire 字段与 generation 不同),但 normalizeStatus 仍复用。

/** Canonical、与家族无关的 job 生命周期。**刻意**区别于任何家族的 wire 字符串
 *  (queued/succeeded/completed/done)—— 通过 normalizeStatus 归一化后才到这一层。 */
export type JobStatus = 'pending' | 'running' | 'complete' | 'failed' | 'not_found';

/** 已实现的 job 家族(track_progress target 的子集 + 渲染族)。 */
export type JobKind = 'generation' | 'transcription' | 'export' | 'upload' | 'visual-analysis';

/** 轮询必须停下的状态(job 不会再变)。not_found 是终态:查不到的 job 永远不会出现,
 *  继续等毫无意义。 */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(['complete', 'failed', 'not_found']);

/** 各家族 wire 词汇 → canonical 的映射表(大小写/空白不敏感,见 normalizeStatus)。 */
const WIRE_TO_CANONICAL: Readonly<Record<string, JobStatus>> = {
  pending: 'pending',
  queued: 'pending',
  running: 'running',
  processing: 'running',
  complete: 'complete',
  completed: 'complete',
  succeeded: 'complete',
  success: 'complete',
  done: 'complete',
  failed: 'failed',
  error: 'failed',
  not_found: 'not_found',
  missing: 'not_found',
};

/** 把任意家族 wire 状态归一到 canonical 生命周期。未知字符串按 'running'(非终态)处理,
 *  这样一个不认识的值会继续轮询,而不是误判为终态提前结束。 */
export function normalizeStatus(raw: string): JobStatus {
  return WIRE_TO_CANONICAL[raw.trim().toLowerCase()] ?? 'running';
}

/** job 是否已到不再变化的终态(complete/failed/not_found)。 */
export function isTerminal(raw: string): boolean {
  return TERMINAL_STATUSES.has(normalizeStatus(raw));
}

/** 仅"成功完成"为真(failed/not_found 均为假)。 */
export function isComplete(raw: string): boolean {
  return normalizeStatus(raw) === 'complete';
}

/** 仅"失败"为真。 */
export function isFailed(raw: string): boolean {
  return normalizeStatus(raw) === 'failed';
}

/** 每个家族的工具面向 job 报告都满足的共享骨架。job 句柄字段名按
 *  track_progress schema 是家族特定的(生成 jobId、导出 renderId、转写 assetId),
 *  故句柄**不**进基类,只共享生命周期字段。S = 该家族的 wire 状态联合类型。 */
export interface JobReportBase<S extends string = string> {
  status: S;
  progress?: number;
  error?: string;
}
