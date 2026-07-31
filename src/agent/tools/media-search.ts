import type { AgentContext } from '../context';
import { SemanticClient } from '../../media/semantic-search/semanticClient';
import { loadWithFallback } from '../../media/semantic-search/semanticOperations';
import { rankSemanticMatches } from '../../media/semantic-search/vectorSearch';
import { readSemanticVectors } from '../../media/semantic-search/vectorStore';
import {
  buildMediaSearchResult,
  spokenMediaSearchHits,
  visualMediaSearchHits,
} from '../../media/searchMedia';
import type { VisualMediaSearchHit } from '../../media/searchMedia';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision';
import { MAX_SEMANTIC_QUERY_LENGTH } from '../../media/semantic-search/types';

interface SearchMediaArgs {
  query?: unknown;
  modalities?: unknown;
  limit?: unknown;
}

export async function execSearchMedia(args: SearchMediaArgs, ctx: AgentContext): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  if (!query) return { error: 'search_media requires query' };
  if (query.length > MAX_SEMANTIC_QUERY_LENGTH) {
    return { error: `search_media query exceeds ${MAX_SEMANTIC_QUERY_LENGTH} characters` };
  }
  const requested = Array.isArray(args.modalities)
    ? new Set(args.modalities.map(String))
    : new Set(['visual', 'spoken']);
  const invalid = [...requested].filter((value) => value !== 'visual' && value !== 'spoken');
  if (invalid.length) return { error: `unsupported modalities: ${invalid.join(', ')}` };
  const limit = Number.isFinite(Number(args.limit))
    ? Math.max(1, Math.min(50, Math.round(Number(args.limit))))
    : 12;
  const assets = ctx.getDoc().assets ?? [];
  const spoken = requested.has('spoken') ? spokenMediaSearchHits(query, assets, limit) : [];
  let visual: VisualMediaSearchHit[] = [];
  let visualWarning: string | undefined;

  if (requested.has('visual')) {
    const scopeId = ctx.getProjectId?.() ?? ctx.getDoc().activeTimelineId;
    const revisions = new Map(assets.map((asset) => [asset.id, sourceRevisionOf(asset)]));
    const records = (await readSemanticVectors(scopeId)).filter((record) => (
      record.sourceRevision === revisions.get(record.assetId)
    ));
    if (records.length) {
      const client = new SemanticClient();
      const controller = new AbortController();
      try {
        const preferred = typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm';
        await loadWithFallback(client, preferred, controller.signal, (device) => client.load(device));
        const vector = await client.embedText(query);
        visual = visualMediaSearchHits(rankSemanticMatches(records, vector, limit), assets);
      } catch (error) {
        visualWarning = error instanceof Error ? error.message : String(error);
      } finally {
        client.dispose();
      }
    }
  }

  const result = buildMediaSearchResult(query, visual.slice(0, limit), spoken.slice(0, limit), assets);
  return {
    ...result,
    ...(visualWarning ? { visualWarning } : {}),
    ...(requested.has('visual') && visual.length === 0 && !visualWarning
      ? { visualNote: 'No fresh ChineseCLIP index is available; index visual media first.' }
      : {}),
  };
}
