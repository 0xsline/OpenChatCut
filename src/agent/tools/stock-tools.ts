export { STOCK_TOOL_SCHEMAS, STOCK_TOOL_NAMES } from './schemas/stock-tools';
import type { AgentContext } from '../context';
import type { MediaAsset } from '../../editor/types';
import { safeSourceFilename } from '../../media/sourceFilename';
import { fallbackDuration, isHttpUrl, nameFromUrl, probeUrl, sniffKind, type PoolKind } from './stock-url-utils';

// Stock and URL ingest tools:
// - download_media — url | url[] ≤4 → local uploads + media pool
// - push_asset — filePath | filePath[] ≤4 (public http URL)
// - import_url_asset — legacy alias → push_asset
// - search_stock_media — Pexels/Pixabay/Unsplash/Freesound proxy
//
// Local-dev: POST /api/import-url fetches remote bytes into public/media/uploads
// as a local storage adapter. If the proxy is unavailable, it falls back to
// registering the remote URL as asset.src so offline checks still work.

type Args = Record<string, unknown>;


const MAX_BATCH = 4;

// URL sniffing/naming/duration/metadata detection: see ./stock-url-utils.ts (pure function, open the file and keep the 500-line limit)

const newId = (): string =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `a_${Date.now()}`;

/** Map input type strings onto MediaAsset.kind (gif/svg → image). */
function mapTypeToKind(type: string | undefined, url: string): PoolKind | null {
  if (!type) return sniffKind(url);
  switch (type) {
    case 'video':
    case 'audio':
    case 'image':
    case 'motion-graphic':
      return type;
    case 'gif':
    case 'svg':
      return 'image';
    case 'effect':
    case 'transition':
      return null; // not OpenChatCut media-pool assets
    default:
      return sniffKind(url);
  }
}

/** string | string[] → trimmed url list. Junk entries are dropped (back-compat);
 * the ≤4 batch cap is enforced by the callers so over-limit input ERRORS instead
 * of being silently truncated. */
function normalizeUrlList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((u): u is string => typeof u === 'string')
    .map((u) => u.trim())
    .filter(Boolean);
}

interface ImportUrlResponse {
  ok?: boolean;
  path?: string;
  bytes?: number;
  contentType?: string;
  filename?: string;
  error?: string;
}

/** Server-side fetch → /media/uploads; falls back to remote URL on any failure. */
async function materializeUrl(
  url: string,
): Promise<{ src: string; filename?: string; local: boolean; note?: string }> {
  try {
    const res = await fetch('/api/import-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const body = (await res.json().catch(() => ({}))) as ImportUrlResponse;
    if (body.ok && typeof body.path === 'string' && body.path.startsWith('/media/')) {
      return { src: body.path, filename: body.filename, local: true };
    }
    const err = body.error ?? `import-url status ${res.status}`;
    return { src: url, local: false, note: `remote src (import-url: ${err})` };
  } catch (e) {
    return {
      src: url,
      local: false,
      note: `remote src (${e instanceof Error ? e.message : 'no proxy'})`,
    };
  }
}

type BatchRow =
  | { success: true; assetId: string; name: string; type: string; src: string; local: boolean; note?: string }
  | { success: false; error: string; url?: string };

function batchEnvelope(results: BatchRow[]) {
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;
  return { failed, succeeded, results };
}

async function registerMediaUrl(
  url: string,
  opts: {
    name?: string;
    type?: string;
    duration?: number;
    durationInFrames?: number;
    width?: number;
    height?: number;
    properties?: unknown;
    forceRemote?: boolean;
  },
  ctx: AgentContext,
): Promise<BatchRow> {
  if (!isHttpUrl(url)) {
    return { success: false, error: 'must be a public http(s) URL (local paths not accepted)', url };
  }

  const kind = mapTypeToKind(opts.type, url);
  if (!kind) {
    return {
      success: false,
      error: opts.type === 'effect' || opts.type === 'transition'
        ? `type=${opts.type} is not an OpenChatCut media-pool asset`
        : '无法从 URL 识别媒体类型，请传 type: video|image|audio|gif|svg|motion-graphic',
      url,
    };
  }

  const fps = ctx.getState().fps;
  let src = url;
  let local = false;
  let note: string | undefined;
  let filename: string | undefined;

  if (kind !== 'motion-graphic' && !opts.forceRemote) {
    const mat = await materializeUrl(url);
    src = mat.src;
    local = mat.local;
    note = mat.note;
    filename = mat.filename;
  }

  let durationInFrames: number;
  if (typeof opts.durationInFrames === 'number' && opts.durationInFrames > 0) {
    durationInFrames = Math.round(opts.durationInFrames);
  } else if (typeof opts.duration === 'number' && opts.duration > 0) {
    durationInFrames = Math.max(1, Math.round(opts.duration * fps));
  } else if (kind === 'motion-graphic') {
    durationInFrames = Math.round(5 * fps);
  } else {
    try {
      const meta = await probeUrl(src, kind, fps);
      durationInFrames = meta.durationInFrames;
      if (opts.width == null && meta.width) opts.width = meta.width;
      if (opts.height == null && meta.height) opts.height = meta.height;
    } catch {
      durationInFrames = fallbackDuration(kind, fps);
    }
  }

  const sourceFilename = safeSourceFilename(filename) ?? nameFromUrl(url);
  const displayName = opts.name?.trim() || sourceFilename;

  const asset: MediaAsset = {
    id: newId(),
    name: displayName,
    sourceFilename,
    kind,
    src,
    durationInFrames,
    width: typeof opts.width === 'number' && opts.width > 0 ? opts.width : undefined,
    height: typeof opts.height === 'number' && opts.height > 0 ? opts.height : undefined,
  };

  if (kind === 'motion-graphic' && Array.isArray(opts.properties)) {
    const props: Record<string, unknown> = {};
    for (const p of opts.properties) {
      if (p && typeof p === 'object' && 'key' in p) {
        const row = p as { key: string; defaultValue?: unknown };
        if (typeof row.key === 'string') props[row.key] = row.defaultValue;
      }
    }
    asset.props = props;
  }

  ctx.commands.addAsset(asset);
  return {
    success: true,
    assetId: asset.id,
    name: asset.name,
    type: kind,
    src: asset.src,
    local,
    note,
  };
}

async function execDownloadMedia(args: Args, ctx: AgentContext): Promise<unknown> {
  const urls = normalizeUrlList(args.url);
  if (!urls.length) return { error: 'url is required (string or array, max 4)' };
  if (urls.length > MAX_BATCH) return { error: `url accepts at most ${MAX_BATCH} URLs per call (got ${urls.length}); split into batches` };

  const batchName = urls.length === 1 && typeof args.name === 'string' ? args.name : undefined;
  const type = typeof args.type === 'string' ? args.type : undefined;

  const results: BatchRow[] = [];
  for (const url of urls) {
    results.push(await registerMediaUrl(url, { name: batchName, type }, ctx));
  }
  return batchEnvelope(results);
}

async function execPushAsset(args: Args, ctx: AgentContext): Promise<unknown> {
  const urls = normalizeUrlList(args.filePath);
  if (!urls.length) return { error: 'filePath is required (public http(s) URL or array, max 4)' };
  if (urls.length > MAX_BATCH) return { error: `filePath accepts at most ${MAX_BATCH} URLs per call (got ${urls.length}); split into batches` };

  const batchName = urls.length === 1 && typeof args.name === 'string' ? args.name : undefined;
  const type = typeof args.type === 'string' ? args.type : undefined;
  const duration = typeof args.duration === 'number' ? args.duration : undefined;
  const durationInFrames = typeof args.durationInFrames === 'number' ? args.durationInFrames : undefined;
  const width = typeof args.width === 'number' ? args.width : undefined;
  const height = typeof args.height === 'number' ? args.height : undefined;
  const properties = Array.isArray(args.properties) ? args.properties : undefined;

  const results: BatchRow[] = [];
  for (const url of urls) {
    results.push(await registerMediaUrl(url, {
      name: batchName,
      type,
      duration,
      durationInFrames,
      width,
      height,
      properties,
    }, ctx));
  }
  return batchEnvelope(results);
}

async function execImportUrlAsset(args: Args, ctx: AgentContext): Promise<unknown> {
  // Legacy single-asset shape for old prompts / checks
  const url = String(args.url ?? '').trim();
  const kind = args.kind === 'video' || args.kind === 'image' || args.kind === 'audio'
    ? args.kind
    : undefined;
  const name = typeof args.name === 'string' ? args.name : undefined;

  const pushed = await execPushAsset({
    filePath: url,
    name,
    type: kind,
  }, ctx) as { failed: number; succeeded: number; results: BatchRow[] };

  const first = pushed.results?.[0];
  if (!first) return { error: 'import failed' };
  if (first.success !== true) return { error: first.error ?? 'import failed' };

  const asset = (ctx.getState().assets ?? []).find((a) => a.id === first.assetId);
  return {
    ok: true,
    asset: asset
      ? { id: asset.id, name: asset.name, kind: asset.kind, durationInFrames: asset.durationInFrames }
      : { id: first.assetId, name: first.name, kind: first.type, durationInFrames: undefined },
    note: 'import_url_asset is a legacy alias of push_asset; prefer download_media or push_asset.',
  };
}

interface StockSearchResponse {
  configured?: boolean;
  results?: unknown[];
  warnings?: string[];
  searchedPlatforms?: string[];
}

async function execSearchStockMedia(args: Args): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  if (!query) return { error: 'query is required', results: [] };
  const kind = args.kind === 'any' || args.kind === 'image' || args.kind === 'audio' || args.kind === 'music'
    ? args.kind
    : 'video';

  const params = new URLSearchParams({ query, kind });
  if (args.orientation) params.set('orientation', String(args.orientation));
  if (args.category) params.set('category', String(args.category));
  if (args.platforms) {
    params.set('platforms', Array.isArray(args.platforms) ? args.platforms.join(',') : String(args.platforms));
  }
  if (args.limitPerPlatform) params.set('limitPerPlatform', String(args.limitPerPlatform));

  try {
    const res = await fetch(`/api/stock-search?${params.toString()}`);
    if (!res.ok) return { error: `素材库搜索失败 (${res.status})`, results: [] };
    const body = await res.json() as StockSearchResponse;
    if (!body.configured) {
      return {
        error: kind === 'audio' || kind === 'music'
          ? '未配置音频素材库 API key（FREESOUND_API_KEY），可改用内置音效库或 download_media / push_asset 直接导入 URL'
          : '未配置素材搜索凭据（PEXELS_API_KEY / PIXABAY_API_KEY / UNSPLASH_ACCESS_KEY / FIRECRAWL_API_KEY），可改用 download_media / push_asset 直接导入 URL',
        results: [],
        warnings: body.warnings ?? [],
      };
    }
    return {
      results: body.results ?? [],
      warnings: body.warnings ?? [],
      searchedPlatforms: body.searchedPlatforms ?? [],
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'stock search request failed', results: [] };
  }
}

export async function execStockTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'download_media') return execDownloadMedia(args, ctx);
  if (name === 'push_asset') return execPushAsset(args, ctx);
  if (name === 'import_url_asset') return execImportUrlAsset(args, ctx);
  if (name === 'search_stock_media') return execSearchStockMedia(args);
  return { error: `unknown tool ${name}` };
}
