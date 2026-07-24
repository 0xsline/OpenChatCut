import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export interface StockPluginOptions {
  pexelsApiKey: string;
  pixabayApiKey: string;
  unsplashAccessKey?: string;
  freesoundApiKey?: string;
  firecrawlApiKey?: string;
}

export type StockPlatform = 'pexels' | 'pixabay' | 'unsplash' | 'freesound';
export type StockKind = 'any' | 'image' | 'video' | 'audio' | 'music';
export type StockOrientation = 'horizontal' | 'vertical' | 'square';
type SearchableKind = 'image' | 'video' | 'audio';
type FetchLike = typeof fetch;

export interface StockResult {
  platform: StockPlatform;
  kind: SearchableKind;
  previewUrl: string;
  importUrl: string;
  width?: number;
  height?: number;
  author?: string;
  durationSeconds?: number;
}

export interface StockSearchRequest {
  query: string;
  kind?: string;
  orientation?: string;
  category?: string;
  platforms?: string | string[];
  limitPerPlatform?: number;
}

export interface StockSearchResponse {
  configured: boolean;
  results: StockResult[];
  warnings: string[];
  searchedPlatforms: StockPlatform[];
}

interface SearchTarget {
  platform: StockPlatform;
  kind: SearchableKind;
}

interface SearchJob {
  label: string;
  platforms: StockPlatform[];
  run: () => Promise<StockResult[]>;
}

const ALL_PLATFORMS: StockPlatform[] = ['pexels', 'pixabay', 'unsplash', 'freesound'];
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 6;
const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function normalizeStockKind(value: unknown): StockKind {
  return value === 'any' || value === 'image' || value === 'audio' || value === 'music'
    ? value
    : 'video';
}

export function normalizeStockOrientation(value: unknown): StockOrientation | undefined {
  if (value === 'horizontal' || value === 'landscape') return 'horizontal';
  if (value === 'vertical' || value === 'portrait') return 'vertical';
  if (value === 'square' || value === 'squarish') return 'square';
  return undefined;
}

export function parseStockPlatforms(
  value: unknown,
  kind: StockKind,
): { platforms: StockPlatform[]; warnings: string[]; explicit: boolean } {
  const explicit = (Array.isArray(value) && value.length > 0)
    || (typeof value === 'string' && value.trim().length > 0);
  const defaults: StockPlatform[] = kind === 'image'
    ? ['pexels', 'pixabay', 'unsplash']
    : kind === 'video'
      ? ['pexels', 'pixabay']
      : kind === 'audio' || kind === 'music'
        ? ['freesound']
        : [...ALL_PLATFORMS];
  if (!explicit) return { platforms: defaults, warnings: [], explicit: false };

  const tokens = (Array.isArray(value) ? value : String(value).split(','))
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const warnings: string[] = [];
  const platforms: StockPlatform[] = [];
  for (const token of tokens) {
    if (!ALL_PLATFORMS.includes(token as StockPlatform)) {
      warnings.push(`Unsupported material platform"${token}”, ignored`);
      continue;
    }
    const platform = token as StockPlatform;
    if (!platforms.includes(platform)) platforms.push(platform);
  }
  return { platforms, warnings, explicit: true };
}

function supportsKind(platform: StockPlatform, kind: SearchableKind): boolean {
  if (platform === 'pexels' || platform === 'pixabay') return kind === 'image' || kind === 'video';
  if (platform === 'unsplash') return kind === 'image';
  return kind === 'audio';
}

export function buildStockSearchTargets(
  kind: StockKind,
  platforms: StockPlatform[],
): { targets: SearchTarget[]; warnings: string[] } {
  const requestedKinds: SearchableKind[] = kind === 'any'
    ? ['image', 'video', 'audio']
    : kind === 'music'
      ? ['audio']
      : [kind];
  const targets: SearchTarget[] = [];
  const warnings: string[] = [];
  for (const platform of platforms) {
    let added = false;
    for (const requestedKind of requestedKinds) {
      if (!supportsKind(platform, requestedKind)) continue;
      targets.push({ platform, kind: requestedKind });
      added = true;
    }
    if (!added) warnings.push(`${platform} Not supported ${kind} Material, skipped`);
  }
  return { targets, warnings };
}

export function buildStockQuery(query: string, category?: string): string {
  const base = query.trim();
  const extra = category?.trim();
  if (!extra || base.toLowerCase().includes(extra.toLowerCase())) return base;
  return `${base} ${extra}`;
}

function canonicalStockUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function dedupeStockResults(results: StockResult[]): StockResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = canonicalStockUrl(result.importUrl);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface PexelsPhoto {
  width: number;
  height: number;
  photographer: string;
  src: { original: string; medium: string };
}
interface PexelsVideoFile { link: string; quality: string; width: number; height: number; file_type: string }
interface PexelsVideo { image: string; user: { name: string }; video_files: PexelsVideoFile[] }

async function searchPexels(
  fetchImpl: FetchLike,
  apiKey: string,
  query: string,
  kind: SearchableKind,
  orientation: StockOrientation | undefined,
  limit: number,
): Promise<StockResult[]> {
  if (kind === 'audio') return [];
  const params = new URLSearchParams({ query, per_page: String(limit) });
  if (orientation) {
    params.set('orientation', orientation === 'horizontal' ? 'landscape' : orientation === 'vertical' ? 'portrait' : 'square');
  }
  const endpoint = kind === 'video' ? 'https://api.pexels.com/videos/search' : 'https://api.pexels.com/v1/search';
  const res = await fetchImpl(`${endpoint}?${params.toString()}`, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Pexels search failed (${res.status})`);
  if (kind === 'video') {
    const body = await res.json() as { videos?: PexelsVideo[] };
    return (body.videos ?? []).map((video): StockResult | null => {
      const file = video.video_files.find((item) => item.quality === 'hd')
        ?? video.video_files.find((item) => item.file_type === 'video/mp4')
        ?? video.video_files[0];
      return file ? {
        platform: 'pexels', kind: 'video', previewUrl: video.image, importUrl: file.link,
        width: file.width, height: file.height, author: video.user?.name,
      } : null;
    }).filter((result): result is StockResult => result !== null);
  }
  const body = await res.json() as { photos?: PexelsPhoto[] };
  return (body.photos ?? []).map((photo) => ({
    platform: 'pexels', kind: 'image', previewUrl: photo.src.medium, importUrl: photo.src.original,
    width: photo.width, height: photo.height, author: photo.photographer,
  }));
}

interface PixabayImageHit { webformatURL: string; largeImageURL: string; imageWidth: number; imageHeight: number; user: string }
interface PixabayVideoQuality { url: string; width: number; height: number }
interface PixabayVideoHit {
  videos: { large: PixabayVideoQuality; medium: PixabayVideoQuality; small: PixabayVideoQuality; tiny: PixabayVideoQuality };
  user: string;
}

async function searchPixabay(
  fetchImpl: FetchLike,
  apiKey: string,
  query: string,
  kind: SearchableKind,
  orientation: StockOrientation | undefined,
  limit: number,
): Promise<StockResult[]> {
  if (kind === 'audio') return [];
  const params = new URLSearchParams({ key: apiKey, q: query, per_page: String(Math.max(3, limit)) });
  if (orientation === 'horizontal' || orientation === 'vertical') params.set('orientation', orientation);
  const endpoint = kind === 'video' ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/';
  const res = await fetchImpl(`${endpoint}?${params.toString()}`);
  if (!res.ok) throw new Error(`Pixabay search failed (${res.status})`);
  if (kind === 'video') {
    const body = await res.json() as { hits?: PixabayVideoHit[] };
    return (body.hits ?? []).slice(0, limit).map((hit) => {
      const quality = hit.videos.medium ?? hit.videos.large;
      return {
        platform: 'pixabay', kind: 'video', previewUrl: hit.videos.tiny?.url ?? quality.url,
        importUrl: quality.url, width: quality.width, height: quality.height, author: hit.user,
      };
    });
  }
  const body = await res.json() as { hits?: PixabayImageHit[] };
  return (body.hits ?? []).slice(0, limit).map((hit) => ({
    platform: 'pixabay', kind: 'image', previewUrl: hit.webformatURL, importUrl: hit.largeImageURL,
    width: hit.imageWidth, height: hit.imageHeight, author: hit.user,
  }));
}

interface UnsplashPhoto {
  urls: { regular: string; full: string; small: string };
  width: number;
  height: number;
  user?: { name?: string };
}

async function searchUnsplash(
  fetchImpl: FetchLike,
  accessKey: string,
  query: string,
  kind: SearchableKind,
  orientation: StockOrientation | undefined,
  limit: number,
): Promise<StockResult[]> {
  if (kind !== 'image') return [];
  const params = new URLSearchParams({ query, per_page: String(limit) });
  if (orientation) {
    params.set('orientation', orientation === 'horizontal' ? 'landscape' : orientation === 'vertical' ? 'portrait' : 'squarish');
  }
  const res = await fetchImpl(`https://api.unsplash.com/search/photos?${params.toString()}`, {
    headers: { Authorization: `Client-ID ${accessKey}` },
  });
  if (!res.ok) throw new Error(`Unsplash search failed (${res.status})`);
  const body = await res.json() as { results?: UnsplashPhoto[] };
  return (body.results ?? []).map((photo) => ({
    platform: 'unsplash', kind: 'image', previewUrl: photo.urls.small ?? photo.urls.regular,
    importUrl: photo.urls.full ?? photo.urls.regular, width: photo.width, height: photo.height,
    author: photo.user?.name,
  }));
}

interface FreesoundHit {
  name: string;
  username: string;
  duration: number;
  previews?: { 'preview-hq-mp3'?: string; 'preview-lq-mp3'?: string };
}

async function searchFreesound(
  fetchImpl: FetchLike,
  apiKey: string,
  query: string,
  limit: number,
  musicOnly: boolean,
): Promise<StockResult[]> {
  const params = new URLSearchParams({
    query,
    page_size: String(limit),
    fields: 'name,username,duration,previews',
    token: apiKey,
  });
  if (musicOnly) params.set('filter', 'tag:music');
  const res = await fetchImpl(`https://freesound.org/apiv2/search/text/?${params.toString()}`);
  if (!res.ok) throw new Error(`Freesound search failed (${res.status})`);
  const body = await res.json() as { results?: FreesoundHit[] };
  return (body.results ?? []).map((hit): StockResult | null => {
    const mediaUrl = hit.previews?.['preview-hq-mp3'] ?? hit.previews?.['preview-lq-mp3'];
    return mediaUrl ? {
      platform: 'freesound', kind: 'audio', previewUrl: mediaUrl, importUrl: mediaUrl,
      author: hit.username || hit.name, durationSeconds: hit.duration,
    } : null;
  }).filter((result): result is StockResult => result !== null);
}

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

async function searchFirecrawl(
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

function addUnavailableWarning(warnings: string[], target: SearchTarget): void {
  const message = target.platform === 'freesound'
    ? 'Freesound Not configured, unable to search for audio or music'
    : `${target.platform} Not configured, skipped ${target.kind} Search`;
  if (!warnings.includes(message)) warnings.push(message);
}

export async function searchStockMedia(
  options: StockPluginOptions,
  request: StockSearchRequest,
  fetchImpl: FetchLike = fetch,
): Promise<StockSearchResponse> {
  const kind = normalizeStockKind(request.kind);
  const orientation = normalizeStockOrientation(request.orientation);
  const parsedPlatforms = parseStockPlatforms(request.platforms, kind);
  const planned = buildStockSearchTargets(kind, parsedPlatforms.platforms);
  const warnings = [...parsedPlatforms.warnings, ...planned.warnings];
  if (request.orientation && !orientation) warnings.push(`Unsupported direction"${request.orientation}”, direction filtering has been ignored`);
  const query = buildStockQuery(request.query, request.category);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(request.limitPerPlatform) || DEFAULT_LIMIT));
  const jobs: SearchJob[] = [];
  const missingFirecrawlImages: Array<'pexels' | 'pixabay'> = [];
  let missingFirecrawlVideo = false;

  for (const target of planned.targets) {
    if (target.platform === 'pexels' && options.pexelsApiKey) {
      jobs.push({
        label: `pexels/${target.kind}`, platforms: ['pexels'],
        run: () => searchPexels(fetchImpl, options.pexelsApiKey, query, target.kind, orientation, limit),
      });
    } else if (target.platform === 'pixabay' && options.pixabayApiKey) {
      if (orientation === 'square') {
        const warning = 'Pixabay The official interface does not support square direction filtering, and other filtering conditions have been reserved.';
        if (!warnings.includes(warning)) warnings.push(warning);
      }
      jobs.push({
        label: `pixabay/${target.kind}`, platforms: ['pixabay'],
        run: () => searchPixabay(fetchImpl, options.pixabayApiKey, query, target.kind, orientation, limit),
      });
    } else if (target.platform === 'unsplash' && options.unsplashAccessKey) {
      jobs.push({
        label: 'unsplash/image', platforms: ['unsplash'],
        run: () => searchUnsplash(fetchImpl, options.unsplashAccessKey!, query, target.kind, orientation, limit),
      });
    } else if (target.platform === 'freesound' && options.freesoundApiKey) {
      jobs.push({
        label: 'freesound/audio', platforms: ['freesound'],
        run: () => searchFreesound(fetchImpl, options.freesoundApiKey!, query, limit, kind === 'music'),
      });
    } else if (options.firecrawlApiKey && target.kind === 'image'
      && (target.platform === 'pexels' || target.platform === 'pixabay')) {
      if (!missingFirecrawlImages.includes(target.platform)) missingFirecrawlImages.push(target.platform);
    } else if (options.firecrawlApiKey && target.kind === 'video' && target.platform === 'pixabay') {
      missingFirecrawlVideo = true;
    } else {
      addUnavailableWarning(warnings, target);
    }
  }

  if (missingFirecrawlImages.length) {
    jobs.push({
      label: `firecrawl/${missingFirecrawlImages.join(',')}/image`, platforms: [...missingFirecrawlImages],
      run: () => searchFirecrawl(
        fetchImpl, options.firecrawlApiKey!, query, 'image', orientation, limit, missingFirecrawlImages,
      ),
    });
  }
  if (missingFirecrawlVideo) {
    jobs.push({
      label: 'firecrawl/pixabay/video', platforms: ['pixabay'],
      run: () => searchFirecrawl(fetchImpl, options.firecrawlApiKey!, query, 'video', orientation, limit, ['pixabay']),
    });
  }

  const settled = await Promise.allSettled(jobs.map((job) => job.run()));
  const results: StockResult[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') results.push(...result.value);
    else warnings.push(`${jobs[index]!.label} Search failed:${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  const searchedPlatforms = [...new Set(jobs.flatMap((job) => job.platforms))];
  return {
    configured: jobs.length > 0,
    results: dedupeStockResults(results),
    warnings: [...new Set(warnings)],
    searchedPlatforms,
  };
}

/** Server-only proxy for search_stock_media. Provider keys never enter the browser bundle. */
export function stockSearchPlugin(options: StockPluginOptions): Plugin {
  return {
    name: 'openchatcut-stock-search',
    configureServer(server) {
      server.middlewares.use('/api/stock-search', async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed — use GET' });
          return;
        }
        try {
          const url = new URL(req.url ?? '', 'http://localhost');
          const query = (url.searchParams.get('query') ?? '').trim();
          if (!query) {
            sendJson(res, 400, { error: 'query is required' });
            return;
          }
          const response = await searchStockMedia(options, {
            query,
            kind: url.searchParams.get('kind') ?? undefined,
            orientation: url.searchParams.get('orientation') ?? undefined,
            category: url.searchParams.get('category') ?? undefined,
            platforms: url.searchParams.get('platforms') ?? undefined,
            limitPerPlatform: Number(url.searchParams.get('limitPerPlatform')) || undefined,
          });
          sendJson(res, 200, response);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[stock-search] ${message}`);
          sendJson(res, 200, {
            configured: true,
            results: [],
            warnings: [`Material search is temporarily unavailable:${message}`],
            searchedPlatforms: [],
          } satisfies StockSearchResponse);
        }
      });
    },
  };
}
