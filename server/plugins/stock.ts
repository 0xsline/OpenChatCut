import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';

// 素材库搜索代理（search_stock_media 工具后端）：key 只留在服务端，浏览器只打
// /api/stock-search。Pexels/Pixabay key 缺失时，图片/视频可经 Firecrawl
// 搜索公开素材页并提取可直接导入的 CDN URL。

interface StockPluginOptions {
  pexelsApiKey: string;
  pixabayApiKey: string;
  unsplashAccessKey?: string;
  freesoundApiKey?: string;
  firecrawlApiKey?: string;
}

export interface StockResult {
  platform: 'pexels' | 'pixabay' | 'unsplash' | 'freesound';
  kind: 'image' | 'video' | 'audio';
  previewUrl: string;
  importUrl: string;
  width?: number;
  height?: number;
  author?: string;
  durationSeconds?: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// ── Pexels (https://www.pexels.com/api/documentation/) ──
interface PexelsPhoto { width: number; height: number; photographer: string; src: { original: string; medium: string } }
interface PexelsVideoFile { link: string; quality: string; width: number; height: number; file_type: string }
interface PexelsVideo { width: number; height: number; image: string; user: { name: string }; video_files: PexelsVideoFile[] }

async function searchPexels(apiKey: string, query: string, kind: 'image' | 'video' | 'audio', orientation: string | undefined, limit: number): Promise<StockResult[]> {
  if (kind === 'audio') return [];
  const params = new URLSearchParams({ query, per_page: String(limit) });
  if (orientation) params.set('orientation', orientation);
  const endpoint = kind === 'video' ? 'https://api.pexels.com/videos/search' : 'https://api.pexels.com/v1/search';
  const res = await fetch(`${endpoint}?${params.toString()}`, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Pexels search failed (${res.status})`);
  if (kind === 'video') {
    const body = await res.json() as { videos?: PexelsVideo[] };
    return (body.videos ?? []).map((v): StockResult | null => {
      const file = v.video_files.find((f) => f.quality === 'hd') ?? v.video_files.find((f) => f.file_type === 'video/mp4') ?? v.video_files[0];
      return file ? { platform: 'pexels', kind: 'video', previewUrl: v.image, importUrl: file.link, width: file.width, height: file.height, author: v.user?.name } : null;
    }).filter((r): r is StockResult => r !== null);
  }
  const body = await res.json() as { photos?: PexelsPhoto[] };
  return (body.photos ?? []).map((p) => ({ platform: 'pexels' as const, kind: 'image' as const, previewUrl: p.src.medium, importUrl: p.src.original, width: p.width, height: p.height, author: p.photographer }));
}

// ── Pixabay (https://pixabay.com/api/docs/) ──
interface PixabayImageHit { webformatURL: string; largeImageURL: string; imageWidth: number; imageHeight: number; user: string }
interface PixabayVideoQuality { url: string; width: number; height: number }
interface PixabayVideoHit { videos: { large: PixabayVideoQuality; medium: PixabayVideoQuality; small: PixabayVideoQuality; tiny: PixabayVideoQuality }; user: string }

async function searchPixabay(apiKey: string, query: string, kind: 'image' | 'video' | 'audio', orientation: string | undefined, limit: number): Promise<StockResult[]> {
  if (kind === 'audio') return [];
  const params = new URLSearchParams({ key: apiKey, q: query, per_page: String(Math.max(3, limit)) });
  if (orientation === 'landscape' || orientation === 'portrait') params.set('orientation', orientation);
  const endpoint = kind === 'video' ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/';
  const res = await fetch(`${endpoint}?${params.toString()}`);
  if (!res.ok) throw new Error(`Pixabay search failed (${res.status})`);
  if (kind === 'video') {
    const body = await res.json() as { hits?: PixabayVideoHit[] };
    return (body.hits ?? []).slice(0, limit).map((h) => {
      const q = h.videos.medium ?? h.videos.large;
      return { platform: 'pixabay' as const, kind: 'video' as const, previewUrl: h.videos.tiny?.url ?? q.url, importUrl: q.url, width: q.width, height: q.height, author: h.user };
    });
  }
  const body = await res.json() as { hits?: PixabayImageHit[] };
  return (body.hits ?? []).slice(0, limit).map((h) => ({ platform: 'pixabay' as const, kind: 'image' as const, previewUrl: h.webformatURL, importUrl: h.largeImageURL, width: h.imageWidth, height: h.imageHeight, author: h.user }));
}

// ── Unsplash (https://unsplash.com/documentation) — images only ──
interface UnsplashPhoto {
  urls: { regular: string; full: string; small: string };
  width: number;
  height: number;
  user?: { name?: string };
}

async function searchUnsplash(accessKey: string, query: string, kind: 'image' | 'video' | 'audio', orientation: string | undefined, limit: number): Promise<StockResult[]> {
  if (kind !== 'image') return [];
  const params = new URLSearchParams({ query, per_page: String(limit) });
  if (orientation === 'landscape' || orientation === 'portrait' || orientation === 'squarish') {
    params.set('orientation', orientation);
  }
  const res = await fetch(`https://api.unsplash.com/search/photos?${params.toString()}`, {
    headers: { Authorization: `Client-ID ${accessKey}` },
  });
  if (!res.ok) throw new Error(`Unsplash search failed (${res.status})`);
  const body = await res.json() as { results?: UnsplashPhoto[] };
  return (body.results ?? []).map((p) => ({
    platform: 'unsplash' as const,
    kind: 'image' as const,
    previewUrl: p.urls.small ?? p.urls.regular,
    importUrl: p.urls.full ?? p.urls.regular,
    width: p.width,
    height: p.height,
    author: p.user?.name,
  }));
}

// ── Freesound (https://freesound.org/docs/api/) — audio only ──
interface FreesoundHit {
  name: string;
  username: string;
  duration: number;
  previews?: { 'preview-hq-mp3'?: string; 'preview-lq-mp3'?: string };
}

async function searchFreesound(apiKey: string, query: string, kind: 'image' | 'video' | 'audio', limit: number): Promise<StockResult[]> {
  if (kind !== 'audio') return [];
  const params = new URLSearchParams({
    query,
    page_size: String(limit),
    fields: 'name,username,duration,previews',
    token: apiKey,
  });
  const res = await fetch(`https://freesound.org/apiv2/search/text/?${params.toString()}`);
  if (!res.ok) throw new Error(`Freesound search failed (${res.status})`);
  const body = await res.json() as { results?: FreesoundHit[] };
  return (body.results ?? []).map((h): StockResult | null => {
    const url = h.previews?.['preview-hq-mp3'] ?? h.previews?.['preview-lq-mp3'];
    if (!url) return null;
    return {
      platform: 'freesound',
      kind: 'audio',
      previewUrl: url,
      importUrl: url,
      author: h.username || h.name,
      durationSeconds: h.duration,
    };
  }).filter((r): r is StockResult => r !== null);
}

interface FirecrawlImageHit {
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  url?: string;
}

interface FirecrawlWebHit {
  markdown?: string;
}

interface FirecrawlResponse {
  success?: boolean;
  data?: { images?: FirecrawlImageHit[]; web?: FirecrawlWebHit[] };
}

function stockPlatform(url: string): 'pexels' | 'pixabay' {
  return url.includes('pexels.com') ? 'pexels' : 'pixabay';
}

function matchesOrientation(hit: FirecrawlImageHit, orientation?: string): boolean {
  const width = hit.imageWidth ?? 0;
  const height = hit.imageHeight ?? 0;
  if (!width || !height || !orientation) return true;
  if (orientation === 'landscape') return width >= height;
  if (orientation === 'portrait') return height >= width;
  if (orientation === 'square' || orientation === 'squarish') return Math.abs(width - height) / Math.max(width, height) < 0.15;
  return true;
}

export function parseFirecrawlImages(
  hits: FirecrawlImageHit[],
  orientation: string | undefined,
  limit: number,
): StockResult[] {
  return hits
    .filter((hit) => Boolean(hit.imageUrl) && matchesOrientation(hit, orientation))
    .slice(0, limit)
    .map((hit) => ({
      platform: stockPlatform(`${hit.url ?? ''} ${hit.imageUrl}`),
      kind: 'image',
      previewUrl: hit.imageUrl!,
      importUrl: hit.imageUrl!,
      width: hit.imageWidth,
      height: hit.imageHeight,
      author: hit.title,
    }));
}

export function parseFirecrawlVideos(markdown: string, limit: number): StockResult[] {
  const urls = new Set<string>();
  const matches = markdown.matchAll(/file-url=(https?%3A%2F%2F[^&\s)]+?\.mp4)/gi);
  for (const match of matches) {
    try {
      const decoded = decodeURIComponent(match[1]!);
      if (decoded.startsWith('https://cdn.pixabay.com/video/')) urls.add(decoded);
    } catch { /* malformed upstream URL */ }
    if (urls.size >= limit) break;
  }
  return [...urls].map((importUrl) => ({
    platform: 'pixabay',
    kind: 'video',
    previewUrl: importUrl.replace(/_(?:large|medium)\.mp4(?:\?.*)?$/, '_tiny.jpg'),
    importUrl,
  }));
}

async function firecrawlSearch(apiKey: string, payload: Record<string, unknown>): Promise<FirecrawlResponse> {
  const res = await fetch(FIRECRAWL_SEARCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Firecrawl stock search failed (${res.status})`);
  return res.json() as Promise<FirecrawlResponse>;
}

async function searchFirecrawl(
  apiKey: string,
  query: string,
  kind: 'image' | 'video' | 'audio',
  orientation: string | undefined,
  limit: number,
): Promise<StockResult[]> {
  if (kind === 'audio') return [];
  if (kind === 'image') {
    const body = await firecrawlSearch(apiKey, {
      query,
      sources: ['images'],
      includeDomains: ['pexels.com', 'pixabay.com'],
      limit: Math.min(20, limit * 2),
    });
    return parseFirecrawlImages(body.data?.images ?? [], orientation, limit);
  }
  const body = await firecrawlSearch(apiKey, {
    query: `${query} stock video`,
    sources: ['web'],
    includeDomains: ['pixabay.com'],
    limit: 2,
    scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
  });
  const markdown = (body.data?.web ?? []).map((hit) => hit.markdown ?? '').join('\n');
  return parseFirecrawlVideos(markdown, limit);
}

/** Dev-server middleware for GET /api/stock-search?query=&kind=&orientation=&limitPerPlatform=
 * — keys read from process.env server-side only (backs search_stock_media). */
export function stockSearchPlugin(options: StockPluginOptions): Plugin {
  return {
    name: 'openchatcut-stock-search',
    configureServer(server) {
      server.middlewares.use('/api/stock-search', async (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed — use GET' }); return; }
        try {
          const url = new URL(req.url ?? '', 'http://localhost');
          const query = (url.searchParams.get('query') ?? '').trim();
          if (!query) { sendJson(res, 400, { error: 'query is required' }); return; }
          const kindParam = url.searchParams.get('kind') ?? 'video';
          const kind: 'image' | 'video' | 'audio' =
            kindParam === 'image' ? 'image' : kindParam === 'audio' ? 'audio' : 'video';
          const orientation = url.searchParams.get('orientation') ?? undefined;
          const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limitPerPlatform')) || DEFAULT_LIMIT));

          const unsplash = options.unsplashAccessKey ?? '';
          const freesound = options.freesoundApiKey ?? '';
          const firecrawl = options.firecrawlApiKey ?? '';
          const officialVisual = options.pexelsApiKey || options.pixabayApiKey || (kind === 'image' && unsplash);
          const configured = kind === 'audio' ? Boolean(freesound) : Boolean(officialVisual || firecrawl);
          if (!configured) {
            sendJson(res, 200, { configured: false, results: [] });
            return;
          }

          const settled = await Promise.allSettled([
            options.pexelsApiKey ? searchPexels(options.pexelsApiKey, query, kind, orientation, limit) : Promise.resolve([]),
            options.pixabayApiKey ? searchPixabay(options.pixabayApiKey, query, kind, orientation, limit) : Promise.resolve([]),
            unsplash ? searchUnsplash(unsplash, query, kind, orientation, limit) : Promise.resolve([]),
            freesound ? searchFreesound(freesound, query, kind, limit) : Promise.resolve([]),
            firecrawl && !officialVisual ? searchFirecrawl(firecrawl, query, kind, orientation, limit) : Promise.resolve([]),
          ]);
          const results = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
          sendJson(res, 200, { configured: true, results });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[stock-search] ${message}`);
          sendJson(res, 200, { configured: true, results: [] }); // 降级：不把上游波动变成 agent 侧硬失败
        }
      });
    },
  };
}
