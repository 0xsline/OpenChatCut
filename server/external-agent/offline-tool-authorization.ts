import { policyForTool } from '../../src/agent/execution-policy.ts';
import {
  isExternalServerDirectCall,
  isExternalServerDirectTool,
} from '../../src/agent/external-tool-policy.ts';
import { ExternalEditorCallError } from './broker.ts';

/**
 * Reviewed tools whose execution policy is `persistent_local`: they write into the
 * media library (uploads) and land the resulting asset in the session draft. A
 * draft that is discarded leaves the copied file orphaned on disk — the app's
 * media cleanup pass owns that, exactly as it does for the desktop agent — and the
 * paths a caller may touch are gated by the AGENT_IMPORT_ROOTS keystore key.
 */
const OFFLINE_PERSISTENT_LOCAL_TOOLS: Record<string, true> = {
  import_asset: true,
  import_assets: true,
  import_folder: true,
};

export function assertOfflineToolAllowed(
  name: string,
  args: Record<string, unknown>,
  editorUrl: string,
): void {
  if (!isExternalServerDirectTool(name)) {
    throw new ExternalEditorCallError(
      'rejected',
      `Tool ${name} requires the browser editor. Open ${editorUrl} for visual/canvas inspection, generation, upload, network, preset, render, or export tools.`,
    );
  }
  if (!isExternalServerDirectCall(name, args)) {
    throw new ExternalEditorCallError(
      'rejected',
      `Tool ${name} action ${String(args.action ?? '')} uses browser-backed data. Open ${editorUrl} to run it.`,
    );
  }
  const policy = policyForTool(name);
  if (policy.effect === 'read' || policy.effect === 'reversible_edit') return;
  if (policy.effect === 'persistent_local' && OFFLINE_PERSISTENT_LOCAL_TOOLS[name] === true) return;
  throw new ExternalEditorCallError(
    'rejected',
    `Tool ${name} is not permitted by the offline execution policy.`,
  );
}
