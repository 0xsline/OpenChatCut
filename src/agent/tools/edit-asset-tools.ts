import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../context';
import type { MediaAsset, TimelineItem } from '../../editor/types';
import { compileTemplate } from '../../template-host';

// edit_asset: 改/删「库资产」(媒体池里的 asset,非时间线片段)。
// - update: 改名 / 改 props / 对 code 类资产(MG)换源码 — 换 code 必须先通过 MG 沙箱，
//   未通过则不落库。MediaAsset 不存缩略图(MG 预览按 code 现渲),无需失效。
// - delete: 从池里移除。confirmImpact:若有片段引用它(MG 按 templateId、媒体按 src),
//   先报计数、要 confirm:true 才删(片段自身已拷贝 code/持有 src,删池条目不破坏它们)。
// manage_media_pool.rename_asset 也支持改名；edit_asset 保留同一能力。

type Args = Record<string, unknown>;

export const EDIT_ASSET_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'edit_asset',
    description: [
      '改/删媒体池里的「库资产」(非时间线片段;片段用 move_item/remove_item)。',
      'action=update:改 name / props;对 code 类资产(生成的 MG)可传新 code —— 会先过安全沙箱编译校验,不过不改。',
      'action=delete:从媒体池移除资产。若有片段引用它,需 confirm:true 二次确认(片段本身不受影响,已各自持有 code/src)。',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'delete'] },
        assetId: { type: 'string', description: '目标资产 id(前缀可)。' },
        name: { type: 'string', description: 'update:新显示名。' },
        code: { type: 'string', description: 'update:code 类资产(MG)的新源码(过沙箱校验)。' },
        props: { type: 'object', description: 'update:合并进资产 props(改默认值)。' },
        favorite: { type: 'boolean', description: 'update:收藏标记。' },
        confirm: { type: 'boolean', description: 'delete:确认删除仍被片段引用的资产(confirmImpact)。' },
      },
      required: ['action', 'assetId'],
    },
  },
];

export const EDIT_ASSET_TOOL_NAMES = new Set(EDIT_ASSET_TOOL_SCHEMAS.map((t) => t.name));

const strArg = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** count timeline clips that reference this asset (MG by templateId, media by src). */
function referencingItems(items: TimelineItem[], asset: MediaAsset): number {
  return items.filter((it) =>
    (asset.kind === 'motion-graphic' && it.templateId === asset.id) || (!!asset.src && it.src === asset.src),
  ).length;
}

function update(asset: MediaAsset, args: Args, ctx: AgentContext): unknown {
  const patch: Partial<Pick<MediaAsset, 'name' | 'code' | 'props' | 'favorite'>> = {};
  const name = strArg(args.name);
  if (name) patch.name = name;
  if (typeof args.favorite === 'boolean') patch.favorite = args.favorite;
  if (args.props && typeof args.props === 'object') patch.props = { ...asset.props, ...(args.props as Record<string, unknown>) };

  const code = strArg(args.code);
  if (code) {
    if (asset.kind !== 'motion-graphic') return { error: `asset "${asset.name}" is ${asset.kind}, not a code (motion-graphic) asset — code cannot be set` };
    try {
      compileTemplate(code); // 静态黑名单与受限作用域编译均通过后才落库。
    } catch (e) {
      return { error: `new code rejected by sandbox: ${e instanceof Error ? e.message : String(e)}`, code };
    }
    patch.code = code;
  }

  if (Object.keys(patch).length === 0) return { error: 'nothing to update; pass name / code / props / favorite' };
  ctx.commands.editMediaAsset(asset.id, patch);
  return { ok: true, updated: Object.keys(patch), assetId: asset.id };
}

function remove(asset: MediaAsset, args: Args, ctx: AgentContext): unknown {
  const refs = referencingItems(ctx.getState().items, asset);
  if (refs > 0 && args.confirm !== true) {
    return { needsConfirm: true, referencedBy: refs, note: `${refs} 个时间线片段引用了「${asset.name}」。删除只移除媒体池条目,不影响已放置片段。确认请带 confirm:true 重发。` };
  }
  ctx.commands.removeMediaAsset(asset.id);
  return { ok: true, deleted: asset.id, name: asset.name, wasReferencedBy: refs };
}

export async function execEditAssetTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'edit_asset') return { error: `unknown tool ${name}` };
  const id = strArg(args.assetId);
  if (!id) return { error: 'edit_asset requires assetId' };
  const asset = ctx.getDoc().assets.find((a) => a.id === id || a.id.startsWith(id));
  if (!asset) return { error: `no asset ${id}` };

  const action = String(args.action ?? '');
  if (action === 'update') return update(asset, args, ctx);
  if (action === 'delete') return remove(asset, args, ctx);
  return { error: `unknown action "${action}"; use update|delete` };
}
