// Server-side execution for export_jianying_draft in headless sessions.
//
// The browser tool POSTs the same request to /api/external-agent/jianying-export;
// a headless host calls the exporter in-process. Request building and response
// shaping live in the tool module (jianyingExportBody / jianyingExportOutcome), so
// both hosts produce identical results — this file only supplies the transport.
import type { AgentContext } from '../../src/agent/context.js';
import {
  jianyingExportBody,
  jianyingExportOutcome,
  type JianyingExportResponse,
} from '../../src/agent/tools/jianying-export-tool.js';
import { exportJianyingDraft } from './jianying-export.js';

export async function executeOfflineJianyingExport(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'export_jianying_draft') return { error: `unknown tool ${name}` };
  const result = await exportJianyingDraft(jianyingExportBody(args, ctx));
  return jianyingExportOutcome(result as JianyingExportResponse, result.ok ? 200 : 400);
}
