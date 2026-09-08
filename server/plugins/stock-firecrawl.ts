import type { StockOrientation, StockResult } from './stock.ts';

const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';
type FetchLike = typeof fetch;

interface FirecrawlImageHit {
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  url?: string;
}
interface FirecrawlWebHit { markdown?: string }
interface FirecrawlResponse { data?: { images?: FirecrawlImageHit[]; web?: FirecrawlWebHit[] } }

function stockPlatform(url: string): 'pexels' | 'pixabay' {
  return url.includes('pexels.com') ? 'pexels' : 'pixabay';
}

function matchesOrientation(hit: FirecrawlImageHit, orientation?: StockOrientation): boolean {
  const width = hit.imageWidth ?? 0;
  const height = hit.imageHeight ?? 0;
  if (!width || !height || !orientation) return true;
  if (orientation === 'horizontal') return width >= height;
  if (orientation === 'vertical') return height >= width;
  return Math.abs(width - height) / Math.max(width, height) < 0.15;
}

export function parseFirecrawlImages(
  hits: FirecrawlImageHit[],
  orientation: StockOrientation | undefined,
  limit: number,
  platforms: Array<'pexels' | 'pixabay'> = ['pexels', 'pixabay'],
): StockResult[] {
  const counts = new Map<'pexels' | 'pixabay', number>();
  return hits
    .filter((hit) => Boolean(hit.imageUrl) && matchesOrientation(hit, orientation))
    .map((hit) => ({ hit, platform: stockPlatform(`${hit.url ?? ''} ${hit.imageUrl}`) }))
    .filter(({ platform }) => platforms.includes(platform))
    .filter(({ platform }) => {
      const count = counts.get(platform) ?? 0;
      if (count >= limit) return false;
      counts.set(platform, count + 1);
      return true;
    })
    .map(({ hit, platform }) => ({
      platform, kind: 'image', previewUrl: hit.imageUrl!, importUrl: hit.imageUrl!,
      width: hit.imageWidth, height: hit.imageHeight, author: hit.title,
    }));
}

export function parseFirecrawlVideos(markdown: string, limit: number): StockResult[] {
  const urls = new Set<string>();
  const matches = markdown.matchAll(/file-url=(https?%3A%2F%2F[^&\s)]+?\.mp4)/gi);
  for (const match of matches) {
    try {
      const decoded = decodeURIComponent(match[1]!);
      if (decoded.startsWith('https://cdn.pixabay.com/video/')) urls.add(decoded);
    } catch { /* ignore malformed upstream URLs */ }
    if (urls.size >= limit) break;
  }
  return [...urls].map((importUrl) => ({
    platform: 'pixabay', kind: 'video',
    previewUrl: importUrl.replace(/_(?:large|medium)\.mp4(?:\?.*)?$/, '_tiny.jpg'),
    importUrl,
  }));
}

export async function searchFirecrawl(
  fetchImpl: FetchLike,
  apiKey: string,
  query: string,
  kind: 'image' | 'video',
  orientation: StockOrientation | undefined,
  limit: number,
  platforms: Array<'pexels' | 'pixabay'>,
): Promise<StockResult[]> {
  const includeDomains = platforms.map((platform) => `${platform}.com`);
  const payload = kind === 'image'
    ? { query, sources: ['images'], includeDomains, limit: Math.min(20, limit * platforms.length * 2) }
    : {
        query: `${query} stock video`, sources: ['web'], includeDomains: ['pixabay.com'], limit: 2,
        scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
      };
  const res = await fetchImpl(FIRECRAWL_SEARCH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Firecrawl stock search failed (${res.status})`);
  const body = await res.json() as FirecrawlResponse;
  if (kind === 'image') return parseFirecrawlImages(body.data?.images ?? [], orientation, limit, platforms);
  const markdown = (body.data?.web ?? []).map((hit) => hit.markdown ?? '').join('\n');
  return parseFirecrawlVideos(markdown, limit);
}
