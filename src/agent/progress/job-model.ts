// Unify the asynchronous Job model (Plan A3).
// --------------------------------------------------------------------------------
// The backend is a job table (generation_job/analysis_job), the field status/result is a set of state machines,
// Exposed to agent:track_progress(generation/transcription/upload/ via two "isomorphic" polling tools
// visual-analysis) and track_export(render).
//
// This codebase splits this set of jobs into three "families", which fall into different execution locations (locality) and have their own wire status vocabulary:
// generation family wire: queued | running | succeeded | failed | not_found (server library, jobId)
// export family wire: queued | running | completed | failed (server library, renderId)
// transcription store: running | done | failed (Map in browser, assetId)
// These wire strings are fixed protocol values for each task family and remain unchanged:
// · Synchronous submit_export(generate-tools.ts, grok frozen) returns status:'completed' → The final state word of the export family is completed;
// · The final word of the generated family is succeeded; the two families are originally track_progress vs track_export, and the vocabulary can be different.
//
// This module is the shared semantic layer underneath them: a set of canonical life cycles + a terminal authority,
// Let there be no polling loop anywhere and then compare handwritten strings to determine "whether this job is finished" (that is missing not_found
// bug breeding ground). Pure modules (no DOM/network), app / tsx check can be safely imported.
//
// upload / visual-analysis has an independent client table (track-progress-targets + visual-analysis-jobs),
// The JobKind enumeration of this module is not incorporated (the wire field is different from generation), but normalizeStatus is still reused.

/** Canonical, family-independent job life cycle. **Deliberately** distinguished from any family of wire strings
 * (queued/succeeded/completed/done) — This layer is reached after normalization through normalizeStatus. */
export type JobStatus = 'pending' | 'running' | 'complete' | 'failed' | 'not_found';

/** Implemented job family (subset of track_progress target + rendering family). */
export type JobKind = 'generation' | 'transcription' | 'export' | 'upload' | 'visual-analysis';

/** The state in which polling must stop (the job will not change again). not_found is the final state: the job that cannot be found will never appear.
 * There is no point in continuing to wait. */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(['complete', 'failed', 'not_found']);

/** Mapping table of each family's wire vocabulary → canonical (case/blank insensitive, see normalizeStatus). */
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

/** Normalize any family wire state to the canonical life cycle. Unknown strings are treated as 'running' (non-final state),
 * Such an unknown value will continue to be polled, instead of being misjudged as a final state and ending early. */
export function normalizeStatus(raw: string): JobStatus {
  return WIRE_TO_CANONICAL[raw.trim().toLowerCase()] ?? 'running';
}

/** Whether the job has reached the final state that will no longer change (complete/failed/not_found). */
export function isTerminal(raw: string): boolean {
  return TERMINAL_STATUSES.has(normalizeStatus(raw));
}

/** Only "successfully completed" is true (failed/not_found are both false). */
export function isComplete(raw: string): boolean {
  return normalizeStatus(raw) === 'complete';
}

/** Only true for "failed". */
export function isFailed(raw: string): boolean {
  return normalizeStatus(raw) === 'failed';
}

/** A shared skeleton that each family of tools satisfies for job reporting. Job handle field name press
 * track_progress schema is family-specific (generate jobId, export renderId, convert assetId),
 * Therefore, the handle ** does not ** enter the base class, and only shares the life cycle field. S = the wire state union type of this family. */
export interface JobReportBase<S extends string = string> {
  status: S;
  progress?: number;
  error?: string;
}
