/**
 * Tool execution policy: which tools may run concurrently.
 *
 * `exclusive` (default) tools serialize against everything else — they touch
 * ProjectDoc, media pool, approvals, or other browser-side mutable state.
 * `parallel` tools are pure reads (state queries, searches, analysis probes)
 * and may overlap with each other, though the browser still executes them in
 * arrival order behind any exclusive tool.
 *
 * Never add a tool here without confirming its browser-side execution only
 * reads: a parallel tool that mutates would race the exclusive chain.
 */
export type ToolExecutionMode = 'exclusive' | 'parallel';

export const PARALLEL_TOOL_NAMES: ReadonlySet<string> = new Set([
  // timeline / project state
  'read_timeline',
  'read_project',
  'list_projects',
  'get_editor_url',
  // library / templates
  'list_templates',
  'search_templates',
  // media analysis
  'probe_media',
  'search_media',
  // transcript / captions / script reads
  'read_transcript',
  'find_transcript',
  'read_script',
  'read_captions',
  // audio / color / music inspection
  // NOTE: detect_beats is NOT here — it writes markers when `markers` is set.
  // It is classified per-invocation by toolExecutionMode(name, args).
  'inspect_color',
  'inspect_music',
  // search surfaces
  'search_content',
  'search_fonts',
  'web_search',
  'ToolSearch',
  // artifacts / history
  'read_agent_artifact',
  'read_export_history',
  'verify_export',
]);

/** Tools that only read for SOME argument shapes. Returning true means this
 * invocation touches no editor state and may run in parallel. */
const CONDITIONALLY_PARALLEL: Readonly<Record<string, (args?: Readonly<Record<string, unknown>>) => boolean>> = {
  // Writes beat markers through ctx.commands only when `markers` is requested;
  // analysis-only calls stay parallel so a slow decode does not block the chain.
  detect_beats: (args) => args?.markers !== 'beats' && args?.markers !== 'downbeats',
};

export function toolExecutionMode(
  name: string,
  args?: Readonly<Record<string, unknown>>,
): ToolExecutionMode {
  if (PARALLEL_TOOL_NAMES.has(name)) return 'parallel';
  return CONDITIONALLY_PARALLEL[name]?.(args) ? 'parallel' : 'exclusive';
}
