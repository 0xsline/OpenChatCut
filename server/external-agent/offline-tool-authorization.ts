import { policyForTool } from '../../src/agent/execution-policy.ts';
import {
  isExternalServerDirectCall,
  isExternalServerDirectTool,
} from '../../src/agent/external-tool-policy.ts';
import { ExternalEditorCallError } from './broker.ts';

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
  if (policy.effect !== 'read' && policy.effect !== 'reversible_edit') {
    throw new ExternalEditorCallError(
      'rejected',
      `Tool ${name} is not permitted by the offline execution policy.`,
    );
  }
}
