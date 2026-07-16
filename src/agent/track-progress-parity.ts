// track_progress source-parity layer. generate-tools.ts (grok's lane) owns
// target=generation; this module — wired in tools.ts without editing that file —
// completes the SOURCE target surface (mcp-tools-schema.json): transcription is
// handled by transcription-progress.ts, and here upload (synchronous locally) and
// visual-analysis (not modeled) answer structurally instead of erroring. Source
// schema requires only `action`; target defaults to generation.
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';

type Args = Record<string, unknown>;

/** Immutably extend grok's track_progress schema to the full source target enum. */
export function withSourceTargets(schemas: Anthropic.Tool[]): Anthropic.Tool[] {
  return schemas.map((tool) => {
    if (tool.name !== 'track_progress') return tool;
    const properties = (tool.input_schema.properties ?? {}) as Record<string, unknown>;
    return {
      ...tool,
      description: `${tool.description} For target=transcription, poll ingest ASR readiness (上传即转写) by assetIds instead of jobIds; a succeeded asset then carries a word-level transcript that clips inherit. target=upload and target=visual-analysis are accepted for source parity: local uploads complete synchronously, and visual-analysis jobs are not modeled in this build.`,
      input_schema: {
        ...tool.input_schema,
        properties: {
          ...properties,
          target: { type: 'string', enum: ['generation', 'transcription', 'upload', 'visual-analysis'], description: 'Which async task kind to inspect: generation (default), transcription, upload, or visual-analysis.' },
          assetIds: { type: 'string', description: 'Comma-separated asset IDs/prefixes, for target=transcription / upload / visual-analysis.' },
        },
        required: ['action'],
      },
    };
  });
}

/** target=upload — uploads are synchronous in this local build; report per-asset presence. */
export function execUploadProgress(args: Args, ctx: AgentContext): unknown {
  const assets = ctx.getDoc().assets ?? [];
  const queried = String(args.assetIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const statuses = queried.map((q) => {
    const hit = assets.find((a) => a.id === q) ?? assets.find((a) => a.id.startsWith(q));
    return hit ? { assetId: hit.id, status: 'succeeded' as const } : { assetId: q, status: 'not_found' as const };
  });
  return { ok: true, target: 'upload', note: '本地构建的上传是同步的——素材出现在媒体池即已完成,无异步 upload job 可跟踪。', ...(statuses.length ? { assets: statuses } : {}) };
}

/** target=visual-analysis — not modeled; honest structured answer with the working alternative. */
export function execVisualAnalysisProgress(): unknown {
  return { unsupported: true, target: 'visual-analysis', note: '本构建未建模 visual-analysis 任务;要检视画面请直接用 view_asset_frames / view_timeline_frames。' };
}
