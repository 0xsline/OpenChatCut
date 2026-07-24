import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { MediaAsset, TimelineItem } from '../../editor/types';
import { compileTemplate } from '../../template-host';

// edit_asset: Modify/delete "library assets" (assets in the media pool, non-timeline clips).
// - update: rename / change props / change the source code of code assets (MG) - changing code must go through the MG sandbox first.
//   If you fail to pass, you will not be dropped into the library. MediaAsset does not store thumbnails (MG preview is rendered according to code), no need to invalidate.
// - delete: Remove from the pool. confirmImpact: If a fragment refers to it (MG presses templateId, media presses src),
//   Report the count first, and then delete it after confirm:true (the fragment itself has copied the code/holds src, and deleting the pool entries will not destroy them).
// manage_media_pool.rename_asset also supports rename; edit_asset retains the same capability.

type Args = Record<string, unknown>;

export const EDIT_ASSET_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'edit_asset',
    description: [
      'change/Delete the "library assets" in the media pool(non-timeline clip;For fragments move_item/remove_item)。',
      'action=update:change name / props;Yes code asset-like(generated MG)Can transfer new code —— Will first pass the security sandbox compilation and verification,But don’t change it.',
      'action=delete:Remove assets from the media pool. If a fragment refers to it,Need confirm:true Second confirmation(The fragment itself is not affected,Already held separately code/src)。',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'delete'] },
        assetId: { type: 'string', description: 'target assets id(The prefix can)。' },
        name: { type: 'string', description: 'update:New display name.' },
        code: { type: 'string', description: 'update:code asset-like(MG)new source code(Pass sandbox verification)。' },
        props: { type: 'object', description: 'update:merge into assets props(Change default value)。' },
        favorite: { type: 'boolean', description: 'update:Collection mark.' },
        confirm: { type: 'boolean', description: 'delete:Confirm deletion of assets still referenced by fragments(confirmImpact)。' },
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
      compileTemplate(code); // Static blacklist and restricted scope compilation must be passed before being dropped into the library.
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
    return { needsConfirm: true, referencedBy: refs, note: `${refs} timeline clips cited "${asset.name}”. Delete removes only media pool entries,Does not affect placed clips. Please bring confirmation confirm:true Resend.` };
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
