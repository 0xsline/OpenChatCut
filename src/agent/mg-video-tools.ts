import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import type { MediaAsset, TimelineItem } from '../editor/types';
import { bakeClipToVideo } from '../media/clipExport';

// convert_motion_graphic_to_video + register_converted_video (source 域G §9).
// Source flow: convert 云渲 MG 原长 → renderId → track_export 等完成 →
// register_converted_video 把产物注册为媒体池 video 资产;同 MG 去重到同一 asset。
//
// 本地实现:/render-clip 端点(renderClip)与 clipExport.bakeClipToVideo 已在,渲染是
// 同步的,故 convert 一步渲染+注册(返回 assetId);register 单独暴露,供导入外部已渲产物。
// ⚠ 环境限制:本机 ffmpeg 不能编码 alpha webm/vp9(clipExport.ts 自陈),故转出的时间线
// 视频是不透明 h264;透明 alpha 只能走 ProRes .mov 导出(域H export_motion_graphic_prores)。

type Args = Record<string, unknown>;

export const MG_VIDEO_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'convert_motion_graphic_to_video',
    description:
      'Bake a motion-graphic (or any non-audio clip) on the timeline into a real video asset in the media pool, so it can be reused/exported like footage. Renders the clip full-length via the headless renderer. NOTE: this env cannot encode alpha webm — the baked video is opaque h264; for a transparent MG use the ProRes .mov export path instead. Pass replace:true to also swap the source clip in place. Identify the clip by itemId (preferred) or assetId.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Timeline clip id (prefix ok) to convert. Preferred.' },
        assetId: { type: 'string', description: 'Fallback: convert the first placed clip that references this asset/template id.' },
        replace: { type: 'boolean', description: 'Also replace the source clip in place with the baked video (default false = only add to media pool).' },
      },
    },
  },
  {
    name: 'register_converted_video',
    description:
      'Register an already-rendered video output (a same-origin /media/uploads path or public URL) as a media-pool video asset — the import half of convert_motion_graphic_to_video, or for videos rendered elsewhere.',
    input_schema: {
      type: 'object',
      properties: {
        outputUrl: { type: 'string', description: 'Rendered video path/URL to import (e.g. the src returned by convert_motion_graphic_to_video).' },
        name: { type: 'string', description: 'Display name for the media-pool asset.' },
        durationInFrames: { type: 'number', description: 'Duration in frames (defaults to the source MG length if omitted).' },
      },
      required: ['outputUrl'],
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
  let src: string;
  try {
    src = await bakeClipToVideo(state, item); // POST /render-clip (opaque h264 under /media/uploads)
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

  return { ok: true, assetId: asset.id, src, name: asset.name, durationInFrames: asset.durationInFrames, replaced: replace, opaque: true };
}

function register(args: Args, ctx: AgentContext): unknown {
  const outputUrl = typeof args.outputUrl === 'string' ? args.outputUrl.trim() : '';
  if (!outputUrl) return { error: 'register_converted_video requires outputUrl' };
  if (!/^(https?:\/\/|\/)/.test(outputUrl)) return { error: 'outputUrl must be a same-origin path (/media/…) or http(s) URL' };

  const dur = typeof args.durationInFrames === 'number' && Number.isFinite(args.durationInFrames) && args.durationInFrames > 0
    ? Math.round(args.durationInFrames)
    : ctx.getState().fps * 3; // no length given → 3s placeholder
  const asset: MediaAsset = {
    id: uid(),
    name: (typeof args.name === 'string' && args.name.trim()) || 'Converted video',
    kind: 'video',
    src: outputUrl,
    durationInFrames: dur,
  };
  ctx.commands.addAsset(asset);
  return { ok: true, assetId: asset.id, name: asset.name, durationInFrames: dur };
}

export async function execMgVideoTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'convert_motion_graphic_to_video') return convert(args, ctx);
  if (name === 'register_converted_video') return register(args, ctx);
  return { error: `unknown tool ${name}` };
}
