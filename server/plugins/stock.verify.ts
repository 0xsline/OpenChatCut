import assert from 'node:assert/strict';
import {
  buildStockQuery,
  buildStockSearchTargets,
  dedupeStockResults,
  normalizeStockKind,
  normalizeStockOrientation,
  parseStockPlatforms,
  searchStockMedia,
  type StockPluginOptions,
} from './stock.ts';
import {
  classifyStockLicense,
  isDvidsContractor,
} from './stock-license.ts';
import { execStockTool, STOCK_TOOL_SCHEMAS } from '../../src/agent/tools/stock-tools.ts';
import type { AgentContext } from '../../src/agent/context.ts';

type FetchCall = { url: URL; init?: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createProviderFetch(calls: FetchCall[], failPexels = false): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    if (url.hostname === 'api.pexels.com') {
      if (failPexels) return json({}, 503);
      if (url.pathname.includes('/videos/')) {
        return json({ videos: [{
          image: 'https://preview.example/pexels-video.jpg',
          user: { name: 'Pexels Video' },
          video_files: [{
            link: 'https://cdn.example/pexels-video.mp4', quality: 'hd', width: 1920, height: 1080, file_type: 'video/mp4',
          }],
        }] });
      }
      return json({ photos: [{
        width: 1200, height: 1200, photographer: 'Pexels Photo',
        src: { medium: 'https://preview.example/shared.jpg', original: 'https://cdn.example/shared.jpg?utm_source=test' },
      }] });
    }
    if (url.hostname === 'pixabay.com') {
      if (url.pathname.includes('/videos/')) {
        const quality = { url: 'https://cdn.example/pixabay-video.mp4', width: 1280, height: 720 };
        return json({ hits: [{ user: 'Pixabay Video', videos: { large: quality, medium: quality, small: quality, tiny: quality } }] });
      }
      return json({ hits: [{
        webformatURL: 'https://preview.example/shared.jpg', largeImageURL: 'https://cdn.example/shared.jpg',
        imageWidth: 1200, imageHeight: 1200, user: 'Pixabay Photo',
      }] });
    }
    if (url.hostname === 'api.unsplash.com') {
      return json({ results: [{
        urls: { small: 'https://preview.example/unsplash.jpg', regular: 'https://preview.example/unsplash.jpg', full: 'https://cdn.example/unsplash.jpg' },
        width: 1200, height: 1200, user: { name: 'Unsplash Photo' },
      }] });
    }
    if (url.hostname === 'freesound.org') {
      return json({ results: [{
        name: 'Ambient Loop', username: 'Sound Author', duration: 12,
        previews: { 'preview-hq-mp3': 'https://cdn.example/ambient.mp3' },
      }] });
    }
    if (url.hostname === 'api.dvidshub.net') {
      return json({ results: [{
        title: 'DVIDS Asset', credit: 'U.S. Navy', unit_name: 'Navy', branch: 'Navy',
        download_url: '', files: [],
        hls_url: 'https://api.dvidshub.net/manifests/video.m3u8?api_key=secret',
        duration: '00:01:30', thumbnail: 'https://cdn.dvidshub.net/thumb.jpg',
      }] });
    }
    if (url.hostname === 'commons.wikimedia.org') {
      const gsr = url.searchParams.get('gsrsearch') ?? '';
      if (gsr.includes('filetype:video')) {
        return json({ query: { pages: { p1: { title: 'File:NATO.webm', imageinfo: [{
          url: 'https://upload.wikimedia.org/wikipedia/commons/a/a.webm', width: 1280, height: 720, mime: 'video/webm',
          extmetadata: { LicenseShortName: { value: 'Public domain' }, Artist: { value: 'U.S. Navy' } },
        }] } } } });
      }
      return json({ query: { pages: { p2: { title: 'File:Flag.png', imageinfo: [{
        url: 'https://upload.wikimedia.org/wikipedia/commons/f/flag.png', width: 900, height: 600, mime: 'image/png',
        extmetadata: { LicenseShortName: { value: 'Public domain' }, Artist: { value: '' } },
      }] } } } });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

const allKeys: StockPluginOptions = {
  pexelsApiKey: 'pexels-key',
  pixabayApiKey: 'pixabay-key',
  unsplashAccessKey: 'unsplash-key',
  freesoundApiKey: 'freesound-key',
  dvidsApiKey: 'dvids-key',
};

// ── license gate (stock-license.ts) ──────────────────────────────────────────
assert.equal(classifyStockLicense('CC BY-SA 4.0', '').tag, null); // ShareAlike blocked
assert.equal(classifyStockLicense('CC BY-NC 4.0', '').tag, null); // NonCommercial blocked
assert.equal(classifyStockLicense('Public domain', '').tag, 'PD');
assert.equal(classifyStockLicense('CC0', '').tag, 'CC0');
assert.equal(classifyStockLicense('CC BY 4.0', '').tag, 'CC-BY');
assert.equal(classifyStockLicense('PD-USGov', '').tag, 'PD-USGov');
assert.equal(classifyStockLicense('Public domain', 'Reuters').tag, null); // blocked wire service
assert.equal(classifyStockLicense('Public domain', 'RT News').tag, null); // blocked state media
assert.equal(classifyStockLicense('Some Unknown License', '').tag, null); // unrecognized → fail-closed
assert.equal(classifyStockLicense('', '').tag, null); // no explicit license
assert.equal(isDvidsContractor('Courtesy of Reuters'), true);
assert.equal(isDvidsContractor('AP Special Works'), true);
assert.equal(isDvidsContractor('U.S. Navy'), false);

// ── pure helpers ─────────────────────────────────────────────────────────────
assert.equal(normalizeStockKind('music'), 'music');
assert.equal(normalizeStockKind('unknown'), 'video');
assert.equal(normalizeStockOrientation('landscape'), 'horizontal');
assert.equal(normalizeStockOrientation('portrait'), 'vertical');
assert.equal(normalizeStockOrientation('squarish'), 'square');
assert.equal(normalizeStockOrientation('diagonal'), undefined);
assert.equal(buildStockQuery('tokyo', 'night'), 'tokyo night');
assert.equal(buildStockQuery('Tokyo Night', 'night'), 'Tokyo Night');

const parsedPlatforms = parseStockPlatforms(' PEXELS,unknown,pexels,freesound ', 'any');
assert.deepEqual(parsedPlatforms.platforms, ['pexels', 'freesound']);
assert.equal(parsedPlatforms.warnings.length, 1);
assert.deepEqual(parseStockPlatforms(undefined, 'music').platforms, ['freesound']);
assert.deepEqual(parseStockPlatforms(undefined, 'video').platforms, ['pexels', 'pixabay', 'dvids', 'wikimedia']);
assert.deepEqual(parseStockPlatforms(undefined, 'image').platforms, ['pexels', 'pixabay', 'unsplash', 'wikimedia']);

const unsupported = buildStockSearchTargets('video', ['unsplash', 'freesound']);
assert.deepEqual(unsupported.targets, []);
assert.equal(unsupported.warnings.length, 2);

const deduped = dedupeStockResults([
  { platform: 'pexels', kind: 'image', previewUrl: 'a', importUrl: 'https://cdn.example/a.jpg?utm_source=one' },
  { platform: 'pixabay', kind: 'image', previewUrl: 'b', importUrl: 'https://cdn.example/a.jpg' },
  { platform: 'unsplash', kind: 'image', previewUrl: 'c', importUrl: 'https://cdn.example/c.jpg' },
]);
assert.equal(deduped.length, 2);
assert.equal(deduped[0]?.platform, 'pexels');

// ── cross-provider search (defaults now include dvids + wikimedia) ───────────
const allCalls: FetchCall[] = [];
const allResponse = await searchStockMedia(allKeys, {
  query: 'tokyo', category: 'night', kind: 'any', orientation: 'square', limitPerPlatform: 2,
}, createProviderFetch(allCalls));
assert.equal(allResponse.configured, true);
assert.deepEqual(allResponse.searchedPlatforms, ['pexels', 'pixabay', 'unsplash', 'freesound', 'dvids', 'wikimedia']);
assert.equal(allResponse.results.length, 8, 'all six providers contribute (dvids video + wikimedia image + wikimedia video)');
assert(allResponse.results.some((result) => result.kind === 'video'));
assert(allResponse.results.some((result) => result.kind === 'audio'));
assert(allResponse.results.some((result) => result.platform === 'dvids' && result.license === 'PD-USGov'));
assert(allResponse.results.some((result) => result.platform === 'wikimedia' && result.license === 'PD'));
assert(allResponse.warnings.some((warning) => warning.includes('Pixabay') && warning.includes('方形')));
// every provider received the category-augmented query in its own param name
assert(allCalls.every((call) => {
  const q = call.url.searchParams.get('query')
    ?? call.url.searchParams.get('q')
    ?? call.url.searchParams.get('keywords')
    ?? call.url.searchParams.get('gsrsearch')
    ?? '';
  return q.includes('tokyo night');
}));
assert.equal(allCalls.find((call) => call.url.hostname === 'api.pexels.com')?.url.searchParams.get('orientation'), 'square');
assert.equal(allCalls.find((call) => call.url.hostname === 'pixabay.com')?.url.searchParams.get('orientation'), null);
assert.equal(allCalls.find((call) => call.url.hostname === 'api.unsplash.com')?.url.searchParams.get('orientation'), 'squarish');

const musicCalls: FetchCall[] = [];
const musicResponse = await searchStockMedia(allKeys, {
  query: 'piano', category: 'ambient', kind: 'music', platforms: 'freesound',
}, createProviderFetch(musicCalls));
assert.equal(musicResponse.results[0]?.kind, 'audio');
assert.equal(musicCalls[0]?.url.searchParams.get('query'), 'piano ambient');
assert.equal(musicCalls[0]?.url.searchParams.get('filter'), 'tag:music');

const legacyCalls: FetchCall[] = [];
await searchStockMedia(allKeys, {
  query: 'forest', kind: 'video', orientation: 'landscape', platforms: 'pexels', limitPerPlatform: 99,
}, createProviderFetch(legacyCalls));
assert.equal(legacyCalls[0]?.url.searchParams.get('orientation'), 'landscape');
assert.equal(legacyCalls[0]?.url.searchParams.get('per_page'), '6');

const failureCalls: FetchCall[] = [];
const partialResponse = await searchStockMedia(allKeys, {
  query: 'city', kind: 'image', platforms: 'pexels,pixabay',
}, createProviderFetch(failureCalls, true));
assert.equal(partialResponse.results.length, 1);
assert(partialResponse.warnings.some((warning) => warning.includes('pexels/image') && warning.includes('503')));

const unsupportedResponse = await searchStockMedia(allKeys, {
  query: 'waves', kind: 'video', platforms: 'unsplash',
}, createProviderFetch([]));
assert.equal(unsupportedResponse.configured, false);
assert.deepEqual(unsupportedResponse.results, []);
assert(unsupportedResponse.warnings.some((warning) => warning.includes('不支持 video')));

// No key-gated provider configured → audio (freesound) is off.
const noKeysResponse = await searchStockMedia({ pexelsApiKey: '', pixabayApiKey: '' }, {
  query: 'waves', kind: 'music',
}, createProviderFetch([]));
assert.equal(noKeysResponse.configured, false);
assert.deepEqual(noKeysResponse.results, []);
assert(noKeysResponse.warnings.length >= 1);

// Wikimedia is keyless → stock search is usable even with zero API keys.
const keylessWiki = await searchStockMedia({}, {
  query: 'nato', kind: 'image', platforms: 'wikimedia',
}, createProviderFetch([]));
assert.equal(keylessWiki.configured, true);
assert.equal(keylessWiki.results[0]?.platform, 'wikimedia');
assert.equal(keylessWiki.results[0]?.license, 'PD');

const firecrawlCalls: FetchCall[] = [];
const firecrawlFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  firecrawlCalls.push({ url, init });
  return json({ data: { images: [{
    title: 'Pexels City', url: 'https://pexels.com/photo/1', imageUrl: 'https://images.pexels.com/a.jpg',
    imageWidth: 1600, imageHeight: 900,
  }] } });
}) as typeof fetch;
const firecrawlResponse = await searchStockMedia({
  pexelsApiKey: '', pixabayApiKey: '', firecrawlApiKey: 'firecrawl-key',
}, {
  query: 'city', kind: 'image', platforms: 'pexels', orientation: 'horizontal',
}, firecrawlFetch);
assert.equal(firecrawlResponse.configured, true);
assert.equal(firecrawlResponse.results[0]?.platform, 'pexels');
const firecrawlPayload = JSON.parse(String(firecrawlCalls[0]?.init?.body)) as { includeDomains: string[] };
assert.deepEqual(firecrawlPayload.includeDomains, ['pexels.com']);

const emptyResponse = await searchStockMedia({ pexelsApiKey: 'key', pixabayApiKey: '' }, {
  query: 'nothing', kind: 'image', platforms: 'pexels',
}, (async () => json({ photos: [] })) as typeof fetch);
assert.equal(emptyResponse.configured, true);
assert.deepEqual(emptyResponse.results, []);

// ── DVIDS: keywords retry (long query → empty, shorter form → hits) + HLS strip ──
const dvidsCalls: FetchCall[] = [];
const dvidsRetryFetch = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  dvidsCalls.push({ url });
  const kw = url.searchParams.get('keywords') ?? '';
  // DVIDS `keywords` is exact-ish: the full 4-token form returns nothing; the 2-token form hits.
  if (kw === 'navy ship exercise training') return json({ results: [] });
  return json({ results: [{
    title: 'RIMPAC', credit: 'U.S. Navy', unit_name: 'Pacific Fleet', branch: 'Navy',
    download_url: '', files: [], hls_url: 'https://api.dvidshub.net/m/video.m3u8?api_key=secret',
    duration: '00:02:00', thumbnail: 'https://cdn.dvidshub.net/t.jpg',
  }] });
}) as typeof fetch;
const dvidsResponse = await searchStockMedia({ dvidsApiKey: 'dvids-key' }, {
  query: 'navy ship exercise training', kind: 'video', platforms: 'dvids',
}, dvidsRetryFetch);
assert.equal(dvidsResponse.results.length, 1);
assert.equal(dvidsResponse.results[0]?.license, 'PD-USGov');
assert.equal(dvidsResponse.results[0]?.verified, true);
assert.equal(dvidsResponse.results[0]?.importUrl, 'https://api.dvidshub.net/m/video.m3u8', 'api_key stripped from HLS url');
assert.ok(dvidsCalls.length >= 2, 'keywords retry should fire a shorter form after the long one returns 0');

// DVIDS contractor block (Reuters/AP/Getty masquerading on a gov platform).
const dvidsContractor = await searchStockMedia({ dvidsApiKey: 'dvids-key' }, {
  query: 'press', kind: 'video', platforms: 'dvids',
}, (async () => json({ results: [{
  title: 'Wire', credit: 'Courtesy of Reuters', hls_url: 'https://api.dvidshub.net/m/x.m3u8?api_key=k',
}] })) as typeof fetch);
assert.equal(dvidsContractor.results.length, 0, 'Reuters contractor clip must be dropped');

// DVIDS prefers a real mp4 (download_url or files[].mp4) over the HLS fallback.
const dvidsMp4 = await searchStockMedia({ dvidsApiKey: 'dvids-key' }, {
  query: 'mp4', kind: 'video', platforms: 'dvids',
}, (async () => json({ results: [{
  title: 'Direct', credit: 'U.S. Air Force',
  download_url: '',
  files: [{ url: 'https://api.dvidshub.net/files.mp4' }],
  hls_url: 'https://api.dvidshub.net/m/hls.m3u8?api_key=k',
  duration: '00:00:10',
}] })) as typeof fetch);
assert.equal(dvidsMp4.results[0]?.importUrl, 'https://api.dvidshub.net/files.mp4');

// ── Wikimedia: .ogv dropped, CC-BY-SA blocked, PD kept ───────────────────────
function wikiFetch(results: Array<{ url: string; mime: string; license: string; artist: string }>): typeof fetch {
  return (async () => {
    const pages: Record<string, unknown> = {};
    results.forEach((r, i) => {
      pages[String(i)] = {
        title: `File:${i}`,
        imageinfo: [{
          url: r.url, width: 100, height: 100, mime: r.mime,
          extmetadata: { LicenseShortName: { value: r.license }, Artist: { value: r.artist } },
        }],
      };
    });
    return json({ query: { pages } });
  }) as typeof fetch;
}
const wikiVideo = await searchStockMedia({}, {
  query: 'nato', kind: 'video', platforms: 'wikimedia',
}, wikiFetch([
  { url: 'https://upload.wikimedia.org/a/ogv.ogv', mime: 'video/ogg', license: 'Public domain', artist: '' }, // theora dropped
  { url: 'https://upload.wikimedia.org/a/nato.webm', mime: 'video/webm', license: 'Public domain', artist: 'U.S. Navy photo' }, // PD kept
  { url: 'https://upload.wikimedia.org/a/x.webm', mime: 'video/webm', license: 'CC BY-SA 4.0', artist: 'X' }, // ShareAlike blocked
]));
assert.equal(wikiVideo.results.length, 1);
assert.equal(wikiVideo.results[0]?.importUrl, 'https://upload.wikimedia.org/a/nato.webm');
assert.equal(wikiVideo.results[0]?.license, 'PD');

const wikiImage = await searchStockMedia({}, {
  query: 'flag', kind: 'image', platforms: 'wikimedia',
}, wikiFetch([
  { url: 'https://upload.wikimedia.org/a/svg.svg', mime: 'image/svg+xml', license: 'Public domain', artist: '' }, // svg dropped
  { url: 'https://upload.wikimedia.org/a/flag.png', mime: 'image/png', license: 'CC BY 4.0', artist: 'Gov' }, // CC-BY kept
]));
assert.equal(wikiImage.results.length, 1);
assert.equal(wikiImage.results[0]?.kind, 'image');
assert.equal(wikiImage.results[0]?.license, 'CC-BY');

// ── agent tool wiring ────────────────────────────────────────────────────────
const stockSchema = STOCK_TOOL_SCHEMAS.find((tool) => tool.name === 'search_stock_media');
assert(stockSchema);
const stockProperties = stockSchema.input_schema.properties as Record<string, Record<string, unknown>>;
assert.deepEqual(stockProperties.kind?.enum, ['any', 'video', 'audio', 'music', 'image']);
assert.equal(stockProperties.limitPerPlatform?.minimum, 1);
assert.equal(stockProperties.limitPerPlatform?.maximum, 6);
assert(String(stockProperties.platforms?.description).includes('dvids'));
assert(String(stockProperties.platforms?.description).includes('searxng'));

const originalFetch = globalThis.fetch;
let agentRequest: URL | undefined;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  agentRequest = new URL(String(input), 'http://localhost');
  return json({
    configured: true,
    results: [],
    warnings: ['provider warning'],
    searchedPlatforms: ['freesound'],
  });
}) as typeof fetch;
try {
  const agentResponse = await execStockTool('search_stock_media', {
    query: 'piano', kind: 'music', category: 'ambient', orientation: 'vertical',
    platforms: ['freesound'], limitPerPlatform: 4,
  }, {} as AgentContext) as { warnings?: string[]; searchedPlatforms?: string[] };
  assert.equal(agentRequest?.searchParams.get('kind'), 'music');
  assert.equal(agentRequest?.searchParams.get('category'), 'ambient');
  assert.equal(agentRequest?.searchParams.get('orientation'), 'vertical');
  assert.equal(agentRequest?.searchParams.get('platforms'), 'freesound');
  assert.equal(agentRequest?.searchParams.get('limitPerPlatform'), '4');
  assert.deepEqual(agentResponse.warnings, ['provider warning']);
  assert.deepEqual(agentResponse.searchedPlatforms, ['freesound']);
} finally {
  globalThis.fetch = originalFetch;
}

// ── SearXNG (self-hosted meta-search; Google+Bing image search) ──────────────
function searxngFetch(results: Array<{ img_src?: string; image?: string; url?: string; title?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    searxngCalls.push({ url });
    // SearXNG serves /search?format=json with a top-level `results` array.
    return json({ results });
  }) as typeof fetch;
}
const searxngCalls: FetchCall[] = [];
const searxngGood = await searchStockMedia({ searxngUrl: 'http://localhost:8080' }, {
  query: 'iranian frigate', kind: 'image', platforms: 'searxng',
}, searxngFetch([
  { img_src: 'https://news.example/frigate.jpg', title: 'Iranian frigate' }, // kept (clean raster host)
  { img_src: 'https://c1.staticflickr.com/x/abc.jpg' },                      // kept (flickr CDN)
  { img_src: 'https://www.alamy.com/thumb.jpg' },                            // dropped (stock-agency watermark)
  { img_src: 'https://cdn.jsdelivr.net/icon.svg' },                          // dropped (icon host + svg)
  { img_src: 'https://www.merriam-webster.com/word.jpg' },                   // dropped (dictionary non-visual host)
  { img_src: 'https://example.com/page.html' },                              // dropped (not a raster extension)
  { img_src: 'https://example.com/anim.gif' },                               // dropped (gif rejected)
]));
assert.equal(searxngGood.configured, true);
assert.equal(searxngGood.results.length, 2, 'only clean raster-photo hosts pass (alamy/jsdelivr/merriam-webster/html/gif dropped)');
assert.equal(searxngGood.results[0]?.platform, 'searxng');
assert.equal(searxngGood.results[0]?.kind, 'image');
assert.equal(searxngGood.results[0]?.license, 'PD');
assert.equal(searxngGood.results[0]?.verified, false);
assert.equal(searxngGood.results[0]?.importUrl, 'https://news.example/frigate.jpg');
assert.equal(searxngGood.results[1]?.importUrl, 'https://c1.staticflickr.com/x/abc.jpg');
assert.deepEqual(searxngGood.searchedPlatforms, ['searxng']);
assert.equal(searxngCalls[0]?.url.pathname, '/search');
assert.equal(searxngCalls[0]?.url.searchParams.get('categories'), 'images');
assert.equal(searxngCalls[0]?.url.searchParams.get('format'), 'json');
assert.equal(searxngCalls[0]?.url.searchParams.get('q'), 'iranian frigate');

// SearXNG without SEARXNG_URL configured → not configured + actionable warning.
const searxngUnset = await searchStockMedia({}, {
  query: 'frigate', kind: 'image', platforms: 'searxng',
}, searxngFetch([]));
assert.equal(searxngUnset.configured, false);
assert.deepEqual(searxngUnset.results, []);
assert(searxngUnset.warnings.some((w) => w.includes('SearXNG URL not configured')));

// SearXNG is image-only — a video request to it is skipped (unsupported kind).
const searxngVideo = await searchStockMedia({ searxngUrl: 'http://localhost:8080' }, {
  query: 'frigate', kind: 'video', platforms: 'searxng',
}, searxngFetch([{ img_src: 'https://news.example/x.jpg' }]));
assert.equal(searxngVideo.configured, false);
assert.deepEqual(searxngVideo.results, []);

console.log('stock search filters verified (pexels, pixabay, unsplash, freesound, dvids, wikimedia, searxng + license gate)');
