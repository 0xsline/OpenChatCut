import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { ClipEffect, ClipEffectValue, TimelineItem } from '../../editor/types';
import { ALL_FX, serializableDefsFor } from '../../gl/fx/effects';
const FX_EFFECTS = ALL_FX;
const FX_IDS = Object.keys(ALL_FX);

// manage_effects — the per-clip WebGL effect operations of the
// `edit_item` transaction ({adds/updates/removes} with type:"effect", assetId,
// targetItemId, propertyOverrides). Modeled as one action tool to match this
// OpenChatCut's granular manage_* convention. propertyOverrides is a sparse PATCH
// (only changed keys); values clamp to each effect's range at render. `add`
// appends to effects[] and effectId targets one entry for update/remove.

type Args = Record<string, unknown>;

const catalog = () => FX_IDS.map((id) => {
  const d = FX_EFFECTS[id];
  return { assetId: d.id, name: d.name, description: d.desc, properties: d.props.map((p) => p.kind === 'color'
    ? { key: p.key, type: 'color', default: p.default }
    : { key: p.key, type: 'number', default: p.default, min: p.min, max: p.max }) };
});

export const EFFECT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'manage_effects',
    description:
      'Shorthand for per-clip WebGL effects. Prefer browse_library followed by edit_item adds:[{type:"effect",targetItemId,assetId}]. action=list returns catalog; add/update/remove mutate the clip effect stack. Also covers LUT assetIds. For zoom/transitions use edit_item.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], description: 'What to do.' },
        targetItemId: { type: 'string', description: 'Clip id to affect (prefix ok). Required for add/update/remove. Must be a video or image clip.' },
        effectId: { type: 'string', description: 'update/remove: target effect instance id. Omit to target the first effect.' },
        assetId: { type: 'string', description: 'add: which effect, e.g. "builtin:fx-luma-key". Get ids from action="list" or browse_library.' },
        propertyOverrides: { type: 'object', description: 'add/update: sparse patch. Numeric properties use numbers; colors use RGB arrays in 0..1, e.g. {"color":[1,0,0]}. Omit for defaults.' },
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

/** coerce untrusted overrides to finite scalar/vector uniform values */
function cleanOverrides(raw: unknown): Record<string, ClipEffectValue> {
  const out: Record<string, ClipEffectValue> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) out[k] = n;
      else if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) out[k] = v;
    }
  }
  return out;
}

const describe = (it: TimelineItem) => {
  const effects = (it.effects ?? []).filter((e) => e.assetId in FX_EFFECTS).map((fx) => ({ effectId: fx.id, assetId: fx.assetId, name: FX_EFFECTS[fx.assetId].name, overrides: fx.overrides ?? {} }));
  return { itemId: it.id, kind: it.kind, effect: effects[0] ?? null, effects };
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
      const effect: ClipEffect = { id: `fx_${crypto.randomUUID()}`, assetId, overrides: cleanOverrides(args.propertyOverrides) };
      const nextEffects = [...(it.effects ?? []), effect];
      ctx.commands.setItemEffects(it.id, nextEffects, serializableDefsFor([effect]));
      return { ok: true, ...describe({ ...it, effects: nextEffects }) };
    }
    case 'update': {
      const effectId = String(args.effectId ?? '');
      const index = (it.effects ?? []).findIndex((e) => e.assetId in FX_EFFECTS && (!effectId || e.id === effectId || e.id.startsWith(effectId)));
      const cur = it.effects?.[index];
      if (!cur) return { error: `clip ${it.id} has no effect to update — use action="add" first` };
      const patch = cleanOverrides(args.propertyOverrides);
      const nextAsset = typeof args.assetId === 'string' && args.assetId in FX_EFFECTS ? args.assetId : cur.assetId;
      const next: ClipEffect = { ...cur, assetId: nextAsset, overrides: { ...cur.overrides, ...patch } };
      const nextEffects = (it.effects ?? []).map((fx, i) => i === index ? next : fx);
      ctx.commands.setItemEffects(it.id, nextEffects, serializableDefsFor([next]));
      return { ok: true, ...describe({ ...it, effects: nextEffects }) };
    }
    case 'remove': {
      const effectId = String(args.effectId ?? '');
      const assetId = String(args.assetId ?? '');
      const next = effectId
        ? (it.effects ?? []).filter((fx) => fx.id !== effectId && !fx.id.startsWith(effectId))
        : assetId ? (it.effects ?? []).filter((fx) => fx.assetId !== assetId) : [];
      ctx.commands.setItemEffects(it.id, next);
      return { ok: true, ...describe({ ...it, effects: next }) };
    }
    default:
      return { error: `unknown action ${args.action}(optional list/add/update/remove）` };
  }
}
