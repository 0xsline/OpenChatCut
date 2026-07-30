import type { AgentToolSchema } from '../../tool-schema';

const FORMAT_ENUM = [
  'markdown', 'html', 'rawHtml', 'images', 'links',
  'branding', 'summary', 'screenshot', 'videos',
] as const;

export const WEB_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'web_browser',
    description: [
      'Scrape a single web page via Firecrawl (web_browser → Firecrawl /scrape).',
      'formats: markdown (default), html, rawHtml, images, links, branding, summary, screenshot, videos.',
      'branding = native brand kit (colors/fonts/logo); summary = native page summary.',
      'screenshot is auto-saved to media pool as screenshotAssetId when possible.',
      'For many known URLs use web_batch_scrape; site discovery use web_map; multi-page crawl use web_crawl; search use web_search.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page URL (http/https).' },
        formats: {
          type: 'array',
          items: { type: 'string', enum: [...FORMAT_ENUM] },
          description: "Default ['markdown'].",
        },
        onlyMainContent: { type: 'boolean', description: 'Strip nav/footer (default true).' },
        fullPage: { type: 'boolean', description: 'Full-page screenshot when format includes screenshot.' },
        waitFor: { type: 'number', description: 'ms wait before extract (0–10000).' },
        timeout: { type: 'number', description: 'Timeout ms (max 60000).' },
        country: { type: 'string', description: "Geo country code e.g. 'US'." },
        query: { type: 'string', description: 'NL structured-extraction prompt.' },
        schema: { description: 'JSON schema for structured extraction.' },
        actions: {
          type: 'array',
          description: 'Firecrawl page actions before scrape (click/wait/scroll/…), max 10.',
          items: {},
        },
        execJs: { type: 'string', description: 'JS to run before extract (max 10000 chars).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    description: [
      'Search the web via Firecrawl /search (official API). Returns titles, URLs, descriptions;',
      'by default also scrapes markdown for each hit (scrapeMarkdown=true).',
      'Use site: / filetype: operators in query when helpful. Prefer this to inventing URLs.',
      'Then web_browser a specific URL for deep scrape/screenshot.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (supports operators like site:example.com).' },
        limit: { type: 'number', description: 'Max results 1–20 (default 5).' },
        country: { type: 'string', description: "ISO country e.g. 'US' (default US on Firecrawl)." },
        lang: { type: 'string', description: 'Language code if supported by provider.' },
        tbs: {
          type: 'string',
          description: 'Time filter e.g. qdr:d (day), qdr:w (week), qdr:m (month), qdr:y (year).',
        },
        scrapeMarkdown: {
          type: 'boolean',
          description: 'If true (default), include markdown for each result via scrapeOptions.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_map',
    description: [
      'Discover URLs on a website via Firecrawl /map (official API). Fast sitemap+link discovery,',
      'does NOT download full page bodies. Use search to rank by path relevance.',
      'Then web_browser or web_crawl selected URLs for content.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Base site URL to map.' },
        search: { type: 'string', description: 'Optional path/keyword to rank results (e.g. blog).' },
        limit: { type: 'number', description: 'Max links 1–500 (default 100).' },
        includeSubdomains: { type: 'boolean', description: 'Include subdomains (default true).' },
        ignoreQueryParameters: { type: 'boolean', description: 'Drop ?query URLs (default true).' },
        sitemap: {
          type: 'string',
          enum: ['skip', 'include', 'only'],
          description: 'Sitemap mode: skip | include (default) | only.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_crawl',
    description: [
      'Crawl multiple pages from a start URL via Firecrawl /crawl (official API).',
      'Starts a job and waits (polls) until completed or maxWaitMs.',
      'Returns truncated markdown per page. Keep limit small (default 10, max 50).',
      'For one page use web_browser; for URL list only use web_map.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Start URL.' },
        limit: { type: 'number', description: 'Max pages 1–50 (default 10).' },
        maxDiscoveryDepth: {
          type: 'number',
          description: 'Max discovery depth 0–5 (alias maxDepth).',
        },
        maxDepth: { type: 'number', description: 'Alias of maxDiscoveryDepth.' },
        includePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pathname regex patterns to include (e.g. blog/.*).',
        },
        excludePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pathname regex patterns to exclude.',
        },
        allowSubdomains: { type: 'boolean', description: 'Follow subdomains (default false).' },
        crawlEntireDomain: {
          type: 'boolean',
          description: 'Follow sibling/parent internal links, not only children (default false).',
        },
        maxWaitMs: {
          type: 'number',
          description: 'Max wait for crawl job ms (default 90000, max 180000).',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_batch_scrape',
    description: [
      'Batch-scrape multiple known URLs via Firecrawl /batch/scrape (official v2 API).',
      'Starts a job and waits (polls) until completed or maxWaitMs.',
      'Max 15 URLs per call. formats: markdown (default), summary, branding, links, html.',
      'Use when you already have a list of URLs (e.g. from web_search or web_map).',
      'For one page use web_browser; for discovering URLs from a seed use web_crawl or web_map.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of page URLs to scrape (1–15).',
        },
        formats: {
          type: 'array',
          items: { type: 'string', enum: [...FORMAT_ENUM] },
          description: "Default ['markdown']. Prefer markdown, summary, branding for agents.",
        },
        onlyMainContent: { type: 'boolean', description: 'Strip nav/footer (default true).' },
        maxWaitMs: {
          type: 'number',
          description: 'Max wait for batch job ms (default 90000, max 180000).',
        },
      },
      required: ['urls'],
    },
  },
];

export const WEB_TOOL_NAMES = new Set(WEB_TOOL_SCHEMAS.map((t) => t.name));
