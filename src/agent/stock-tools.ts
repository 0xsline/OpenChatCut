import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import type { MediaAsset } from '../editor/types';

// 在线素材导入（source push_asset/download_media + search_stock_media）：
// import_url_asset 把任意公网 URL 登记为工程资产，无需 key；search_stock_media
// 搜 Pexels/Pixabay，结果里的 importUrl 再喂给 import_url_asset。

type Args = Record<string, unknown>;

export const STOCK_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'import_url_asset',
    description: 'Register a public http(s) media URL (video/image/audio) as a project media asset — works with no API key. Use for a URL the user pastes directly, or an importUrl chosen from search_stock_media results.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public http(s) URL of the media file.' },
        name: { type: 'string', description: 'Display name; defaults to the URL filename.' },
        kind: { type: 'string', enum: ['video', 'image', 'audio'], description: 'Override kind detection when the URL extension is ambiguous.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'search_stock_media',
    description: 'Search stock media libraries (Pexels/Pixabay) by keyword and return a unified result list with direct import URLs. Requires a server-configured API key — if unavailable, returns an error hint to use import_url_asset directly instead. On success, pick a result and pass its importUrl to import_url_asset to add it to the project.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kind: { type: 'string', enum: ['image', 'video'], description: 'Default video.' },
        orientation: { type: 'string', enum: ['landscape', 'portrait', 'square'] },
        limitPerPlatform: { type: 'number', description: 'Max results per platform (default 5).' },
      },
      required: ['query'],
    },
  },
];

export const STOCK_TOOL_NAMES = new Set(STOCK_TOOL_SCHEMAS.map((tool) => tool.name));

const IMAGE_SECONDS = 3; // still image default on-screen duration fallback
const CLIP_SECONDS = 5; // unknown-duration video/audio fallback
const PROBE_TIMEOUT_MS = 8000;

const EXT_KIND: Record<string, MediaAsset['kind']> = {
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video', avi: 'video',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', flac: 'audio',
};

function sniffKind(url: string): MediaAsset['kind'] | null {
  const clean = url.split('?')[0].split('#')[0];
  const base = clean.split('/').filter(Boolean).pop() ?? '';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return ext ? (EXT_KIND[ext] ?? null) : null;
}

function nameFromUrl(url: string): string {
  const clean = url.split('?')[0].split('#')[0];
  const base = clean.split('/').filter(Boolean).pop();
  if (!base) return url;
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function fallbackDuration(kind: MediaAsset['kind'], fps: number): number {
  return Math.round((kind === 'image' ? IMAGE_SECONDS : CLIP_SECONDS) * fps);
}

interface ProbeResult {
  durationInFrames: number;
  width?: number;
  height?: number;
}

// 复用 src/media/upload.ts 的探测思路：起一个隐藏 <video>/<img>/<audio> 读时长
// + 原始宽高；超时/失败/无 DOM（headless check 环境）一律回退默认值，不阻断导入。
function probeUrl(url: string, kind: MediaAsset['kind'], fps: number): Promise<ProbeResult> {
  const fallback: ProbeResult = { durationInFrames: fallbackDuration(kind, fps) };
  if (typeof document === 'undefined') return Promise.resolve(fallback);

  if (kind === 'image') {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: ProbeResult) => { if (!done) { done = true; resolve(result); } };
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => finish({ durationInFrames: fallbackDuration('image', fps), width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => finish(fallback);
      img.src = url;
      setTimeout(() => finish(fallback), PROBE_TIMEOUT_MS);
    });
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (result: ProbeResult) => { if (!done) { done = true; resolve(result); } };
    const el = document.createElement(kind === 'video' ? 'video' : 'audio') as HTMLVideoElement;
    el.preload = 'metadata';
    el.crossOrigin = 'anonymous';
    el.onloadedmetadata = () => {
      const durationInFrames = Math.max(1, Math.round((el.duration || CLIP_SECONDS) * fps));
      finish({ durationInFrames, width: kind === 'video' ? el.videoWidth : undefined, height: kind === 'video' ? el.videoHeight : undefined });
    };
    el.onerror = () => finish(fallback);
    el.src = url;
    setTimeout(() => finish(fallback), PROBE_TIMEOUT_MS);
  });
}

const newId = (): string => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `a_${Date.now()}`;

interface StockSearchResponse {
  configured?: boolean;
  results?: unknown[];
}

async function execImportUrlAsset(args: Args, ctx: AgentContext): Promise<unknown> {
  const url = String(args.url ?? '').trim();
  if (!isHttpUrl(url)) return { error: 'url must be a public http(s) URL' };

  const kindArg = args.kind;
  const kind = kindArg === 'video' || kindArg === 'image' || kindArg === 'audio' ? kindArg : sniffKind(url);
  if (!kind) return { error: '无法从 URL 识别媒体类型，请传 kind: video|image|audio' };

  const fps = ctx.getState().fps;
  let meta: ProbeResult;
  try {
    meta = await probeUrl(url, kind, fps);
  } catch {
    meta = { durationInFrames: fallbackDuration(kind, fps) };
  }

  const asset: MediaAsset = {
    id: newId(),
    name: String(args.name ?? '').trim() || nameFromUrl(url),
    kind,
    src: url,
    durationInFrames: meta.durationInFrames,
    width: meta.width,
    height: meta.height,
  };
  ctx.commands.addAsset(asset);
  return { ok: true, asset: { id: asset.id, name: asset.name, kind: asset.kind, durationInFrames: asset.durationInFrames } };
}

async function execSearchStockMedia(args: Args): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  if (!query) return { error: 'query is required', results: [] };
  const kind = args.kind === 'image' ? 'image' : 'video';

  const params = new URLSearchParams({ query, kind });
  if (args.orientation) params.set('orientation', String(args.orientation));
  if (args.limitPerPlatform) params.set('limitPerPlatform', String(args.limitPerPlatform));

  try {
    const res = await fetch(`/api/stock-search?${params.toString()}`);
    if (!res.ok) return { error: `素材库搜索失败 (${res.status})`, results: [] };
    const body = await res.json() as StockSearchResponse;
    if (!body.configured) {
      return { error: '未配置素材库 API key（PEXELS_API_KEY / PIXABAY_API_KEY），可改用 import_url_asset 直接导入 URL', results: [] };
    }
    return { results: body.results ?? [] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'stock search request failed', results: [] };
  }
}

export async function execStockTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'import_url_asset') return execImportUrlAsset(args, ctx);
  if (name === 'search_stock_media') return execSearchStockMedia(args);
  return { error: `unknown tool ${name}` };
}
