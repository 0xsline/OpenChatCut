import type { AgentContext } from '../../src/agent/context.js';
import { execAgentRuntimeTool } from '../../src/agent/tools/agent-runtime-tools.js';
import { execCaptionsTool } from '../../src/agent/tools/captions-tools.js';
import { CORE_DATA_TOOL_NAMES, execCoreDataTool } from '../../src/agent/tools/core-data-tools.js';
import { execMarkersTool } from '../../src/agent/tools/markers-tools.js';
import { execReadProjectTool } from '../../src/agent/tools/read-project-tools.js';
import { execScriptTool } from '../../src/agent/tools/script-tools.js';
import { execFindTranscript } from '../../src/agent/tools/transcript-find.js';
import { execReadTranscript } from '../../src/agent/tools/transcript-read.js';
import { execTimelineTool } from '../../src/agent/tools/timeline-tools.js';
import { execTrackTool } from '../../src/agent/tools/track-tools.js';
import { execWatermarkTool } from '../../src/agent/tools/watermark-tools.js';
import { execTimelineImportTool } from '../../src/agent/tools/timeline-import-tools.js';

type Args = Record<string, unknown>;

/**
 * edit_item and manage_effects validate against the GL catalogs, which import
 * shader sources with Vite's `?raw` suffix. Hosts that can resolve that — vite
 * dev, the desktop bundle (scripts/esbuild-raw-plugin.mjs) and the CLI
 * (cli/raw-hooks.mjs) — run them; a bare tsx host cannot load the module at all,
 * so the import stays lazy and only a real call pays for it. Same pattern as
 * src/agent/tools/shader-tools.ts.
 */
async function executeGlBackedTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'edit_item') {
    const { execEditItemTool } = await import('../../src/agent/tools/edit-item-tools.js');
    return execEditItemTool(name, args, ctx);
  }
  const { execEffectTool } = await import('../../src/agent/tools/effect-tools.js');
  return execEffectTool(name, args, ctx);
}

/**
 * Execute only the dependency-closed tools reviewed for server-side EditorCore use.
 * This separate dispatch keeps GL, media, network, IndexedDB, generation, and
 * render modules out of the desktop server bundle.
 */
export async function executeOfflineTool(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  if (name === 'edit_item' || name === 'manage_effects') return executeGlBackedTool(name, args, ctx);
  if (name === 'read_agent_artifact') return execAgentRuntimeTool(name, args, ctx);
  if (CORE_DATA_TOOL_NAMES.has(name)) return execCoreDataTool(name, args, ctx);
  if (name === 'manage_timelines') return execTimelineTool(name, args, ctx);
  if (name === 'edit_track') return execTrackTool(name, args, ctx);
  if (name === 'read_script' || name === 'apply_script') return execScriptTool(name, args, ctx);
  if (name === 'read_captions' || name === 'edit_captions') return execCaptionsTool(name, args, ctx);
  if (name === 'update_watermark') return execWatermarkTool(name, args, ctx);
  if (name === 'manage_markers') return execMarkersTool(name, args, ctx);
  if (name === 'read_project') return execReadProjectTool(name, args, ctx);
  if (name === 'read_transcript') return execReadTranscript(args, ctx);
  if (name === 'find_transcript') return execFindTranscript(args, ctx);
  if (name === 'import_timeline') return execTimelineImportTool(name, args, ctx);
  return { error: `offline tool ${name} is not implemented` };
}
