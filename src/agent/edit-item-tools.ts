import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import type { ClipEffect, ClipEffectValue, TimelineItem, TransitionType, ZoomEffect, ZoomShape } from '../editor/types';
import { defaultTrackId, resolveTrackId } from '../editor/types';
import { ALL_FX } from '../gl/fx/effects';
import {
  parseTransitionAssetId,
  parseZoomLibraryId,
  transitionAssetId,
} from './library-catalog';
import { SOUND_EFFECTS, soundEffectSrc } from '../audio/soundLibrary';

// Source edit_item — library placement for effect / transition / zoom / MG / SFX.
// Batch is atomic: every op is validated first; on any failure nothing mutates
// (source: single validation failure rolls the whole batch back).

type Args = Record<string, unknown>;
type OpResult = Record<string, unknown>;

export const EDIT_ITEM_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'edit_item',
    description:
      'Source-faithful item-level ops. Prefer browse_library first. Supports adds/updates/deletes for type=effect (LUT + library:zoom:*), type=transition (builtin:tr-*), type=motion-graphic (library:motion-graphic:*), type=audio (library:sound:*). Batch is atomic — any validation error aborts the whole call with no mutations (or validateOnly:true to dry-run). Mutating ops go through propose→apply. For generic move/trim/delete use move_item / set_item_timing / remove_item.',
    input_schema: {
      type: 'object',
      properties: {
        adds: {
          type: 'array',
          description:
            'effect: {type,targetItemId,assetId,propertyOverrides?}. transition: {type,assetId,incomingItemId,outgoingItemId?,durationInFrames?}. motion-graphic: {type,assetId:library:motion-graphic:*,track?,startFrame?}. audio: {type,assetId:library:sound:*,fromFrame?}.',
          items: { type: 'object' },
        },
        updates: {
          type: 'array',
          description:
            'effect: {type:"effect",id|effectId,targetItemId?,propertyOverrides,assetId?}. transition: {type:"transition",id,durationInFrames?,assetId?}. zoom via effect + propertyOverrides.',
          items: { type: 'object' },
        },
        deletes: {
          type: 'array',
          description:
            'effect: {type:"effect",id|effectId,targetItemId?} or clear with targetItemId only. transition: {type:"transition",id}. zoom: {type:"effect",targetItemId,assetId:"builtin:zoom"}.',
          items: { type: 'object' },
        },
        validateOnly: {
          type: 'boolean',
          description: 'If true, validate only — never mutate. Same validation runs before every real commit.',
        },
      },
    },
  },
];

export const EDIT_ITEM_TOOL_NAMES = new Set(EDIT_ITEM_TOOL_SCHEMAS.map((t) => t.name));

function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const q = String(id ?? '');
  if (!q) return null;
  return items.find((it) => it.id === q || it.id.startsWith(q)) ?? null;
}

function cleanOverrides(raw: unknown): Record<string, ClipEffectValue> {
  const out: Record<string, ClipEffectValue> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) out[k] = n;
      else if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        out[k] = v as number[];
      }
    }
  }
  return out;
}

function zoomFromOverrides(shape: ZoomShape, ov: Record<string, ClipEffectValue>): ZoomEffect {
  const mag = typeof ov.magnification === 'number' ? ov.magnification : 1.5;
  const fx = typeof ov.focalPointX === 'number' ? ov.focalPointX : undefined;
  const fy = typeof ov.focalPointY === 'number' ? ov.focalPointY : undefined;
  return {
    shape,
    magnification: mag,
    ...(fx !== undefined ? { focalPointX: fx } : {}),
    ...(fy !== undefined ? { focalPointY: fy } : {}),
  };
}

function describeClip(it: TimelineItem) {
  const effects = (it.effects ?? [])
    .filter((e) => e.assetId in ALL_FX)
    .map((fx) => ({
      effectId: fx.id,
      assetId: fx.assetId,
      name: ALL_FX[fx.assetId]?.name,
      overrides: fx.overrides ?? {},
    }));
  return {
    itemId: it.id,
    itemKind: it.kind,
    name: it.name,
    zoom: it.zoom ?? null,
    effects,
  };
}

function findAdjacentOutgoing(state: { items: TimelineItem[] }, incoming: TimelineItem): TimelineItem | null {
  const prior = state.items.filter(
    (x) =>
      x.id !== incoming.id
      && x.track === incoming.track
      && x.kind !== 'audio'
      && x.startFrame + x.durationInFrames <= incoming.startFrame + 2,
  );
  if (!prior.length) return null;
  const out = prior.reduce((best, x) =>
    (x.startFrame + x.durationInFrames > best.startFrame + best.durationInFrames ? x : best));
  if (incoming.startFrame - (out.startFrame + out.durationInFrames) > 2) return null;
  return out;
}

// ── validates (no mutation) ────────────────────────────────────────────────

function validateEffectAdd(ctx: AgentContext, entry: Record<string, unknown>): OpResult {
  const target = findItem(ctx.getState().items, entry.targetItemId);
  if (!target || (target.kind !== 'video' && target.kind !== 'image')) {
    return { error: 'effect needs video/image targetItemId', got: entry.targetItemId };
  }
  const assetId = String(entry.assetId ?? '');
  const ov = cleanOverrides(entry.propertyOverrides);
  const zoomShape = parseZoomLibraryId(assetId);
  if (zoomShape || assetId === 'builtin:zoom') {
    const shape = (typeof ov.shape === 'string' && parseZoomLibraryId(`library:zoom:${ov.shape}`)
      ? (ov.shape as ZoomShape)
      : zoomShape) ?? 'hold';
    return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: target.id, zoom: zoomFromOverrides(shape, ov) };
  }
  if (!(assetId in ALL_FX)) {
    return { error: `unknown effect assetId ${assetId}`, hint: 'browse_library category=fx|luts|zoom' };
  }
  return {
    ok: true,
    kind: 'effect',
    plan: 'addEffect',
    targetItemId: target.id,
    effect: { id: `fx_${crypto.randomUUID()}`, assetId, overrides: ov } satisfies ClipEffect,
  };
}

function validateTransitionAdd(ctx: AgentContext, entry: Record<string, unknown>): OpResult {
  const assetId = String(entry.assetId ?? '');
  const type = parseTransitionAssetId(assetId);
  if (!type) {
    return {
      error: `unknown transition assetId ${assetId}`,
      hint: 'Use builtin:tr-<type> from browse_library category=transitions',
      examples: ['builtin:tr-cross-dissolve', 'builtin:tr-page-curl'],
    };
  }
  const state = ctx.getState();
  let incoming = findItem(state.items, entry.incomingItemId);
  if (!incoming && entry.trackId != null && entry.fromFrame != null) {
    const track = String(entry.trackId);
    const f = Number(entry.fromFrame);
    incoming = state.items
      .filter((it) => it.track === track && it.kind !== 'audio' && Math.abs(it.startFrame - f) <= 2)
      .sort((a, b) => a.startFrame - b.startFrame)[0] ?? null;
  }
  if (!incoming || incoming.kind === 'audio') {
    return { error: 'transition needs incomingItemId (the later clip at the cut)' };
  }
  if (entry.outgoingItemId) {
    const out = findItem(state.items, entry.outgoingItemId);
    if (!out) return { error: `outgoingItemId not found: ${entry.outgoingItemId}` };
  }
  const adj = findAdjacentOutgoing(state, incoming);
  if (!adj) {
    return {
      error: `no adjacent prior clip before ${incoming.id} on track ${incoming.track}`,
      hint: 'Transition straddles a cut between two same-track visual clips',
    };
  }
  if (entry.outgoingItemId) {
    const want = findItem(state.items, entry.outgoingItemId);
    if (want && want.id !== adj.id) {
      return { error: `outgoingItemId ${entry.outgoingItemId} is not the adjacent prior clip (found ${adj.id})` };
    }
  }
  const dur = typeof entry.durationInFrames === 'number' ? entry.durationInFrames : undefined;
  return {
    ok: true,
    kind: 'transition',
    plan: 'addTransition',
    incomingItemId: incoming.id,
    outgoingItemId: adj.id,
    type,
    durationInFrames: dur,
  };
}

function validateAudioAdd(ctx: AgentContext, entry: Record<string, unknown>): OpResult {
  const assetId = String(entry.assetId ?? '');
  const m = /^library:sound:(.+)$/.exec(assetId);
  if (!m) return { error: 'audio add expects library:sound:<id>', got: assetId };
  const sfx = SOUND_EFFECTS.find((s) => s.id === m[1]);
  if (!sfx) return { error: `unknown sound ${m[1]}` };
  const fps = ctx.getState().fps;
  return {
    ok: true,
    kind: 'audio',
    plan: 'addAudio',
    sfxId: sfx.id,
    name: sfx.name,
    src: soundEffectSrc(sfx.id),
    durationInFrames: Math.max(1, Math.round(sfx.seconds * fps)),
    startFrame: typeof entry.fromFrame === 'number' ? entry.fromFrame : undefined,
    track: typeof entry.trackId === 'string' ? entry.trackId : undefined,
  };
}

function validateMgAdd(ctx: AgentContext, entry: Record<string, unknown>): OpResult {
  const assetId = String(entry.assetId ?? '');
  const m = /^library:motion-graphic:(.+)$/.exec(assetId);
  if (!m) return { error: 'motion-graphic add expects library:motion-graphic:<id>', got: assetId };
  const tplId = m[1];
  const tpl = ctx.templates.find((t) => t.id === tplId || t.id.startsWith(tplId) || t.name === tplId);
  if (!tpl) {
    // also match by name from bare suffix
    const byName = ctx.templates.find((t) => t.name.toLowerCase() === tplId.toLowerCase());
    if (!byName) return { error: `unknown motion-graphic ${tplId}`, hint: 'browse_library category=motion-graphics' };
    return planMg(ctx, byName, entry);
  }
  return planMg(ctx, tpl, entry);
}

function planMg(ctx: AgentContext, tpl: { id: string; name: string }, entry: Record<string, unknown>): OpResult {
  const s = ctx.getState();
  const track = resolveTrackId(s, entry.track ?? entry.trackId ?? 'V1', 'video') ?? defaultTrackId(s, 'video');
  if (!track) return { error: 'no video track; create one with edit_track first' };
  return {
    ok: true,
    kind: 'motion-graphic',
    plan: 'addMg',
    templateId: tpl.id,
    name: tpl.name,
    track,
    startFrame: typeof entry.startFrame === 'number' ? entry.startFrame : undefined,
  };
}

function validateEffectUpdate(ctx: AgentContext, entry: Record<string, unknown>): OpResult {
  const target = findItem(ctx.getState().items, entry.targetItemId);
  const effectId = String(entry.id ?? entry.effectId ?? '');
  const ov = cleanOverrides(entry.propertyOverrides);

  if (entry.assetId === 'builtin:zoom' || parseZoomLibraryId(String(entry.assetId ?? '')) || (target?.zoom && !effectId && Object.keys(ov).length)) {
    const it = target ?? findItem(ctx.getState().items, entry.targetItemId);
    if (!it) return { error: 'zoom update needs targetItemId' };
    const shape = (typeof ov.shape === 'string' ? ov.shape : it.zoom?.shape ?? 'hold') as ZoomShape;
    const zoom = zoomFromOverrides(shape, { ...(it.zoom as object), ...ov } as Record<string, ClipEffectValue>);
    return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: it.id, zoom: { ...it.zoom, ...zoom } };
  }

  let it = target;
  let index = -1;
  if (it) {
    index = (it.effects ?? []).findIndex((e) => !effectId || e.id === effectId || e.id.startsWith(effectId));
  } else if (effectId) {
    for (const cand of ctx.getState().items) {
      const i = (cand.effects ?? []).findIndex((e) => e.id === effectId || e.id.startsWith(effectId));
      if (i >= 0) { it = cand; index = i; break; }
    }
  }
  if (!it || index < 0) return { error: 'effect update: effect not found' };
  const cur = it.effects![index];
  const nextAsset = typeof entry.assetId === 'string' && entry.assetId in ALL_FX ? String(entry.assetId) : cur.assetId;
  return {
    ok: true,
    kind: 'effect',
    plan: 'updateEffect',
    targetItemId: it.id,
    index,
    effect: { ...cur, assetId: nextAsset, overrides: { ...cur.overrides, ...ov } } satisfies ClipEffect,
  };
}

function validateTransitionUpdate(ctx: AgentContext, entry: Record<string, unknown>): OpResult {
  const id = String(entry.id ?? '');
  const tr = ctx.getState().transitions?.find((t) => t.id === id || t.id.startsWith(id));
  if (!tr) return { error: `transition not found: ${id}` };
  const patch: Record<string, unknown> = {};
  if (typeof entry.durationInFrames === 'number') patch.durationInFrames = entry.durationInFrames;
  if (typeof entry.assetId === 'string') {
    const type = parseTransitionAssetId(entry.assetId);
    if (type) patch.type = type;
    else return { error: `unknown transition assetId ${entry.assetId}` };
  }
  if (typeof entry.transitionType === 'string') {
    const type = parseTransitionAssetId(String(entry.transitionType)) ?? (entry.transitionType as TransitionType);
    if (type) patch.type = type;
  }
  return { ok: true, kind: 'transition', plan: 'setTransition', id: tr.id, patch };
}

function validateDelete(ctx: AgentContext, entry: Record<string, unknown>): OpResult {
  const type = String(entry.type ?? '');
  if (type === 'transition') {
    const id = String(entry.id ?? '');
    const tr = ctx.getState().transitions?.find((t) => t.id === id || t.id.startsWith(id));
    if (!tr) return { error: `transition not found: ${id}` };
    return { ok: true, kind: 'transition', plan: 'removeTransition', id: tr.id };
  }
  if (type === 'effect' || !type) {
    const assetId = String(entry.assetId ?? '');
    if (assetId === 'builtin:zoom' || parseZoomLibraryId(assetId)) {
      const it = findItem(ctx.getState().items, entry.targetItemId);
      if (!it) return { error: 'zoom delete needs targetItemId' };
      return { ok: true, kind: 'zoom', plan: 'clearZoom', targetItemId: it.id };
    }
    const effectId = String(entry.id ?? entry.effectId ?? '');
    let it = findItem(ctx.getState().items, entry.targetItemId);
    if (!it && effectId) {
      it = ctx.getState().items.find((c) => (c.effects ?? []).some((e) => e.id === effectId || e.id.startsWith(effectId))) ?? null;
    }
    if (!it) return { error: 'effect delete needs targetItemId or effect id' };
    let next = it.effects ?? [];
    if (effectId) next = next.filter((fx) => fx.id !== effectId && !fx.id.startsWith(effectId));
    else if (assetId) next = next.filter((fx) => fx.assetId !== assetId);
    else next = [];
    return { ok: true, kind: 'effect', plan: 'setEffects', targetItemId: it.id, effects: next, remaining: next.length };
  }
  return { error: `delete unsupported type ${type}` };
}

function validateAdd(ctx: AgentContext, entry: Record<string, unknown>): OpResult {
  const t = String(entry.type ?? '');
  if (t === 'effect') return validateEffectAdd(ctx, entry);
  if (t === 'transition') return validateTransitionAdd(ctx, entry);
  if (t === 'audio') return validateAudioAdd(ctx, entry);
  if (t === 'motion-graphic') return validateMgAdd(ctx, entry);
  return { error: `add type not supported: ${t}`, supported: ['effect', 'transition', 'audio', 'motion-graphic'] };
}

function validateUpdate(ctx: AgentContext, entry: Record<string, unknown>): OpResult {
  const t = String(entry.type ?? 'effect');
  if (t === 'effect') return validateEffectUpdate(ctx, entry);
  if (t === 'transition') return validateTransitionUpdate(ctx, entry);
  return { error: `update type not supported: ${t}` };
}

// ── commit plans ───────────────────────────────────────────────────────────

function commitPlan(ctx: AgentContext, plan: OpResult): OpResult {
  if (!plan.ok || plan.error) return plan;
  switch (plan.plan) {
    case 'setZoom':
      ctx.commands.setItemZoom(String(plan.targetItemId), plan.zoom as ZoomEffect);
      return {
        ok: true,
        kind: 'zoom',
        ...describeClip(findItem(ctx.getState().items, plan.targetItemId) ?? { id: String(plan.targetItemId) } as TimelineItem),
        applied: plan.zoom,
      };
    case 'addEffect': {
      const it = findItem(ctx.getState().items, plan.targetItemId)!;
      const effect = plan.effect as ClipEffect;
      ctx.commands.setItemEffects(it.id, [...(it.effects ?? []), effect]);
      return { ok: true, kind: 'effect', ...describeClip(findItem(ctx.getState().items, it.id) ?? it) };
    }
    case 'updateEffect': {
      const it = findItem(ctx.getState().items, plan.targetItemId)!;
      const index = Number(plan.index);
      const next = plan.effect as ClipEffect;
      ctx.commands.setItemEffects(it.id, (it.effects ?? []).map((fx, i) => (i === index ? next : fx)));
      return { ok: true, kind: 'effect', ...describeClip(findItem(ctx.getState().items, it.id) ?? it) };
    }
    case 'setEffects':
      ctx.commands.setItemEffects(String(plan.targetItemId), plan.effects as ClipEffect[]);
      return { ok: true, deleted: 'effect', itemId: plan.targetItemId, remaining: plan.remaining };
    case 'clearZoom':
      ctx.commands.setItemZoom(String(plan.targetItemId), null);
      return { ok: true, deleted: 'zoom', itemId: plan.targetItemId };
    case 'addTransition': {
      ctx.commands.addTransition(
        String(plan.incomingItemId),
        plan.type as TransitionType,
        plan.durationInFrames as number | undefined,
      );
      const tr = ctx.getState().transitions?.find((t) => t.incomingItemId === plan.incomingItemId);
      return {
        ok: true,
        kind: 'transition',
        transition: tr
          ? {
              id: tr.id,
              type: tr.type,
              assetId: transitionAssetId(tr.type as TransitionType),
              durationInFrames: tr.durationInFrames,
              outgoingItemId: tr.outgoingItemId,
              incomingItemId: tr.incomingItemId,
            }
          : null,
      };
    }
    case 'setTransition':
      ctx.commands.setTransition(String(plan.id), plan.patch as Partial<{ type: TransitionType; durationInFrames: number }>);
      return { ok: true, kind: 'transition', id: plan.id, patch: plan.patch };
    case 'removeTransition':
      ctx.commands.removeTransition(String(plan.id));
      return { ok: true, deleted: 'transition', id: plan.id };
    case 'addAudio':
      ctx.commands.addAudio(
        {
          id: `sfx_${plan.sfxId}`,
          name: String(plan.name),
          category: 'sfx',
          src: String(plan.src),
          durationInFrames: Number(plan.durationInFrames),
        },
        { track: plan.track as string | undefined, startFrame: plan.startFrame as number | undefined },
      );
      return { ok: true, kind: 'audio', soundId: plan.sfxId, name: plan.name, startFrame: plan.startFrame };
    case 'addMg': {
      const tpl = ctx.templates.find((t) => t.id === plan.templateId);
      if (!tpl) return { error: `template vanished: ${plan.templateId}` };
      ctx.commands.addMotionGraphic(tpl, {
        track: plan.track as string | undefined,
        startFrame: plan.startFrame as number | undefined,
      });
      return { ok: true, kind: 'motion-graphic', templateId: tpl.id, name: tpl.name, track: plan.track };
    }
    default:
      return { error: `unknown plan ${String(plan.plan)}` };
  }
}

export async function execEditItemTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'edit_item') return { error: `unknown tool ${name}` };
  const validateOnly = args.validateOnly === true;
  const adds = Array.isArray(args.adds) ? args.adds : [];
  const updates = Array.isArray(args.updates) ? args.updates : [];
  const deletes = Array.isArray(args.deletes) ? args.deletes : [];

  if (!adds.length && !updates.length && !deletes.length) {
    return {
      error: 'pass adds, updates, and/or deletes',
      hint: 'browse_library → edit_item adds:[{type:"effect"|"transition"|"motion-graphic"|"audio",...}]',
    };
  }

  // Phase 1 — validate every op (source: one failure rolls back the whole batch)
  const plans: OpResult[] = [];
  for (const raw of adds) {
    if (!raw || typeof raw !== 'object') plans.push({ error: 'invalid add entry' });
    else plans.push(validateAdd(ctx, raw as Record<string, unknown>));
  }
  for (const raw of updates) {
    if (!raw || typeof raw !== 'object') plans.push({ error: 'invalid update entry' });
    else plans.push(validateUpdate(ctx, raw as Record<string, unknown>));
  }
  for (const raw of deletes) {
    if (!raw || typeof raw !== 'object') plans.push({ error: 'invalid delete entry' });
    else plans.push(validateDelete(ctx, raw as Record<string, unknown>));
  }

  const failed = plans.filter((p) => p.error);
  if (failed.length) {
    return {
      ok: false,
      atomic: true,
      validateOnly,
      aborted: true,
      failed: failed.length,
      results: plans,
      note: 'No mutations applied (atomic batch). Fix errors and retry.',
    };
  }

  if (validateOnly) {
    return {
      ok: true,
      atomic: true,
      validateOnly: true,
      wouldApply: plans.length,
      results: plans.map((p) => ({ ok: true, kind: p.kind, plan: p.plan, preview: p })),
    };
  }

  // Phase 2 — commit in order
  const results: OpResult[] = [];
  for (const plan of plans) results.push(commitPlan(ctx, plan));
  const commitFailed = results.filter((r) => r.error);
  return {
    ok: commitFailed.length === 0,
    atomic: true,
    validateOnly: false,
    results,
    ...(commitFailed.length ? { failed: commitFailed.length } : {}),
  };
}
