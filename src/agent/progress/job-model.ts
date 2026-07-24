// Unified asynchronous Job model (Plan A3).
// ---------------------------------------------------------------------------
// The backend is a job table (generation_job/analysis_job), the field status/result is a set of state machines,
// Exposed to agent:track_progress(generation/transcription/upload/ via two "isomorphic" polling tools
// visual-analysis) and track_export(render).
//
// This warehouse split this set of jobs into three "families", which fall into different execution localities (locality) and have their own wire status vocabulary:
//   generation family wire: queued | running | succeeded | failed | not_found (server library, jobId)
//   export family wire: queued | running | completed | failed (server library, renderId)
//   transcription store: running | done | failed (in-browser Map, assetId)
// These wire strings are fixed protocol values for each task family and remain unchanged:
//   · Synchronous submit_export(generate-tools.ts, grok frozen) returns status:'completed' → The final state word of the export family is completed;
//   · The final word of the generated family is succeeded; the two families are originally track_progress vs track_export, and the vocabulary can be different.
//
// This module is the shared semantic layer underneath them: a set of canonical life cycles + a terminal authority,
// Let there be no polling loop anywhere and then use handwritten string comparison to determine "whether this job is finished" (that is missing not_found
// such a hotbed of bugs). Pure modules (no DOM/network), app / tsx check can be safely imported.
//
// upload/visual-analysis has an independent client table (track-progress-targets + visual-analysis-jobs),
// The JobKind enumeration is not incorporated into this module (the wire field is different from generation), but normalizeStatus is still reused.

/** Canonical, not related to the family job life cycle.**Deliberately**Different from any family wire string
 *  (queued/succeeded/completed/done)—— Passed normalizeStatus This level is reached only after normalization. */
export type JobStatus = 'pending' | 'running' | 'complete' | 'failed' | 'not_found';

/** realized job family(track_progress target subset of + render family)。 */
export type JobKind = 'generation' | 'transcription' | 'export' | 'upload' | 'visual-analysis';

/** Polling must stop the status(job won't change again)。not_found It's the final state:Unable to find job will never appear,
 *  There's no point in waiting. */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(['complete', 'failed', 'not_found']);

/** families wire Vocabulary → canonical mapping table(Case/white space insensitive,see normalizeStatus)。 */
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

/** put any family wire status normalized to canonical life cycle. Unknown string press 'running'(non-final state)Process,
 *  Such an unknown value will continue to poll,Instead of misjudging the final state to end early. */
export function normalizeStatus(raw: string): JobStatus {
  return WIRE_TO_CANONICAL[raw.trim().toLowerCase()] ?? 'running';
}

/** job Has it reached the final state of no longer changing?(complete/failed/not_found)。 */
export function isTerminal(raw: string): boolean {
  return TERMINAL_STATUSES.has(normalizeStatus(raw));
}

/** only"Completed successfully"is true(failed/not_found All are false)。 */
export function isComplete(raw: string): boolean {
  return normalizeStatus(raw) === 'complete';
}

/** only"failed"is true. */
export function isFailed(raw: string): boolean {
  return normalizeStatus(raw) === 'failed';
}

/** Tools for each family job Reports are all satisfied by a shared skeleton.job Handle field name
 *  track_progress schema is family specific(generate jobId, export renderId, transliteration assetId),
 *  So handle**No**Enter base class,Only lifecycle fields are shared.S = of the family wire State union type. */
export interface JobReportBase<S extends string = string> {
  status: S;
  progress?: number;
  error?: string;
}
