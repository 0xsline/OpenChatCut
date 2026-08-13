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
  'detect_beats',
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

export function toolExecutionMode(name: string): ToolExecutionMode {
  return PARALLEL_TOOL_NAMES.has(name) ? 'parallel' : 'exclusive';
}
