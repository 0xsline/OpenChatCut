import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';

// 素材库搜索代理（source search_stock_media）：key 只留在服务端，浏览器只打
// /api/stock-search。无 key 时返回 configured:false 而非报错，工具侧优雅降级。

interface StockPluginOptions {
  pexelsApiKey: string;
  pixabayApiKey: string;
}

export interface StockResult {
  platform: 'pexels' | 'pixabay';
  kind: 'image' | 'video';
  previewUrl: string;
  importUrl: string;
  width?: number;
  height?: number;
  author?: string;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// ── Pexels (https://www.pexels.com/api/documentation/) ──
interface PexelsPhoto { width: number; height: number; photographer: string; src: { original: string; medium: string } }
interface PexelsVideoFile { link: string; quality: string; width: number; height: number; file_type: string }
interface PexelsVideo { width: number; height: number; image: string; user: { name: string }; video_files: PexelsVideoFile[] }

async function searchPexels(apiKey: string, query: string, kind: 'image' | 'video', orientation: string | undefined, limit: number): Promise<StockResult[]> {
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

async function searchPixabay(apiKey: string, query: string, kind: 'image' | 'video', orientation: string | undefined, limit: number): Promise<StockResult[]> {
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

/** Dev-server middleware for GET /api/stock-search?query=&kind=&orientation=&limitPerPlatform=
 * — keys read from process.env server-side only (source search_stock_media). */
export function stockSearchPlugin(options: StockPluginOptions): Plugin {
  return {
    name: 'chatcut-stock-search',
    configureServer(server) {
      server.middlewares.use('/api/stock-search', async (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed — use GET' }); return; }
        try {
          const url = new URL(req.url ?? '', 'http://localhost');
          const query = (url.searchParams.get('query') ?? '').trim();
          if (!query) { sendJson(res, 400, { error: 'query is required' }); return; }
          const kind = url.searchParams.get('kind') === 'image' ? 'image' : 'video';
          const orientation = url.searchParams.get('orientation') ?? undefined;
          const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limitPerPlatform')) || DEFAULT_LIMIT));

          if (!options.pexelsApiKey && !options.pixabayApiKey) {
            sendJson(res, 200, { configured: false, results: [] });
            return;
          }

          const [pexels, pixabay] = await Promise.allSettled([
            options.pexelsApiKey ? searchPexels(options.pexelsApiKey, query, kind, orientation, limit) : Promise.resolve([]),
            options.pixabayApiKey ? searchPixabay(options.pixabayApiKey, query, kind, orientation, limit) : Promise.resolve([]),
          ]);
          const results = [
            ...(pexels.status === 'fulfilled' ? pexels.value : []),
            ...(pixabay.status === 'fulfilled' ? pixabay.value : []),
          ];
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
