import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import {
  timelineTrackIds,
  trackKind,
  type MediaAsset,
  type Timeline,
  type TimelineItem,
} from '../../editor/types';
import type { Tpl } from '../../types';
import { bakeClipToVideo, bakeClipToAlphaWebm, exportClipMov } from '../../media/clipExport';
import { sanitizeFileName } from '../../media/fileName';
import { motionGraphicRenderFilename, motionGraphicRenderKey } from '../../export/motionGraphicRefs';
import { fetchRenderJob } from './export-tools';
import { resolveTimeline } from './timeline-target';

// convert_motion_graphic_to_video + register_converted_video.
// Flow: convert cloud rendering MG original length → renderId → track_export etc. completed →
// register_converted_video registers the product as a video asset in the media pool; it is the same asset as MG to remove duplicates.
//
// Local implementation: /render-clip endpoint (renderClip) and clipExport.bakeClipToVideo are already there, rendering is
// Synchronous, so convert renders in one step + registers (returns assetId); register is exposed separately for importing external rendered products.
// Transparency: For fragments with alpha such as MG/text/svg, first render transparent ProRes locally, and then enter the e2b sandbox to convert to VP9 alpha
// Webm is pooled ("convert to video = alpha webm"); if the sandbox is unavailable/fails, gracefully fallback to opaque h264.
// Opaque raster (video/image/gif) has no alpha and is directly h264.

type Args = Record<string, unknown>;

// Clip kinds that carry transparency worth preserving when baked (MG/vector/text).
const ALPHA_CAPABLE = new Set(['motion-graphic', 'text', 'svg']);

export const MG_VIDEO_TOOL_SCHEMAS: AgentToolSchema[] = [
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
        filenameMode: {
          type: 'string',
          enum: ['asset', 'xml'],
          description: 'asset = user-friendly asset-name .mov; xml = mg-<renderKey>.mov for submit_export XML compatibility. Defaults to asset.',
        },
        name: { type: 'string', description: 'Optional base filename (single export); ".mov" is appended.' },
        preferTimelineInstance: {
          type: 'boolean',
          description: 'When assetId is used, export the first timeline instance and its edited properties when present. Defaults to true. Set false to render the media-pool/template defaults.',
        },
        timelineId: { type: 'string', description: 'Optional timeline id/prefix used to resolve item or asset instances without switching timelines.' },
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
export function resolveMgItems(items: TimelineItem[], args: Args): TimelineItem[] {
  const out: TimelineItem[] = [];
  const seen = new Set<string>();
  const push = (it: TimelineItem | undefined) => { if (it && !seen.has(it.id)) { seen.add(it.id); out.push(it); } };
  for (const q of [...strs(args.itemId), ...strs(args.itemIds)]) push(items.find((it) => it.id === q || it.id.startsWith(q)));
  for (const q of [...strs(args.assetId), ...strs(args.assetIds)]) {
    push(items.find((it) => it.templateId === q || it.templateId?.startsWith(q) || it.src === q || it.src?.startsWith(q)));
  }
  return out;
}

export interface MotionGraphicExportTarget {
  item: TimelineItem;
  assetId: string;
  assetName: string;
  usesTimelineInstance: boolean;
}

export interface MotionGraphicExportPlanEntry extends MotionGraphicExportTarget {
  renderKey: string;
  filename: string;
}

function findByIdPrefix<T extends { id: string }>(items: T[], query: string): T | undefined {
  return items.find((item) => item.id === query) ?? items.find((item) => item.id.startsWith(query));
}

function videoTrackOf(state: Timeline): string {
  return timelineTrackIds(state).find((track) => trackKind(state, track) === 'video') ?? 'V1';
}

function assetDefaultItem(state: Timeline, asset: MediaAsset): TimelineItem {
  return {
    id: `asset-default-${asset.id}`,
    track: videoTrackOf(state),
    startFrame: 0,
    durationInFrames: Math.max(1, asset.durationInFrames),
    name: asset.name,
    kind: 'motion-graphic',
    templateId: asset.id,
    code: asset.code,
    props: { ...(asset.props ?? {}) },
    width: asset.width ?? state.width,
    height: asset.height ?? state.height,
  };
}

function templateDefaultItem(state: Timeline, template: Tpl): TimelineItem {
  return {
    id: `template-default-${template.id}`,
    track: videoTrackOf(state),
    startFrame: 0,
    durationInFrames: Math.max(1, template.durationInFrames),
    name: template.name,
    kind: 'motion-graphic',
    templateId: template.id,
    code: template.code,
    props: { ...template.props },
    width: template.width,
    height: template.height,
  };
}

/** Resolve edited timeline instances or pristine asset/template defaults for ProRes export. */
export function resolveMotionGraphicExportTargets(
  state: Timeline,
  args: Args,
  assets: MediaAsset[],
  templates: Tpl[],
): MotionGraphicExportTarget[] {
  const targets: MotionGraphicExportTarget[] = [];
  const seen = new Set<string>();
  const push = (target: MotionGraphicExportTarget | null) => {
    if (!target) return;
    const identity = target.usesTimelineInstance ? `item:${target.item.id}` : `asset:${target.assetId}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    targets.push(target);
  };

  for (const query of [...strs(args.itemId), ...strs(args.itemIds)]) {
    const item = state.items.find((candidate) => candidate.id === query)
      ?? state.items.find((candidate) => candidate.id.startsWith(query));
    if (!item) continue;
    const source = item.templateId
      ? findByIdPrefix(assets.filter((entry) => entry.kind === 'motion-graphic'), item.templateId)
        ?? findByIdPrefix(templates, item.templateId)
      : undefined;
    push({
      item,
      assetId: item.templateId ?? item.id,
      assetName: source?.name ?? item.name,
      usesTimelineInstance: true,
    });
  }

  const preferTimelineInstance = args.preferTimelineInstance !== false;
  for (const query of [...strs(args.assetId), ...strs(args.assetIds)]) {
    const asset = findByIdPrefix(assets.filter((entry) => entry.kind === 'motion-graphic'), query);
    const template = asset ? undefined : findByIdPrefix(templates, query);
    const canonicalId = asset?.id ?? template?.id ?? query;
    const instance = state.items.find((item) => item.kind === 'motion-graphic' && item.templateId === canonicalId)
      ?? state.items.find((item) => item.kind === 'motion-graphic' && (item.templateId === query || item.templateId?.startsWith(query)));

    if (preferTimelineInstance && instance) {
      push({
        item: instance,
        assetId: canonicalId,
        assetName: asset?.name ?? template?.name ?? instance.name,
        usesTimelineInstance: true,
      });
    } else if (asset) {
      push({ item: assetDefaultItem(state, asset), assetId: asset.id, assetName: asset.name, usesTimelineInstance: false });
    } else if (template) {
      push({ item: templateDefaultItem(state, template), assetId: template.id, assetName: template.name, usesTimelineInstance: false });
    } else if (instance) {
      push({ item: instance, assetId: instance.templateId ?? instance.id, assetName: instance.name, usesTimelineInstance: true });
    }
  }
  return targets;
}

export function buildMotionGraphicExportPlan(
  targets: MotionGraphicExportTarget[],
  args: Args,
): MotionGraphicExportPlanEntry[] {
  const filenameMode = args.filenameMode === 'xml' ? 'xml' : 'asset';
  const customName = targets.length === 1 && typeof args.name === 'string' && args.name.trim()
    ? args.name.trim()
    : null;
  const seenXmlKeys = new Set<string>();
  const plan: MotionGraphicExportPlanEntry[] = [];
  for (const target of targets) {
    const renderKey = motionGraphicRenderKey(target.item);
    if (filenameMode === 'xml' && seenXmlKeys.has(renderKey)) continue;
    seenXmlKeys.add(renderKey);
    const filename = filenameMode === 'xml'
      ? motionGraphicRenderFilename(renderKey)
      : `${sanitizeFileName(customName ?? target.assetName, 'motion-graphic')}.mov`;
    plan.push({ ...target, renderKey, filename });
  }
  return plan;
}

export async function runMotionGraphicExportPlan(
  state: Timeline,
  plan: MotionGraphicExportPlanEntry[],
  render: (timeline: Timeline, item: TimelineItem, filename: string) => Promise<void> =
    (timeline, item, filename) => exportClipMov(timeline, item, { filename }),
): Promise<{
  exported: MotionGraphicExportPlanEntry[];
  failed: Array<{ itemId: string; renderKey: string; filename: string; error: string }>;
}> {
  const exported: MotionGraphicExportPlanEntry[] = [];
  const failed: Array<{ itemId: string; renderKey: string; filename: string; error: string }> = [];
  for (const entry of plan) {
    if (entry.item.kind !== 'motion-graphic') {
      failed.push({
        itemId: entry.item.id,
        renderKey: entry.renderKey,
        filename: entry.filename,
        error: 'item is not a motion graphic',
      });
      continue;
    }
    try {
      await render(state, entry.item, entry.filename);
      exported.push(entry);
    } catch (error) {
      failed.push({
        itemId: entry.item.id,
        renderKey: entry.renderKey,
        filename: entry.filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { exported, failed };
}

/** export_motion_graphic_prores: transparent ProRes 4444 .mov per clip (browser download). */
async function exportProres(args: Args, ctx: AgentContext): Promise<unknown> {
  let state: Timeline;
  try {
    state = resolveTimeline(ctx, typeof args.timelineId === 'string' ? args.timelineId : undefined);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const targets = resolveMotionGraphicExportTargets(state, args, ctx.getDoc().assets ?? [], ctx.templates);
  if (!targets.length) return { error: 'no MG clip or asset found; pass itemId(s) (preferred) or assetId(s)' };
  const plan = buildMotionGraphicExportPlan(targets, args);
  const { exported, failed } = await runMotionGraphicExportPlan(state, plan);
  return {
    ok: exported.length > 0,
    timeline: { id: state.id, name: state.name },
    exported: exported.map((entry) => entry.filename.replace(/\.mov$/i, '')),
    renders: exported.map((entry) => ({
      itemId: entry.item.id,
      assetId: entry.assetId,
      renderKey: entry.renderKey,
      filename: entry.filename,
      usedTimelineInstance: entry.usesTimelineInstance,
    })),
    ...(failed.length ? { failed } : {}),
    format: 'prores4444_mov',
    transparent: true,
  };
}

export async function execMgVideoTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'convert_motion_graphic_to_video') return convert(args, ctx);
  if (name === 'register_converted_video') return register(args, ctx);
  if (name === 'export_motion_graphic_prores') return exportProres(args, ctx);
  return { error: `unknown tool ${name}` };
}
