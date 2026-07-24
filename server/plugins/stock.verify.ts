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
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

const allKeys: StockPluginOptions = {
  pexelsApiKey: 'pexels-key',
  pixabayApiKey: 'pixabay-key',
  unsplashAccessKey: 'unsplash-key',
  freesoundApiKey: 'freesound-key',
};

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

const allCalls: FetchCall[] = [];
const allResponse = await searchStockMedia(allKeys, {
  query: 'tokyo', category: 'night', kind: 'any', orientation: 'square', limitPerPlatform: 2,
}, createProviderFetch(allCalls));
assert.equal(allResponse.configured, true);
assert.deepEqual(allResponse.searchedPlatforms, ['pexels', 'pixabay', 'unsplash', 'freesound']);
assert.equal(allResponse.results.length, 5, 'cross-provider duplicate URLs should be removed');
assert(allResponse.results.some((result) => result.kind === 'video'));
assert(allResponse.results.some((result) => result.kind === 'audio'));
assert(allResponse.warnings.some((warning) => warning.includes('Pixabay') && warning.includes('Square')));
assert(allCalls.every((call) => call.url.searchParams.get('query') === 'tokyo night' || call.url.searchParams.get('q') === 'tokyo night'));
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
assert(unsupportedResponse.warnings.some((warning) => warning.includes('Not supported video')));

const noKeysResponse = await searchStockMedia({ pexelsApiKey: '', pixabayApiKey: '' }, {
  query: 'waves', kind: 'any',
}, createProviderFetch([]));
assert.equal(noKeysResponse.configured, false);
assert.deepEqual(noKeysResponse.results, []);
assert(noKeysResponse.warnings.length >= 4);

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

const stockSchema = STOCK_TOOL_SCHEMAS.find((tool) => tool.name === 'search_stock_media');
assert(stockSchema);
const stockProperties = stockSchema.input_schema.properties as Record<string, Record<string, unknown>>;
assert.deepEqual(stockProperties.kind?.enum, ['any', 'video', 'audio', 'music', 'image']);
assert.equal(stockProperties.limitPerPlatform?.minimum, 1);
assert.equal(stockProperties.limitPerPlatform?.maximum, 6);

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

console.log('stock search filters verified');
