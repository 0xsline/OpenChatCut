import type { AgentContext } from '../context';
import type { AgentToolSchema } from '../tool-schema';
import { jianyingDraftPayload, type JianyingDraftPayload } from '../../export/jianyingDraftRequest';

type Args = Record<string, unknown>;

export const JIANYING_EXPORT_TOOL_NAME = 'export_jianying_draft';

export const jianyingExportToolSchema: AgentToolSchema = {
  name: JIANYING_EXPORT_TOOL_NAME,
  description: 'Export the current timeline as a CapCut/JianYing draft (via capcut-cli). The draft appears in the CapCut/JianYing project list; open it there to review and render. Only call this when the user explicitly confirms the export.',
  input_schema: {
    type: 'object',
    properties: {
      draftName: { type: 'string', description: 'Draft name shown in CapCut/JianYing. Defaults to a timestamped name.' },
      draftsDir: { type: 'string', description: 'Optional draft store directory override (defaults to the CapCut store).' },
    },
    additionalProperties: false,
  },
};

export interface JianyingExportResponse {
  ok?: boolean;
  error?: string;
  draftName?: string;
  draftPath?: string;
  addedVideos?: number;
  addedAudios?: number;
  captions?: number;
  warnings?: string[];
}

export interface JianyingExportBody extends JianyingDraftPayload {
  draftName: string;
  draftsDir: string;
}

/** The exporter request body, built from the draft project (shared by both hosts
 * and, through jianyingDraftPayload, by the export dialog). */
export function jianyingExportBody(args: Args, ctx: AgentContext): JianyingExportBody {
  return {
    draftName: typeof args.draftName === 'string' && args.draftName.trim() ? String(args.draftName).trim().slice(0, 60) : '',
    draftsDir: typeof args.draftsDir === 'string' && args.draftsDir.trim() ? String(args.draftsDir).trim() : '',
    ...jianyingDraftPayload(ctx.getDoc()),
  };
}

/** Shape an exporter response for the tool result — HTTP status or in-process. */
export function jianyingExportOutcome(
  data: JianyingExportResponse | null,
  status: number,
): Record<string, unknown> {
  if (status >= 400 || !data?.ok) {
    throw new Error(data?.error ?? `jianying export failed (${status})`);
  }
  return {
    ok: true,
    draftName: data.draftName,
    draftPath: data.draftPath,
    addedVideos: data.addedVideos,
    addedAudios: data.addedAudios,
    captions: data.captions,
    warnings: data.warnings ?? [],
    note: 'Draft written to the CapCut/JianYing store. Restart CapCut/JianYing if the project list does not refresh.',
  };
}

export async function execJianyingExport(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== JIANYING_EXPORT_TOOL_NAME) return undefined;
  const response = await fetch('/api/external-agent/jianying-export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(jianyingExportBody(args, ctx)),
  });
  const data = (await response.json().catch(() => null)) as JianyingExportResponse | null;
  return jianyingExportOutcome(data, response.status);
}