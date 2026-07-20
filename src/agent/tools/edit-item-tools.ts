import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../context';
import type { ClipEffect, ClipEffectValue, TimelineItem, TransitionType, ZoomEffect, ZoomShape } from '../../editor/types';
import { defaultTrackId, resolveTrackId } from '../../editor/types';
import { ALL_FX } from '../../gl/fx/effects';
import {
  parseTransitionAssetId,
  parseZoomLibraryId,
  transitionAssetId,
} from './library-catalog';
import { SOUND_EFFECTS, soundEffectSrc } from '../../audio/soundLibrary';
import { GENERIC_ITEM_KINDS, GENERIC_ADD_KINDS, validateGenericAdd, validateGenericUpdate, validateGenericDelete, applyGeneric } from './edit-item-generic';
import { getCustomTransition, customTransitionUniforms } from '../../gl/customTransitions';
import { getCustomZoom, zoomFromCustomDef } from '../../editor/customZooms';

// edit_item handles library placement for effects, transitions, zoom, MG, and SFX.
// Batch is atomic: every op is validated first; on any failure nothing mutates
// A single validation failure rolls the whole batch back.

type Args = Record<string, unknown>;
type OpResult = Record<string, unknown>;

export const EDIT_ITEM_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'edit_item',
    description:
      'Unified item-level operations across video, image, audio, gif, svg, motion-graphic, effect, and transition types. '
      + 'adds place library items (effect/transition/zoom/MG/SFX) OR a POOL asset as a clip (type=video|image|gif|svg|audio, assetId=<pool id/prefix>, trackId|track?, fromFrame|startFrame?, durationInFrames?). '
      + 'updates move/trim/retime by itemId|id — NEVER pass assetId on update (rejected). To replace media: one batch deletes:[{id}] + adds:[{type,assetId,fromFrame,durationInFrames,trackId,…copied layout}]. '
      + 'fromFrame is the canonical timing field (startFrame is accepted as an alias). Unknown fields fail the whole atomic batch with "unknown field" + Did you mean. '
      + 'validateOnly dry-runs. Mutating ops go through propose→apply. split_item cuts clips.',
    input_schema: {
      type: 'object',
      properties: {
        adds: {
          type: 'array',
          description:
            'effect: {type,targetItemId,assetId,propertyOverrides?}. transition: {type,assetId,incomingItemId,outgoingItemId?,durationInFrames?}. motion-graphic: {type,assetId:library:motion-graphic:*,track?,startFrame?}. audio SFX: {type:"audio",assetId:library:sound:*,fromFrame?}. POOL media B-roll (video/image/gif/svg/audio): {type,assetId,track|trackId?,fromFrame|startFrame?,durationInFrames?} — no name/props fields on adds (place first, then set props via update_item_props); fromFrame omitted appends.',
          items: { type: 'object' },
        },
        updates: {
          type: 'array',
          description:
            'Generic clip: {type,itemId|id,track|trackId?,fromFrame|startFrame?,durationInFrames?,srcInFrame?,props?,volume?,fadeInSeconds?,fadeOutSeconds?,keyframes?}. '
            + 'Do NOT set assetId (use deletes+adds to replace media). keyframes: {x|y|scale|rotation|opacity:[{frame,value,easing?}]} item-local frames; x/y are % of canvas in -400..400 (NOT px). '
            + 'No CSS layout fields (left/right/top/bottom/width/height) — position clips via keyframes x/y or transform props; layout INSIDE an MG belongs in its code/props. '
            + 'effect/transition/zoom updates as before (effect assetId swap is for FX stack, not clip media).',
          items: { type: 'object' },
        },
        deletes: {
          type: 'array',
          description:
            'Generic clip: {type,itemId|id,ripple?} (ripple closes the gap). effect: {type:"effect",id|effectId,targetItemId?} or clear with targetItemId only. transition: {type:"transition",id}. zoom: {type:"effect",targetItemId,assetId:"builtin:zoom"}.',
          items: { type: 'object' },
        },
        ripple: {
          type: 'boolean',
          description:
            'When true, MG/audio adds push later same-track items (insert). Do not combine with validateOnly.',
        },
        validateOnly: {
          type: 'boolean',
          description: 'If true, validate only — never mutate. Same validation runs before every real commit.',
        },
        projectId: { type: 'string', description: 'Ignored; the active project is used.' },
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

// envelope/shape 走 RAW propertyOverrides(cleanOverrides 只留数字与 ≤4 位数组,
// 会吞掉 2..120 位包络和字符串 shape)。
const ZOOM_ENVELOPE_MAX_POINTS = 120;
function envelopeFrom(raw: unknown): number[] | undefined {
  const env = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).envelope : undefined;
  if (!Array.isArray(env) || env.length < 2 || env.length > ZOOM_ENVELOPE_MAX_POINTS) return undefined;
  if (!env.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1.5)) return undefined;
  return env as number[];
}
function shapeFrom(raw: unknown): ZoomShape | undefined {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).shape : undefined;
  return typeof s === 'string' && parseZoomLibraryId(`library:zoom:${s}`) ? (s as ZoomShape) : undefined;
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
  const assetId = String(entry.assetId ?? '');
  const ov = cleanOverrides(entry.propertyOverrides);
  const zoomShape = parseZoomLibraryId(assetId);
  const customZoom = assetId.startsWith('plugin:') ? getCustomZoom(assetId) : undefined;
  // 缩放对所有画面片段有效，不受下方 fx 的 video/image 门限制
  if (zoomShape || assetId === 'builtin:zoom' || customZoom) {
    const zTarget = findItem(ctx.getState().items, entry.targetItemId);
    if (!zTarget || zTarget.kind === 'audio') {
      return { error: 'zoom needs a visual targetItemId', got: entry.targetItemId };
    }
    if (customZoom) {
      const mag = typeof ov.magnification === 'number' ? ov.magnification : undefined;
      return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: zTarget.id, zoom: { ...zoomFromCustomDef(customZoom, mag), shape: undefined } };
    }
    const shape = shapeFrom(entry.propertyOverrides) ?? zoomShape ?? 'hold';
    const zoom = zoomFromOverrides(shape, ov);
    // envelope 入参:agent 可直接作曲线(整段 clip 0..1 线性采样,优先于 shape)
    const rawEnvelope = envelopeFrom(entry.propertyOverrides);
    if (rawEnvelope) {
      // reducer setZoom 是合并语义:摘字段必须显式 undefined
      return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: zTarget.id, zoom: { ...zoom, shape: undefined, envelope: rawEnvelope } };
    }
    return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: zTarget.id, zoom };
  }
  const target = findItem(ctx.getState().items, entry.targetItemId);
  if (!target || (target.kind !== 'video' && target.kind !== 'image')) {
    return { error: 'effect needs video/image targetItemId', got: entry.targetItemId };
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
  // custom:tr-*(submit_shader 产物)与 plugin:<pack>/<item>(已装插件转场)都在
  // custom 注册表里;解析出 GLSL 让 plan 把 frag 快照上 TransitionItem(离开注册表也能渲染)。
  let type: TransitionType | null;
  let custom: { frag: string; uniforms: Record<string, number>; label: string } | undefined;
  if (assetId.startsWith('custom:tr-') || assetId.startsWith('plugin:')) {
    const cdef = getCustomTransition(assetId);
    if (!cdef) {
      return assetId.startsWith('plugin:')
        ? { error: `unknown plugin transition ${assetId}`, hint: '该插件未安装或该 id 不是转场条目;用 browse_library category=transitions 查可用清单' }
        : { error: `unknown custom transition ${assetId}`, hint: 'submit_shader type=transition returns a fresh custom:tr-* id; generate it first, then add it this session' };
    }
    type = 'custom-shader';
    custom = { frag: cdef.frag, uniforms: customTransitionUniforms(cdef), label: cdef.label };
  } else {
    type = parseTransitionAssetId(assetId);
    if (!type) {
      return {
        error: `unknown transition assetId ${assetId}`,
        hint: 'Use builtin:tr-<type> from browse_library category=transitions, or custom:tr-* from submit_shader type=transition',
        examples: ['builtin:tr-cross-dissolve', 'builtin:tr-page-curl'],
      };
    }
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
  const maxDuration = Math.max(2, Math.min(adj.durationInFrames, incoming.durationInFrames));
  const defaultDuration = type === 'audio-cross-fade' ? Math.min(15, maxDuration) : Math.min(30, maxDuration);
  const requestedDuration = typeof entry.durationInFrames === 'number' && Number.isFinite(entry.durationInFrames)
    ? entry.durationInFrames
    : defaultDuration;
  const dur = Math.max(2, Math.min(requestedDuration, maxDuration));
  return {
    ok: true,
    kind: 'transition',
    plan: 'addTransition',
    incomingItemId: incoming.id,
    outgoingItemId: adj.id,
    type,
    assetId,
    durationInFrames: dur,
    ...(custom ? { custom } : {}),
  };
}

function validateAudioAdd(ctx: AgentContext, entry: Record<string, unknown>): OpResult {
  const assetId = String(entry.assetId ?? '');
  const m = /^library:sound:(.+)$/.exec(assetId);
  if (!m) return { error: 'audio add expects library:sound:<id>', got: assetId };
  const sfx = SOUND_EFFECTS.find((s) => s.id === m[1]);
  if (!sfx) return { error: `unknown sound ${m[1]}` };
  const state = ctx.getState();
  const requestedTrack = entry.track ?? entry.trackId ?? 'A1';
  const resolvedTrack = resolveTrackId(state, requestedTrack, 'audio');
  if ((entry.track != null || entry.trackId != null) && !resolvedTrack) {
    return { error: `audio track "${String(requestedTrack)}" not found; call edit_track action=list` };
  }
  const track = resolvedTrack ?? defaultTrackId(state, 'audio');
  if (!track) return { error: 'no audio track; create one with edit_track first' };
  const startFrame = typeof entry.fromFrame === 'number'
    ? entry.fromFrame
    : typeof entry.startFrame === 'number' ? entry.startFrame : undefined;
  return {
    ok: true,
    kind: 'audio',
    plan: 'addAudio',
    sfxId: sfx.id,
    name: sfx.name,
    src: soundEffectSrc(sfx.id),
    durationInFrames: Math.max(1, Math.round(sfx.seconds * state.fps)),
    startFrame,
    track,
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

  const rawEnvelope = envelopeFrom(entry.propertyOverrides);
  if (entry.assetId === 'builtin:zoom' || parseZoomLibraryId(String(entry.assetId ?? ''))
    || (target?.zoom && !effectId && (Object.keys(ov).length > 0 || rawEnvelope !== undefined))) {
    const it = target ?? findItem(ctx.getState().items, entry.targetItemId);
    if (!it) return { error: 'zoom update needs targetItemId' };
    const shapeOv = shapeFrom(entry.propertyOverrides);
    const shape = shapeOv ?? it.zoom?.shape ?? 'hold';
    const zoom = zoomFromOverrides(shape, { ...(it.zoom as object), ...ov } as Record<string, ClipEffectValue>);
    const merged = { ...it.zoom, ...zoom };
    // 显式 envelope → 曲线赢(丢 shape);显式 shape → 曲线让位(丢 envelope)
    if (rawEnvelope) {
      return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: it.id, zoom: { ...merged, shape: undefined, envelope: rawEnvelope } };
    }
    if (shapeOv && merged.envelope) {
      return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: it.id, zoom: { ...merged, envelope: undefined, label: undefined } };
    }
    return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: it.id, zoom: merged };
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
  // 实况教训:模型常对"还没有特效的片段"发 effect update → 回喂现有特效清单/加法指引
  if (!it || index < 0) {
    return {
      error: 'effect update: effect not found',
      hint: it && !(it.effects ?? []).length
        ? `item ${it.id} has no effects yet — add one via adds:[{type:"effect",targetItemId:"${it.id}",assetId}]`
        : 'pass effectId (or targetItemId owning the effect); existingEffects lists what is there now',
      existingEffects: it ? (it.effects ?? []).map((e) => ({ id: e.id, assetId: e.assetId })) : [],
    };
  }
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
  if (GENERIC_ITEM_KINDS.has(type)) return validateGenericDelete(ctx.getState(), entry);
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
  // MG: library template id vs pool asset from submit_motion_graphic / from_code.
  if (t === 'motion-graphic') {
    if (/^library:motion-graphic:/.test(String(entry.assetId ?? ''))) return validateMgAdd(ctx, entry);
    return validateGenericAdd(ctx.getState(), ctx.getDoc().assets ?? [], entry);
  }
  // audio: a library SFX (library:sound:*) vs an uploaded/generated pool audio asset.
  if (t === 'audio' && /^library:sound:/.test(String(entry.assetId ?? ''))) return validateAudioAdd(ctx, entry);
  // video/image/gif/svg/audio(/pool MG) pool-asset placement — the edit_item path.
  if (GENERIC_ADD_KINDS.has(t)) return validateGenericAdd(ctx.getState(), ctx.getDoc().assets ?? [], entry);
  return { error: `add type not supported: ${t}`, supported: ['video', 'image', 'gif', 'svg', 'audio', 'effect', 'transition', 'motion-graphic'] };
}

function validateUpdate(ctx: AgentContext, entry: Record<string, unknown>): OpResult {
  const t = String(entry.type ?? 'effect');
  if (t === 'transition') return validateTransitionUpdate(ctx, entry);
  if (GENERIC_ITEM_KINDS.has(t)) return validateGenericUpdate(ctx.getState(), entry);
  if (t === 'effect') return validateEffectUpdate(ctx, entry);
  return { error: `update type not supported: ${t}` };
}

// ── commit plans ───────────────────────────────────────────────────────────

function commitPlan(ctx: AgentContext, plan: OpResult, ripple = false): OpResult {
  if (!plan.ok || plan.error) return plan;
  switch (plan.plan) {
    case 'setZoom':
      ctx.commands.setItemZoom(String(plan.targetItemId), plan.zoom as ZoomEffect);
      return {
        ok: true,
        kind: 'zoom',
        ...describeClip({
          ...(findItem(ctx.getState().items, plan.targetItemId) ?? { id: String(plan.targetItemId) } as TimelineItem),
          zoom: plan.zoom as ZoomEffect,
        }),
        applied: plan.zoom,
      };
    case 'addEffect': {
      const it = findItem(ctx.getState().items, plan.targetItemId)!;
      const effect = plan.effect as ClipEffect;
      const nextEffects = [...(it.effects ?? []), effect];
      ctx.commands.setItemEffects(it.id, nextEffects);
      return { ok: true, kind: 'effect', ...describeClip({ ...it, effects: nextEffects }) };
    }
    case 'updateEffect': {
      const it = findItem(ctx.getState().items, plan.targetItemId)!;
      const index = Number(plan.index);
      const next = plan.effect as ClipEffect;
      const nextEffects = (it.effects ?? []).map((fx, i) => (i === index ? next : fx));
      ctx.commands.setItemEffects(it.id, nextEffects);
      return { ok: true, kind: 'effect', ...describeClip({ ...it, effects: nextEffects }) };
    }
    case 'setEffects':
      ctx.commands.setItemEffects(String(plan.targetItemId), plan.effects as ClipEffect[]);
      return { ok: true, deleted: 'effect', itemId: plan.targetItemId, remaining: plan.remaining };
    case 'clearZoom':
      ctx.commands.setItemZoom(String(plan.targetItemId), null);
      return { ok: true, deleted: 'zoom', itemId: plan.targetItemId };
    case 'addTransition': {
      const id = ctx.commands.addTransition(
        String(plan.incomingItemId),
        plan.type as TransitionType,
        plan.durationInFrames as number | undefined,
        plan.custom as { frag: string; uniforms: Record<string, number>; label: string } | undefined,
      );
      return {
        ok: true,
        kind: 'transition',
        transition: {
          id,
          type: plan.type,
          assetId: plan.assetId ?? transitionAssetId(plan.type as TransitionType),
          durationInFrames: plan.durationInFrames,
          outgoingItemId: plan.outgoingItemId,
          incomingItemId: plan.incomingItemId,
        },
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
        {
          track: plan.track as string | undefined,
          startFrame: plan.startFrame as number | undefined,
          ripple,
        },
      );
      return { ok: true, kind: 'audio', soundId: plan.sfxId, name: plan.name, startFrame: plan.startFrame, ripple };
    case 'addMg': {
      const tpl = ctx.templates.find((t) => t.id === plan.templateId);
      if (!tpl) return { error: `template vanished: ${plan.templateId}` };
      ctx.commands.addMotionGraphic(tpl, {
        track: plan.track as string | undefined,
        startFrame: plan.startFrame as number | undefined,
        ripple,
      });
      return { ok: true, kind: 'motion-graphic', templateId: tpl.id, name: tpl.name, track: plan.track, ripple };
    }
    case 'addMedia': {
      // Place a pool asset (video/image/gif/svg/audio/motion-graphic) as a clip.
      // durationInFrames (if the plan carries it) is applied via an asset copy so
      // addMediaItem stamps it directly — no need to find the freshly-created item id afterward.
      const asset = (ctx.getDoc().assets ?? []).find((a) => a.id === plan.assetId);
      if (!asset) return { error: `pool asset vanished: ${String(plan.assetId)}` };
      const placed = typeof plan.durationInFrames === 'number'
        ? { ...asset, durationInFrames: Number(plan.durationInFrames) }
        : asset;
      const itemId = ctx.commands.addMediaItem(placed, { track: plan.track as string, startFrame: plan.startFrame as number | undefined });
      return {
        ok: true,
        kind: plan.kind,
        placed: {
          assetId: asset.id,
          itemId,
          name: asset.name,
          kind: asset.kind,
          track: plan.track,
          startFrame: plan.startFrame ?? 'appended',
          durationInFrames: placed.durationInFrames,
        },
      };
    }
    case 'genericUpdate':
    case 'genericDelete': {
      const applied = applyGeneric(plan, ctx.commands);
      return applied ?? { error: `unknown plan ${String(plan.plan)}` };
    }
    default:
      return { error: `unknown plan ${String(plan.plan)}` };
  }
}

export async function execEditItemTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'edit_item') return { error: `unknown tool ${name}` };
  const validateOnly = args.validateOnly === true;
  const ripple = args.ripple === true;
  if (validateOnly && ripple) {
    return { error: 'do not combine validateOnly with ripple' };
  }
  const adds = Array.isArray(args.adds) ? args.adds : [];
  const updates = Array.isArray(args.updates) ? args.updates : [];
  const deletes = Array.isArray(args.deletes) ? args.deletes : [];

  if (!adds.length && !updates.length && !deletes.length) {
    return {
      error: 'pass adds, updates, and/or deletes',
      hint: 'browse_library → edit_item adds:[{type:"effect"|"transition"|"motion-graphic"|"audio",...}]',
    };
  }

  // Phase 1: validate every operation; one failure rolls back the whole batch.
  // Path-prefix errors like "updates[0]: …" match the live agent feedback shape.
  const plans: OpResult[] = [];
  const pathOf = (bucket: string, i: number, err: string) =>
    err.startsWith(`${bucket}[`) ? err : `${bucket}[${i}]: ${err}`;

  for (let i = 0; i < adds.length; i++) {
    const raw = adds[i];
    if (!raw || typeof raw !== 'object') plans.push({ error: pathOf('adds', i, 'invalid add entry') });
    else {
      const r = validateAdd(ctx, raw as Record<string, unknown>);
      plans.push(r.error ? { ...r, error: pathOf('adds', i, String(r.error)) } : r);
    }
  }
  for (let i = 0; i < updates.length; i++) {
    const raw = updates[i];
    if (!raw || typeof raw !== 'object') plans.push({ error: pathOf('updates', i, 'invalid update entry') });
    else {
      const r = validateUpdate(ctx, raw as Record<string, unknown>);
      plans.push(r.error ? { ...r, error: pathOf('updates', i, String(r.error)) } : r);
    }
  }
  for (let i = 0; i < deletes.length; i++) {
    const raw = deletes[i];
    if (!raw || typeof raw !== 'object') plans.push({ error: pathOf('deletes', i, 'invalid delete entry') });
    else {
      const r = validateDelete(ctx, raw as Record<string, unknown>);
      plans.push(r.error ? { ...r, error: pathOf('deletes', i, String(r.error)) } : r);
    }
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
      // Lead with one actionable error so the agent can fix and retry.
      error: String(failed[0]!.error),
      note: 'No mutations applied (atomic batch). Fix errors and retry. Use only supported fields from the edit_item schema.',
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
  for (const plan of plans) results.push(commitPlan(ctx, plan, ripple));
  const commitFailed = results.filter((r) => r.error);
  return {
    ok: commitFailed.length === 0,
    atomic: true,
    validateOnly: false,
    ripple,
    results,
    ...(commitFailed.length ? { failed: commitFailed.length } : {}),
  };
}
