import type { AgentToolSchema } from '../../tool-schema';

const MEDIA_TYPE_ENUM = ['audio', 'gif', 'image', 'svg', 'video'] as const;
const PUSH_TYPE_ENUM = [
  'audio', 'effect', 'gif', 'image', 'motion-graphic', 'svg', 'transition', 'video',
] as const;

export const STOCK_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'download_media',
    description: [
      'Download a media file from a public URL into the project media pool.',
      'Accepts a single url or array of urls (up to 4). Type inferred from extension / Content-Type; pass type to override.',
      'Local-dev: server fetches bytes into /media/uploads (S3 stand-in). Returns { failed, succeeded, results } like push_asset.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        url: {
          // Accept one URI or an array of up to four URIs.
          anyOf: [
            { type: 'string', format: 'uri' },
            { type: 'array', items: { type: 'string', format: 'uri' } },
          ],
          description: 'HTTP(S) URL or array of URLs (up to 4 total).',
        },
        name: {
          type: 'string',
          description: 'Override display name. Ignored for batch (>1 url).',
        },
        type: {
          type: 'string',
          enum: [...MEDIA_TYPE_ENUM],
          description: 'Asset type override; auto-detected from Content-Type / URL extension when omitted.',
        },
        projectId: {
          type: 'string',
          description: 'Ignored because OpenChatCut uses the active project.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'push_asset',
    description: [
      'Register a public http(s) media URL as a project asset.',
      'filePath = public URL (string or array, up to 4). Local-dev downloads into /media/uploads when possible.',
      'type may be motion-graphic (with duration / durationInFrames / properties). effect/transition types are not pool media here.',
      'Do NOT pass local filesystem paths. Returns { failed, succeeded, results: [{ assetId, name, type, success } | { error, success:false }] }.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        filePath: {
          description: 'Public http(s) media URL or array of URLs (up to 4). Local paths are not accepted.',
        },
        name: {
          type: 'string',
          description: 'Override display name. Ignored for batch (>1 filePath).',
        },
        type: {
          type: 'string',
          enum: [...PUSH_TYPE_ENUM],
          description: 'Asset type override; auto-detected from extension when omitted.',
        },
        duration: {
          type: 'number',
          description: 'Duration in seconds (motion-graphic if durationInFrames omitted; also media fallback).',
        },
        durationInFrames: {
          type: 'number',
          description: 'Duration in frames at timeline fps (motion-graphic alternative to duration).',
        },
        width: { type: 'number' },
        height: { type: 'number' },
        properties: {
          type: 'array',
          description: 'Motion-graphic editable properties (objects with key, label, type, defaultValue).',
          items: {},
        },
        projectId: {
          type: 'string',
          description: 'Ignored because OpenChatCut uses the active project.',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'import_url_asset',
    description: [
      'Legacy alias of push_asset: register a public http(s) media URL as a project asset.',
      'Prefer download_media to fetch into the library or push_asset to register a URL. Same local behaviour.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public http(s) URL of the media file.' },
        name: { type: 'string', description: 'Display name; defaults to the URL filename.' },
        kind: {
          type: 'string',
          enum: ['video', 'image', 'audio'],
          description: 'Override kind detection when the URL extension is ambiguous.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'search_stock_media',
    description: [
      'Search curated stock platforms for B-roll, photos, sounds, or music; returns unified results with importUrl.',
      'kind=any|video|audio|music|image (default video). platforms is an optional comma-separated provider list.',
      'Use category to narrow intent and horizontal|square|vertical for orientation; legacy orientation names remain accepted.',
      'Unsupported provider/type combinations are skipped with warnings. Official keys are preferred; eligible visual searches can use Firecrawl fallback.',
      'On success, pass a result importUrl to download_media or push_asset.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        category: {
          type: 'string',
          description: 'Optional category, such as business, nature, technology, whoosh, piano, or ambient.',
        },
        kind: {
          type: 'string',
          enum: ['any', 'video', 'audio', 'music', 'image'],
          description: 'Default video. music searches Freesound and returns importable audio results.',
        },
        orientation: {
          type: 'string',
          enum: ['horizontal', 'square', 'vertical', 'landscape', 'portrait', 'squarish'],
          description: 'Preferred horizontal|square|vertical; legacy landscape|portrait|squarish values are accepted.',
        },
        platforms: {
          type: 'string',
          description: 'Optional comma-separated list: pexels,pixabay,unsplash,freesound.',
        },
        limitPerPlatform: {
          type: 'integer',
          minimum: 1,
          maximum: 6,
          default: 3,
          description: 'Max results per platform and media type.',
        },
      },
      required: ['query'],
    },
  },
];

export const STOCK_TOOL_NAMES = new Set(STOCK_TOOL_SCHEMAS.map((tool) => tool.name));
