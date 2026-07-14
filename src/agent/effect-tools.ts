import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import type { ClipEffect, TimelineItem } from '../editor/types';
import { FX_EFFECTS, FX_IDS } from '../gl/fx/effects';

// manage_effects — the per-clip WebGL effect operations of the source's
// `edit_item` transaction ({adds/updates/removes} with type:"effect", assetId,
// targetItemId, propertyOverrides). Modeled as one action tool to match this
// clone's granular manage_* convention. propertyOverrides is a sparse PATCH
// (only changed keys); values clamp to each effect's range at render.
// v1 = one effect per clip (mode:"item-bound", like the source default) — add
// replaces the clip's effect; source stacking / track-bound zoom is out of scope.

type Args = Record<string, unknown>;

const catalog = () => FX_IDS.map((id) => {
  const d = FX_EFFECTS[id];
  return { assetId: d.id, name: d.name, description: d.desc, properties: d.props.map((p) => ({ key: p.key, default: p.default, min: p.min, max: p.max })) };
});

export const EFFECT_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'manage_effects',
    description:
      "Apply a per-clip visual effect (WebGL shader) to a video/image clip — luma-key (black-overlay/Screen for fire/smoke overlays), local-mosaic (blur/pixelate a region), magnify, rect-mask / circle-mask (crop to a shape), crt (retro CRT), shake (handheld camera). action=list returns the effect catalog with each effect's tunable properties + ranges. add attaches an effect; update patches its properties (sparse — only the keys you change); remove clears it. Mutating actions flow through propose→apply.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], description: 'What to do.' },
        targetItemId: { type: 'string', description: 'Clip id to affect (prefix ok). Required for add/update/remove. Must be a video or image clip.' },
        assetId: { type: 'string', description: 'add: which effect, e.g. "builtin:fx-luma-key". Get ids from action="list".' },
        propertyOverrides: { type: 'object', description: 'add/update: sparse patch of property values, e.g. {"intensity":0.8,"threshold":0.05}. Keys/ranges per the effect (see list). Omit for defaults.' },
      },
      required: ['action'],
    },
  },
];

export const EFFECT_TOOL_NAMES = new Set(EFFECT_TOOL_SCHEMAS.map((t) => t.name));

function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const q = String(id ?? '');
  if (!q) return null;
  return items.find((it) => it.id === q || it.id.startsWith(q)) ?? null;
}

/** coerce an untrusted overrides object to a clean Record<string, number> (drop non-finite) */
function cleanOverrides(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

const describe = (it: TimelineItem) => {
  const fx = it.effects?.find((e) => e.assetId in FX_EFFECTS) ?? null;
  return { itemId: it.id, kind: it.kind, effect: fx ? { assetId: fx.assetId, name: FX_EFFECTS[fx.assetId].name, overrides: fx.overrides ?? {} } : null };
};

export async function execEffectTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'manage_effects') return { error: `unknown tool ${name}` };
  if (String(args.action) === 'list') return { effects: catalog() };

  const state = ctx.getState();
  const visual = state.items.filter((it) => it.kind === 'video' || it.kind === 'image');
  const it = findItem(visual, args.targetItemId);
  if (!it) {
    return { error: `no video/image clip ${args.targetItemId ?? '(missing targetItemId)'}`, available: visual.map((x) => ({ itemId: x.id, kind: x.kind, name: x.name })) };
  }

  switch (String(args.action)) {
    case 'add': {
      const assetId = String(args.assetId ?? '');
      if (!(assetId in FX_EFFECTS)) return { error: `unknown effect ${assetId}`, available: FX_IDS };
      const effect: ClipEffect = { id: `fx_${assetId}`, assetId, overrides: cleanOverrides(args.propertyOverrides) };
      ctx.commands.setItemEffects(it.id, [effect]); // v1: one effect per clip (replaces)
      return { ok: true, ...describe(findItem(ctx.getState().items, it.id) ?? it) };
    }
    case 'update': {
      const cur = it.effects?.find((e) => e.assetId in FX_EFFECTS);
      if (!cur) return { error: `clip ${it.id} has no effect to update — use action="add" first` };
      const patch = cleanOverrides(args.propertyOverrides);
      const nextAsset = typeof args.assetId === 'string' && args.assetId in FX_EFFECTS ? args.assetId : cur.assetId;
      const next: ClipEffect = { id: `fx_${nextAsset}`, assetId: nextAsset, overrides: { ...cur.overrides, ...patch } };
      ctx.commands.setItemEffects(it.id, [next]);
      return { ok: true, ...describe(findItem(ctx.getState().items, it.id) ?? it) };
    }
    case 'remove': {
      ctx.commands.setItemEffects(it.id, []);
      return { ok: true, itemId: it.id, effect: null };
    }
    default:
      return { error: `unknown action ${args.action}（可选 list/add/update/remove）` };
  }
}
