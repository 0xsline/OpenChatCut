import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import {
  captionLayoutQaIssues,
  exportQaExpectations,
  mergeExportQaIssues,
  timelineCutTimesSeconds,
  type ExportQaExpectations,
  type ExportQaReport,
} from '../../export/quality';
import { fetchRenderJob } from './export-tools';

type Args = Record<string, unknown>;

interface ExportQaResponse {
  ok?: boolean;
  error?: string;
  src?: string;
  report?: ExportQaReport;
  evidence?: {
    mediaType?: string;
    base64?: string;
    samples?: { cutSeconds: number; sampleSeconds: number; side: 'before' | 'after' }[];
  };
}

export const EXPORT_QA_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'verify_export',
    description: [
      'Quality-check a COMPLETED video export before delivery.',
      'Pass renderId from submit_render_job/track_export, or a /media/uploads/ export src.',
      'Checks stream presence, duration, resolution, frame rate, black/frozen frames, long silence, and audio peaks.',
      'Returns a structured issue list plus a labeled before/after contact sheet around timeline edit points.',
      'Run after every important export; inspect warnings and fix the timeline before re-exporting when needed.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        renderId: { type: 'string', description: 'Completed render job ID returned by submit_render_job.' },
        src: { type: 'string', description: 'Alternative completed export path under /media/uploads/.' },
        maxCuts: { type: 'integer', minimum: 1, maximum: 8, description: 'Maximum edit boundaries to include in the evidence sheet; defaults to 8.' },
      },
    },
  },
];

export const EXPORT_QA_TOOL_NAMES = new Set(EXPORT_QA_TOOL_SCHEMAS.map((tool) => tool.name));

interface ResolvedExport {
  src: string;
  expected?: Partial<Pick<ExportQaExpectations, 'durationSeconds' | 'width' | 'height' | 'fps'>>;
  sourceStartSeconds?: number;
}

async function resolveExportSrc(args: Args): Promise<ResolvedExport | { error: string }> {
  const direct = typeof args.src === 'string' ? args.src.trim() : '';
  if (direct) return direct.startsWith('/media/uploads/')
    ? { src: direct }
    : { error: 'src must be a completed export under /media/uploads/' };

  const renderId = typeof args.renderId === 'string' ? args.renderId.trim() : '';
  if (!renderId) return { error: 'renderId or src is required' };
  const job = await fetchRenderJob(renderId);
  if (!('ok' in job)) return job;
  if (job.status !== 'completed') {
    return { error: `render job ${job.renderId} is ${job.status}; wait for completion before QA` };
  }
  if (!job.downloadUrl) return { error: `render job ${job.renderId} has no output path` };
  return {
    src: job.downloadUrl,
    expected: {
      ...(job.durationSeconds !== undefined ? { durationSeconds: job.durationSeconds } : {}),
      ...(job.width !== undefined ? { width: job.width } : {}),
      ...(job.height !== undefined ? { height: job.height } : {}),
      ...(job.fps !== undefined ? { fps: job.fps } : {}),
    },
    sourceStartSeconds: job.sourceStartSeconds,
  };
}

async function verifyExport(args: Args, ctx: AgentContext): Promise<unknown> {
  try {
    const resolved = await resolveExportSrc(args);
    if ('error' in resolved) return resolved;

    const state = ctx.getState();
    const expected = { ...exportQaExpectations(state), ...resolved.expected };
    const maxCuts = Math.max(1, Math.min(8, Math.round(Number(args.maxCuts) || 8)));
    const sourceStartSeconds = resolved.sourceStartSeconds ?? 0;
    const cutTimesSeconds = timelineCutTimesSeconds(state, 24)
      .map((seconds) => Number((seconds - sourceStartSeconds).toFixed(4)))
      .filter((seconds) => seconds > 0 && seconds < expected.durationSeconds)
      .slice(0, maxCuts);
    const response = await fetch('/api/export-qa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        src: resolved.src,
        ...expected,
        cutTimesSeconds,
        maxEvidenceCuts: maxCuts,
      }),
    });
    const result = (await response.json().catch(() => null)) as ExportQaResponse | null;
    if (!response.ok || !result?.report) {
      return { error: result?.error ?? `export QA failed (${response.status})` };
    }

    const report = mergeExportQaIssues(result.report, captionLayoutQaIssues(state));
    const evidence = result.evidence;
    return {
      ok: report.ok,
      src: resolved.src,
      report,
      cutCount: cutTimesSeconds.length,
      evidenceSamples: evidence?.samples ?? [],
      ...(evidence?.base64 ? { __images: [{ frame: 0, base64: evidence.base64 }] } : {}),
      note: evidence?.base64
        ? 'Cut evidence is a two-column sheet: each row shows the frame immediately before and after one edit boundary.'
        : 'No adjacent edit boundaries were available for visual evidence; stream-level QA still completed.',
      next: report.ok && report.summary.warnings === 0
        ? 'Export passed automated QA.'
        : 'Inspect every issue and evidence row. Fix confirmed problems, export again, and rerun verify_export. Stop after three attempts and report any remaining issue to the user.',
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function execExportQaTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'verify_export') return verifyExport(args, ctx);
  return { error: `export QA tool not implemented: ${name}` };
}
