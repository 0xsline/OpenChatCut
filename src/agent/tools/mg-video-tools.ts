import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../context';
import type { MediaAsset, TimelineItem } from '../../editor/types';
import { bakeClipToVideo, bakeClipToAlphaWebm, exportClipMov } from '../../media/clipExport';
import { fetchRenderJob } from './export-tools';

// convert_motion_graphic_to_video + register_converted_video.
// Flow: convert 云渲 MG 原长 → renderId → track_export 等完成 →
// register_converted_video 把产物注册为媒体池 video 资产;同 MG 去重到同一 asset。
//
// 本地实现:/render-clip 端点(renderClip)与 clipExport.bakeClipToVideo 已在,渲染是
// 同步的,故 convert 一步渲染+注册(返回 assetId);register 单独暴露,供导入外部已渲产物。
// 透明:MG/text/svg 这类带 alpha 的片段,先本地渲透明 ProRes,再进 e2b 沙箱转 VP9 alpha
// webm 入池(「转为视频 = alpha webm」);沙箱不可用/失败则优雅回退不透明 h264。
// 不透明 raster(video/image/gif)本就无 alpha,直接 h264。

type Args = Record<string, unknown>;

// Clip kinds that carry transparency worth preserving when baked (MG/vector/text).
const ALPHA_CAPABLE = new Set(['motion-graphic', 'text', 'svg']);

export const MG_VIDEO_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'convert_motion_graphic_to_video',
    description:
      'Bake a motion-graphic (or any non-audio clip) on the timeline into a real video asset in the media pool, so it can be reused/exported like footage. Renders the clip full-length via the headless renderer. Transparent MG/text/svg clips bake to a VP9 alpha WebM (transparency preserved, via the sandbox) so they composite over other clips; if the sandbox is unavailable it falls back to opaque h264. Raster clips (video/image/gif) bake to opaque h264. Pass opaque:true to force flatten, replace:true to also swap the source clip in place. Identify the clip by itemId (preferred) or assetId.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Timeline clip id (prefix ok) to convert. Preferred.' },
        assetId: { type: 'string', description: 'Fallback: convert the first placed clip that references this asset/template id.' },
        replace: { type: 'boolean', description: 'Also replace the source clip in place with the baked video (default false = only add to media pool).' },
        opaque: { type: 'boolean', description: 'Force an opaque h264 bake even for MG/text/svg (skip the transparent VP9 webm path).' },
      },
    },
  },
  {
    name: 'register_converted_video',
    description:
      'Import a finished MG→video render as a video asset in the media pool — step 2 of the MG→video convert flow. After track_export reports the render complete, call this with the renderId (preferred) to promote the render output into the media pool as a real video asset; the local backend resolves the output itself, no download URL needed. outputUrl is only a fallback when a renderId is unavailable. Returns the video asset id (re-running dedupes to the same asset). Afterwards place the video with edit_item (add a video item referencing the returned videoAssetId).',
    input_schema: {
      type: 'object',
      properties: {
        mgAssetId: { type: 'string', description: 'Source motion-graphic asset id (the mgAssetId of the converted clip).' },
        renderId: { type: 'string', description: 'The convert render id (preferred; pass it once track_export reports the render complete).' },
        outputUrl: { type: 'string', description: 'Raw render output URL — only as a fallback when a renderId is unavailable.' },
        name: { type: 'string', description: 'Display name for the media-pool asset (defaults to "<MG name> (video)").' },
        durationInFrames: { type: 'number', description: 'Duration in frames (defaults to the source MG length if omitted).' },
      },
      required: ['mgAssetId'],
    },
  },
  {
    name: 'export_motion_graphic_prores',
    description:
      'Export motion-graphic clip(s) as transparent ProRes 4444 .mov file(s) (alpha preserved) — the NLE hand-off format, downloaded in the browser. Use before an XML export so the timeline can reference already-rendered MG media. Identify by itemId(s) (preferred) or assetId(s); batch exports each. Unlike convert_motion_graphic_to_video (opaque h264 into the pool), this keeps alpha and downloads a .mov.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'MG timeline item id (prefix ok). Preferred.' },
        itemIds: { type: 'array', items: { type: 'string' }, description: 'Batch: several MG item ids/prefixes.' },
        assetId: { type: 'string', description: 'MG asset id/prefix — exports its first placed timeline instance.' },
        assetIds: { type: 'array', items: { type: 'string' }, description: 'Batch: several MG asset ids/prefixes.' },
        name: { type: 'string', description: 'Optional base filename (single export); ".mov" is appended.' },
      },
    },
  },
];

export const MG_VIDEO_TOOL_NAMES = new Set(MG_VIDEO_TOOL_SCHEMAS.map((t) => t.name));

const uid = () => `asset_${crypto.randomUUID()}`;

/** locate the clip to convert: itemId prefix first, else first item referencing assetId. */
function findClip(ctx: AgentContext, args: Args): TimelineItem | null {
  const items = ctx.getState().items;
  const itemId = typeof args.itemId === 'string' ? args.itemId.trim() : '';
  if (itemId) return items.find((it) => it.id === itemId || it.id.startsWith(itemId)) ?? null;
  const assetId = typeof args.assetId === 'string' ? args.assetId.trim() : '';
  if (assetId) return items.find((it) => it.templateId === assetId || it.src === assetId) ?? null;
  return null;
}

async function convert(args: Args, ctx: AgentContext): Promise<unknown> {
  const item = findClip(ctx, args);
  if (!item) return { error: 'no clip found; pass itemId (preferred) or assetId' };
  if (item.kind === 'audio') return { error: 'audio clips have no video to bake; convert applies to motion-graphic/video/image clips' };

  const state = ctx.getState();
  const wantAlpha = ALPHA_CAPABLE.has(item.kind) && args.opaque !== true;

  let src: string;
  let transparent = false;
  let fallbackNote: string | undefined;
  try {
    if (wantAlpha) {
      // Transparent path: local ProRes render → e2b VP9-alpha transcode. Fall back to
      // opaque h264 if the sandbox is unavailable/fails, so convert never regresses.
      try {
        src = await bakeClipToAlphaWebm(state, item);
        transparent = true;
      } catch (alphaError) {
        src = await bakeClipToVideo(state, item);
        fallbackNote = `Transparent VP9-alpha bake unavailable (${alphaError instanceof Error ? alphaError.message : String(alphaError)}); baked OPAQUE h264 instead. Use export_motion_graphic_prores for a transparent .mov.`;
      }
    } else {
      src = await bakeClipToVideo(state, item);
    }
  } catch (e) {
    return { error: `render failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const asset: MediaAsset = {
    id: uid(),
    name: `${item.name || 'clip'} (video)`,
    kind: 'video',
    src,
    durationInFrames: item.durationInFrames,
    width: state.width,
    height: state.height,
  };
  ctx.commands.addAsset(asset);

  const replace = args.replace === true;
  if (replace) ctx.commands.replaceItemMedia(item.id, src); // swap the MG clip → baked video in place

  return {
    ok: true, assetId: asset.id, src, name: asset.name, durationInFrames: asset.durationInFrames, replaced: replace,
    transparent,
    codec: transparent ? 'vp9-alpha-webm' : 'h264',
    note: transparent
      ? 'Baked as TRANSPARENT VP9 alpha WebM (composites over other clips).'
      : (fallbackNote ?? 'Baked as OPAQUE h264. For a transparent MG over other clips, pass an MG/text/svg clip (auto VP9-alpha) or use export_motion_graphic_prores (.mov).'),
  };
}

/** Resolve the motion-graphic behind mgAssetId: pool asset, template, or placed clip. */
function resolveMgSource(ctx: AgentContext, q: string): { id: string; name: string; durationInFrames?: number } | null {
  const state = ctx.getState();
  // doc.assets is the authoritative pool; state.assets is only a derived view
  const assets = ctx.getDoc().assets ?? state.assets ?? [];
  const asset = assets.find((a) => a.id === q) ?? assets.find((a) => a.id.startsWith(q));
  if (asset) return { id: asset.id, name: asset.name, durationInFrames: asset.durationInFrames };
  const tpl = ctx.templates.find((t) => t.id === q) ?? ctx.templates.find((t) => t.id.startsWith(q));
  if (tpl) return { id: tpl.id, name: tpl.name, durationInFrames: tpl.durationInFrames };
  const item = state.items.find((it) => it.templateId === q || it.id === q)
    ?? state.items.find((it) => it.id.startsWith(q));
  if (item) return { id: item.templateId ?? item.id, name: item.name, durationInFrames: item.durationInFrames };
  return null;
}

// register_converted_video requires mgAssetId and prefers renderId.
// (resolved against the local render-job records once track_export reports complete);
// outputUrl only as a fallback when no renderId is available.
async function register(args: Args, ctx: AgentContext): Promise<unknown> {
  const mgQuery = typeof args.mgAssetId === 'string' ? args.mgAssetId.trim() : '';
  if (!mgQuery) return { error: 'mgAssetId is required (the source motion-graphic asset id)' };
  const mg = resolveMgSource(ctx, mgQuery);
  if (!mg) return { error: `no motion-graphic asset/template/clip matching "${mgQuery}"` };

  // renderId (preferred) → resolve the finished render's output from the local job records.
  let outputUrl = '';
  const renderId = typeof args.renderId === 'string' ? args.renderId.trim() : '';
  if (renderId) {
    const job = await fetchRenderJob(renderId);
    if (!('ok' in job)) return { error: job.error };
    if (!job.downloadUrl) {
      return { error: `render ${renderId} is not complete yet (status: ${job.status}); wait with track_export action=wait first, or pass outputUrl as a fallback` };
    }
    outputUrl = job.downloadUrl;
  } else {
    outputUrl = typeof args.outputUrl === 'string' ? args.outputUrl.trim() : '';
    if (!outputUrl) return { error: 'pass renderId (preferred, once track_export reports the render complete) or outputUrl as a fallback' };
    if (!/^(https?:\/\/|\/)/.test(outputUrl)) return { error: 'outputUrl must be a same-origin path (/media/…) or http(s) URL' };
  }

  // deterministic: re-running dedupes to the same video asset (matched by output src).
  const existing = (ctx.getDoc().assets ?? ctx.getState().assets ?? []).find((a) => a.kind === 'video' && a.src === outputUrl);
  if (existing) {
    return { ok: true, assetId: existing.id, videoAssetId: existing.id, mgAssetId: mg.id, name: existing.name, durationInFrames: existing.durationInFrames, deduped: true };
  }

  const dur = typeof args.durationInFrames === 'number' && Number.isFinite(args.durationInFrames) && args.durationInFrames > 0
    ? Math.round(args.durationInFrames)
    : mg.durationInFrames ?? ctx.getState().fps * 3; // MG length → else 3s placeholder
  const asset: MediaAsset = {
    id: uid(),
    name: (typeof args.name === 'string' && args.name.trim()) || `${mg.name} (video)`,
    kind: 'video',
    src: outputUrl,
    durationInFrames: dur,
  };
  ctx.commands.addAsset(asset);
  return { ok: true, assetId: asset.id, videoAssetId: asset.id, mgAssetId: mg.id, name: asset.name, durationInFrames: dur, next: `Place it with edit_item adds:[{type:"video",assetId:"${asset.id}"}], or delete the MG item and add the video in the same edit_item call to replace it.` };
}

const strs = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [])
    .map((s) => s.trim()).filter(Boolean);

/** resolve one or many MG clips from itemId/itemIds (preferred) or assetId/assetIds. */
function resolveMgItems(ctx: AgentContext, args: Args): TimelineItem[] {
  const items = ctx.getState().items;
  const out: TimelineItem[] = [];
  const seen = new Set<string>();
  const push = (it: TimelineItem | undefined) => { if (it && !seen.has(it.id)) { seen.add(it.id); out.push(it); } };
  for (const q of [...strs(args.itemId), ...strs(args.itemIds)]) push(items.find((it) => it.id === q || it.id.startsWith(q)));
  for (const q of [...strs(args.assetId), ...strs(args.assetIds)]) push(items.find((it) => it.templateId === q || it.src === q));
  return out;
}

/** export_motion_graphic_prores: transparent ProRes 4444 .mov per clip (browser download). */
async function exportProres(args: Args, ctx: AgentContext): Promise<unknown> {
  const items = resolveMgItems(ctx, args);
  if (!items.length) return { error: 'no MG clip found; pass itemId(s) (preferred) or assetId(s)' };
  const state = ctx.getState();
  const rename = items.length === 1 && typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null;
  const exported: string[] = [];
  const failed: { itemId: string; error: string }[] = [];
  for (const it of items) {
    if (it.kind === 'audio') { failed.push({ itemId: it.id, error: 'audio clip has no visual to export' }); continue; }
    try {
      await exportClipMov(state, rename ? { ...it, name: rename } : it); // transparent ProRes 4444 .mov download
      exported.push(rename ?? it.name);
    } catch (e) {
      failed.push({ itemId: it.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok: exported.length > 0, exported, ...(failed.length ? { failed } : {}), format: 'prores4444_mov', transparent: true };
}

export async function execMgVideoTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'convert_motion_graphic_to_video') return convert(args, ctx);
  if (name === 'register_converted_video') return register(args, ctx);
  if (name === 'export_motion_graphic_prores') return exportProres(args, ctx);
  return { error: `unknown tool ${name}` };
}
