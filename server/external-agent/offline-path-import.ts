// Server-side execution for the local-path media tools (import_asset /
// import_assets / import_folder) in headless sessions.
//
// The desktop app ships the importer over IPC from its main process; the offline
// MCP session and the occ CLI run the very same core in-process
// (server/local-path-import.ts). Both hosts therefore share one validation, one
// fingerprint/probe chain and one pool-landing implementation
// (importLocalPaths in src/agent/tools/agent-path-import-tools.ts) — this file
// only supplies the host's importer.
import type { AgentContext } from '../../src/agent/context.js';
import { importLocalPaths } from '../../src/agent/tools/agent-path-import-tools.js';
import { importAgentPaths } from '../local-path-import.js';

const PATH_IMPORT_TOOL_NAMES: Record<string, true> = {
  import_asset: true,
  import_assets: true,
  import_folder: true,
};

export async function executeOfflinePathImport(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<unknown> {
  if (PATH_IMPORT_TOOL_NAMES[name] !== true) return { error: `unknown tool ${name}` };
  return importLocalPaths(name, args, ctx, { importAgentPaths });
}
