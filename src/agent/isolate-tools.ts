import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { isolateVoice } from '../audio/isolate';

// isolate_voice — source DeepFilterNet3 speech isolation (复刻规格 § isolate_voice).
// apply: POST /api/isolate → setItemDenoise; clear: setItemDenoise(null).

type Args = Record<string, unknown>;

export const ISOLATE_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'isolate_voice',
    description:
      'Apply, attach or clear AI voice isolation on a video/audio item with spoken human voice (source isolate_voice / DeepFilterNet3). Not generic denoise — speech-only enhancement. action=apply runs the editor pipeline (POST /api/isolate) and points the item at the derived wav via denoisedSrc. action=attach points the item at an ALREADY-isolated audio asset in the media pool (denoisedAssetId) without re-running the pipeline. action=clear reverts to original audio. Prefer itemId of the selected clip; omit to use the selected item.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['apply', 'attach', 'clear'], description: 'apply = run isolation; attach = reuse a pooled isolated wav; clear = revert.' },
        itemId: { type: 'string', description: 'Target clip id (prefix ok). Default: selected item.' },
        denoisedAssetId: { type: 'string', description: 'attach only: media-pool AUDIO asset id (prefix ok) already holding the voice-isolated wav.' },
        strength: { type: 'number', description: 'apply/attach: 0–100 atten strength (default 100).' },
      },
      required: ['action'],
    },
  },
];

export const ISOLATE_TOOL_NAMES = new Set(ISOLATE_TOOL_SCHEMAS.map((t) => t.name));

function findItem(ctx: AgentContext, itemId: unknown) {
  const state = ctx.getState();
  const q = itemId == null ? '' : String(itemId);
  if (q) {
    return state.items.find((it) => it.id === q || it.id.startsWith(q)) ?? null;
  }
  if (state.selectedId) {
    return state.items.find((it) => it.id === state.selectedId) ?? null;
  }
  return state.items.find((it) => (it.kind === 'audio' || it.kind === 'video') && it.src) ?? null;
}

export async function execIsolateTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'isolate_voice') return { error: `unknown tool ${name}` };
  const action = String(args.action ?? '');
  const item = findItem(ctx, args.itemId);
  if (!item) return { error: 'no target audio/video item' };
  if (item.kind !== 'audio' && item.kind !== 'video') {
    return { error: 'isolate_voice only works on audio or video clips' };
  }
  if (action === 'clear') {
    ctx.commands.setItemDenoise(item.id, null);
    return { ok: true, action: 'clear', itemId: item.id };
  }
  if (action === 'attach') {
    // reuse a pooled, already-isolated wav — no pipeline re-run (source attach)
    const q = String(args.denoisedAssetId ?? '').trim();
    if (!q) return { error: 'attach requires denoisedAssetId (a media-pool audio asset holding the isolated voice)' };
    const asset = ctx.getDoc().assets.find((a) => a.id === q || a.id.startsWith(q));
    if (!asset) return { error: `no asset ${q}` };
    if (asset.kind !== 'audio') return { error: `asset "${asset.name}" is ${asset.kind}, not audio` };
    const strength = typeof args.strength === 'number' ? args.strength : 100;
    ctx.commands.setItemDenoise(item.id, asset.src, strength);
    return { ok: true, action: 'attach', itemId: item.id, denoisedSrc: asset.src, denoisedAssetId: asset.id, strength };
  }
  if (action !== 'apply') return { error: `unknown action ${action}` };
  if (!item.src) return { error: 'item has no src' };
  const strength = typeof args.strength === 'number' ? args.strength : 100;
  try {
    const r = await isolateVoice(item.src, strength);
    ctx.commands.setItemDenoise(item.id, r.path, r.strength);
    return {
      ok: true,
      action: 'apply',
      itemId: item.id,
      denoisedSrc: r.path,
      strength: r.strength,
      engine: r.engine,
      note: r.note,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
