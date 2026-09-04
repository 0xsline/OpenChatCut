import type { McpToolExposureMode } from './mcp-tool-exposure.ts';

export function mcpServerInstructions(
  skillBaseline: string,
  exposureMode: McpToolExposureMode,
): string {
  return [
    `OpenChatCut external skill baseline: ${skillBaseline}. Update with npx skills update openchatcut when the installed skill is older.`,
    'Bind this MCP transport with target_project before editing. A connected browser is preferred; an existing stored project can use the offline fallback when no browser owns it.',
    'The target response and openchatcut_status report bindingMode. Offline bindings expose only server-direct data tools and require approvalMode="auto".',
    exposureMode === 'progressive'
      ? 'This client negotiated progressive tool exposure. Call ToolSearch for list_edit_sessions and recover_edit_session before browser session recovery; tools/list_changed is sent when the visible set grows.'
      : 'This client uses the compatibility tool surface. All currently available tools are listed.',
    'Call begin_edit_session first, pass editSessionId to every editor tool, then call review_edit_session. Do not claim success until status is applied.',
    'Manual approval and visual/canvas inspection, generation, upload, network, preset, render, and export tools require opening the returned editorUrl.',
    'Offline review atomically commits the complete draft. A browser takeover or stored-project change makes the session stale with no partial edit.',
    'If the original MCP owner disconnects, call list_edit_sessions and recover_edit_session. Terminal stale, cancelled, or failed sessions cannot be reused; start a new edit session.',
  ].join(' ');
}
