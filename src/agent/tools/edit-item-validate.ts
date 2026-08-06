import type { AgentContext } from '../context';
import type {
  ClipEffect,
  ClipEffectValue,
  TimelineItem,
  TransitionType,
} from '../../editor/types';
import { defaultTrackId, resolveTrackId } from '../../editor/types';
import { ALL_FX } from '../../gl/fx/effects';
import { SOUND_EFFECTS, soundEffectSrc } from '../../audio/soundLibrary';
import { getCustomTransition, customTransitionUniforms } from '../../gl/customTransitions';
import { getCustomZoom, zoomFromCustomDef } from '../../editor/customZooms';
import {
  AUTHORED_ADD_KINDS,
  GENERIC_ADD_KINDS,
  GENERIC_ITEM_KINDS,
  validateAuthoredAdd,
  validateGenericAdd,
  validateGenericDelete,
  validateGenericUpdate,
  validateSlipUpdate,
} from './edit-item-generic';
import { parseTransitionAssetId, parseZoomLibraryId } from './library-catalog';
import {
  rejectSpecializedUnknownFields,
  resolveUpdateType,
  shouldCoerceEffectUpdateToClip,
  stripEffectLocators,
} from './edit-item-fields';
import {
  cleanOverrides,
  envelopeFrom,
  findAdjacentOutgoing,
  findItem,
  shapeFrom,
  zoomFromOverrides,
  type OpResult,
} from './edit-item-shared';

type Entry = Record<string, unknown>;
type CustomTransition = { frag: string; uniforms: Record<string, number>; label: string };
type ResolvedTransition = { type: TransitionType; custom?: CustomTransition };
type TransitionError = { error: string; hint: string; examples?: string[] };

export function validateAdd(ctx: AgentContext, entry: Entry): OpResult {
  const type = String(entry.type ?? '');
  if (type === 'effect' || type === 'transition') {
    const unknown = rejectSpecializedUnknownFields('adds', type, entry);
    if (unknown) return { error: unknown };
    return type === 'effect' ? validateEffectAdd(ctx, entry) : validateTransitionAdd(ctx, entry);
  }
  if (type === 'motion-graphic') {
    if (/^library:motion-graphic:/.test(String(entry.assetId ?? ''))) {
      const unknown = rejectSpecializedUnknownFields('adds', type, entry);
      return unknown ? { error: unknown } : validateMgAdd(ctx, entry);
    }
    return validateGenericAdd(ctx.getState(), ctx.getDoc().assets ?? [], entry);
  }
  if (type === 'audio' && /^library:sound:/.test(String(entry.assetId ?? ''))) {
    const unknown = rejectSpecializedUnknownFields('adds', type, entry);
    return unknown ? { error: unknown } : validateAudioAdd(ctx, entry);
  }
  if (AUTHORED_ADD_KINDS.has(type)) return validateAuthoredAdd(ctx.getState(), entry);
  if (GENERIC_ADD_KINDS.has(type)) return validateGenericAdd(ctx.getState(), ctx.getDoc().assets ?? [], entry);
  return {
    error: `add type not supported: ${type}`,
    supported: ['video', 'image', 'gif', 'svg', 'audio', 'text', 'solid', 'effect', 'transition', 'motion-graphic'],
  };
}

export function validateUpdate(ctx: AgentContext, entry: Entry): OpResult {
  if (entry.operation !== undefined) return validateSlipUpdate(ctx.getState(), entry);
  const item = findItem(ctx.getState().items, entry.itemId ?? entry.id ?? entry.targetItemId);
  const type = resolveUpdateType(entry, item?.kind, GENERIC_ITEM_KINDS);
  // Common LLM mistake: type:"effect" (or default effect) + volume/timing on a real clip.
  if (shouldCoerceEffectUpdateToClip(entry, type, item?.kind, GENERIC_ITEM_KINDS) && item) {
    return validateGenericUpdate(ctx.getState(), stripEffectLocators(entry, item.kind, item.id));
  }
  if (type === 'transition' || type === 'effect') {
    const unknown = rejectSpecializedUnknownFields('updates', type, entry);
    if (unknown) return { error: unknown };
    return type === 'transition' ? validateTransitionUpdate(ctx, entry) : validateEffectUpdate(ctx, entry);
  }
  if (GENERIC_ITEM_KINDS.has(type)) {
    // Effect-style locators (targetItemId) are not generic update fields: normalize
    // when the live item resolved, so {volume, targetItemId} rows survive validation.
    return validateGenericUpdate(ctx.getState(), item ? stripEffectLocators(entry, type, item.id) : entry);
  }
  return {
    error: `update type not supported: ${type}`,
    supported: [...GENERIC_ITEM_KINDS, 'effect', 'transition'],
    hint: 'type must be the item\'s actual kind (video/audio/image/gif/svg/text/solid/motion-graphic), never the literal "generic" or "clip"',
  };
}

export function validateDelete(ctx: AgentContext, entry: Entry): OpResult {
  const type = String(entry.type ?? '');
  if (type === 'transition' || type === 'effect' || !type) {
    const unknown = rejectSpecializedUnknownFields('deletes', type, entry);
    if (unknown) return { error: unknown };
  }
  if (type === 'transition') return validateTransitionDelete(ctx, entry);
  if (GENERIC_ITEM_KINDS.has(type)) return validateGenericDelete(ctx.getState(), entry);
  if (type !== 'effect' && type) return { error: `delete unsupported type ${type}` };
  const assetId = String(entry.assetId ?? '');
  if (assetId === 'builtin:zoom' || parseZoomLibraryId(assetId)) {
    const item = findItem(ctx.getState().items, entry.targetItemId);
    if (!item) return { error: 'zoom delete needs targetItemId' };
    return { ok: true, kind: 'zoom', plan: 'clearZoom', targetItemId: item.id };
  }
  const effectId = String(entry.id ?? entry.effectId ?? '');
  const item = findEffectOwner(ctx, entry.targetItemId, effectId);
  if (!item) return { error: 'effect delete needs targetItemId or effect id' };
  const effects = filterDeletedEffects(item, effectId, assetId);
  return {
    ok: true,
    kind: 'effect',
    plan: 'setEffects',
    targetItemId: item.id,
    effects,
    remaining: effects.length,
  };
}

function validateEffectAdd(ctx: AgentContext, entry: Entry): OpResult {
  const assetId = String(entry.assetId ?? '');
  const overrides = cleanOverrides(entry.propertyOverrides);
  const zoomShape = parseZoomLibraryId(assetId);
  const customZoom = assetId.startsWith('plugin:') ? getCustomZoom(assetId) : undefined;
  if (zoomShape || assetId === 'builtin:zoom' || customZoom) {
    const target = findItem(ctx.getState().items, entry.targetItemId);
    if (!target || target.kind === 'audio') {
      return { error: 'zoom needs a visual targetItemId', got: entry.targetItemId };
    }
    if (customZoom) {
      const magnification = typeof overrides.magnification === 'number' ? overrides.magnification : undefined;
      const zoom = { ...zoomFromCustomDef(customZoom, magnification), shape: undefined };
      return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: target.id, zoom };
    }
    return planBuiltInZoom(target, entry, zoomShape ?? 'hold', overrides);
  }
  const target = findItem(ctx.getState().items, entry.targetItemId);
  if (!target || (target.kind !== 'video' && target.kind !== 'image')) {
    return { error: 'effect needs video/image targetItemId', got: entry.targetItemId };
  }
  if (!(assetId in ALL_FX)) {
    return { error: `unknown effect assetId ${assetId}`, hint: 'browse_library category=fx|luts|zoom' };
  }
  const effect = { id: `fx_${crypto.randomUUID()}`, assetId, overrides } satisfies ClipEffect;
  return { ok: true, kind: 'effect', plan: 'addEffect', targetItemId: target.id, effect };
}

function planBuiltInZoom(
  target: TimelineItem,
  entry: Entry,
  fallbackShape: NonNullable<ReturnType<typeof parseZoomLibraryId>>,
  overrides: Record<string, ClipEffectValue>,
): OpResult {
  const shape = shapeFrom(entry.propertyOverrides) ?? fallbackShape;
  const zoom = zoomFromOverrides(shape, overrides);
  const envelope = envelopeFrom(entry.propertyOverrides);
  const plannedZoom = envelope ? { ...zoom, shape: undefined, envelope } : zoom;
  return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: target.id, zoom: plannedZoom };
}

function resolveTransition(assetId: string): ResolvedTransition | TransitionError {
  if (!assetId.startsWith('custom:tr-') && !assetId.startsWith('plugin:')) {
    const type = parseTransitionAssetId(assetId);
    if (type) return { type };
    return {
      error: `unknown transition assetId ${assetId}`,
      hint: 'Use builtin:tr-<type> from browse_library category=transitions, or custom:tr-* from submit_shader type=transition',
      examples: ['builtin:tr-cross-dissolve', 'builtin:tr-page-curl'],
    };
  }
  const definition = getCustomTransition(assetId);
  if (definition) {
    return {
      type: 'custom-shader',
      custom: {
        frag: definition.frag,
        uniforms: customTransitionUniforms(definition),
        label: definition.label,
      },
    };
  }
  return assetId.startsWith('plugin:')
    ? { error: `unknown plugin transition ${assetId}`, hint: '该插件未安装或该 id 不是转场条目;用 browse_library category=transitions 查可用清单' }
    : { error: `unknown custom transition ${assetId}`, hint: 'submit_shader type=transition returns a fresh custom:tr-* id; generate it first, then add it this session' };
}

function resolveIncoming(ctx: AgentContext, entry: Entry): TimelineItem | null {
  const state = ctx.getState();
  const direct = findItem(state.items, entry.incomingItemId);
  if (direct || entry.trackId == null || entry.fromFrame == null) return direct;
  const track = String(entry.trackId);
  const frame = Number(entry.fromFrame);
  return state.items
    .filter((item) => item.track === track && item.kind !== 'audio' && Math.abs(item.startFrame - frame) <= 2)
    .sort((a, b) => a.startFrame - b.startFrame)[0] ?? null;
}

function validateTransitionAdd(ctx: AgentContext, entry: Entry): OpResult {
  const assetId = String(entry.assetId ?? '');
  const resolved = resolveTransition(assetId);
  if ('error' in resolved) return resolved;
  const state = ctx.getState();
  const incoming = resolveIncoming(ctx, entry);
  if (!incoming || incoming.kind === 'audio') {
    return { error: 'transition needs incomingItemId (the later clip at the cut)' };
  }
  if (entry.outgoingItemId && !findItem(state.items, entry.outgoingItemId)) {
    return { error: `outgoingItemId not found: ${entry.outgoingItemId}` };
  }
  const outgoing = findAdjacentOutgoing(state.items, incoming);
  if (!outgoing) {
    return {
      error: `no adjacent prior clip before ${incoming.id} on track ${incoming.track}`,
      hint: 'Transition straddles a cut between two same-track visual clips',
    };
  }
  const requestedOutgoing = entry.outgoingItemId
    ? findItem(state.items, entry.outgoingItemId)
    : null;
  if (requestedOutgoing && requestedOutgoing.id !== outgoing.id) {
    return { error: `outgoingItemId ${entry.outgoingItemId} is not the adjacent prior clip (found ${outgoing.id})` };
  }
  return transitionPlan(entry, assetId, incoming, outgoing, resolved);
}

function transitionPlan(
  entry: Entry,
  assetId: string,
  incoming: TimelineItem,
  outgoing: TimelineItem,
  resolved: ResolvedTransition,
): OpResult {
  const maxDuration = Math.max(2, Math.min(outgoing.durationInFrames, incoming.durationInFrames));
  const defaultDuration = resolved.type === 'audio-cross-fade' ? Math.min(15, maxDuration) : Math.min(30, maxDuration);
  const requested = typeof entry.durationInFrames === 'number' && Number.isFinite(entry.durationInFrames)
    ? entry.durationInFrames
    : defaultDuration;
  return {
    ok: true,
    kind: 'transition',
    plan: 'addTransition',
    incomingItemId: incoming.id,
    outgoingItemId: outgoing.id,
    type: resolved.type,
    assetId,
    durationInFrames: Math.max(2, Math.min(requested, maxDuration)),
    ...(resolved.custom ? { custom: resolved.custom } : {}),
  };
}

function validateAudioAdd(ctx: AgentContext, entry: Entry): OpResult {
  const assetId = String(entry.assetId ?? '');
  const match = /^library:sound:(.+)$/.exec(assetId);
  if (!match) return { error: 'audio add expects library:sound:<id>', got: assetId };
  const sound = SOUND_EFFECTS.find((entry) => entry.id === match[1]);
  if (!sound) return { error: `unknown sound ${match[1]}` };
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
    ok: true, kind: 'audio', plan: 'addAudio', sfxId: sound.id, name: sound.name,
    src: soundEffectSrc(sound.id), durationInFrames: Math.max(1, Math.round(sound.seconds * state.fps)),
    startFrame, track,
  };
}

function validateMgAdd(ctx: AgentContext, entry: Entry): OpResult {
  const assetId = String(entry.assetId ?? '');
  const match = /^library:motion-graphic:(.+)$/.exec(assetId);
  if (!match) return { error: 'motion-graphic add expects library:motion-graphic:<id>', got: assetId };
  const id = match[1];
  const template = ctx.templates.find((item) => item.id === id || item.id.startsWith(id) || item.name === id)
    ?? ctx.templates.find((item) => item.name.toLowerCase() === id.toLowerCase());
  if (!template) return { error: `unknown motion-graphic ${id}`, hint: 'browse_library category=motion-graphics' };
  const state = ctx.getState();
  const track = resolveTrackId(state, entry.track ?? entry.trackId ?? 'V1', 'video') ?? defaultTrackId(state, 'video');
  if (!track) return { error: 'no video track; create one with edit_track first' };
  const startFrame = typeof entry.fromFrame === 'number'
    ? entry.fromFrame
    : typeof entry.startFrame === 'number' ? entry.startFrame : undefined;
  return {
    ok: true, kind: 'motion-graphic', plan: 'addMg', templateId: template.id,
    name: template.name, track, startFrame,
  };
}

function planZoomUpdate(target: TimelineItem | null, entry: Entry): OpResult | null {
  const overrides = cleanOverrides(entry.propertyOverrides);
  const envelope = envelopeFrom(entry.propertyOverrides);
  const isZoom = entry.assetId === 'builtin:zoom'
    || Boolean(parseZoomLibraryId(String(entry.assetId ?? '')))
    || Boolean(target?.zoom && !String(entry.id ?? entry.effectId ?? '') && (Object.keys(overrides).length || envelope));
  if (!isZoom) return null;
  if (!target) return { error: 'zoom update needs targetItemId' };
  const shapeOverride = shapeFrom(entry.propertyOverrides);
  const shape = shapeOverride ?? target.zoom?.shape ?? 'hold';
  const zoom = zoomFromOverrides(shape, { ...(target.zoom as object), ...overrides } as Record<string, ClipEffectValue>);
  const merged = { ...target.zoom, ...zoom };
  if (envelope) {
    return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: target.id, zoom: { ...merged, shape: undefined, envelope } };
  }
  if (shapeOverride && merged.envelope) {
    return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: target.id, zoom: { ...merged, envelope: undefined, label: undefined } };
  }
  return { ok: true, kind: 'zoom', plan: 'setZoom', targetItemId: target.id, zoom: merged };
}

function findEffect(ctx: AgentContext, target: TimelineItem | null, effectId: string) {
  if (target) {
    const index = (target.effects ?? []).findIndex((effect) =>
      !effectId || effect.id === effectId || effect.id.startsWith(effectId));
    return { item: target, index };
  }
  if (effectId) {
    for (const item of ctx.getState().items) {
      const index = (item.effects ?? []).findIndex((effect) => effect.id === effectId || effect.id.startsWith(effectId));
      if (index >= 0) return { item, index };
    }
  }
  return { item: target, index: -1 };
}

function validateEffectUpdate(ctx: AgentContext, entry: Entry): OpResult {
  const target = findItem(ctx.getState().items, entry.targetItemId);
  const zoomPlan = planZoomUpdate(target, entry);
  if (zoomPlan) return zoomPlan;
  const effectId = String(entry.id ?? entry.effectId ?? '');
  const { item, index } = findEffect(ctx, target, effectId);
  if (!item || index < 0) return effectNotFound(item);
  const current = item.effects![index];
  const nextAsset = typeof entry.assetId === 'string' && entry.assetId in ALL_FX
    ? String(entry.assetId)
    : current.assetId;
  const overrides = cleanOverrides(entry.propertyOverrides);
  const effect = { ...current, assetId: nextAsset, overrides: { ...current.overrides, ...overrides } } satisfies ClipEffect;
  return { ok: true, kind: 'effect', plan: 'updateEffect', targetItemId: item.id, index, effect };
}

function effectNotFound(item: TimelineItem | null): OpResult {
  return {
    error: 'effect update: effect not found',
    hint: item && !(item.effects ?? []).length
      ? `item ${item.id} has no effects yet — add one via adds:[{type:"effect",targetItemId:"${item.id}",assetId}]`
      : 'pass effectId (or targetItemId owning the effect); existingEffects lists what is there now',
    existingEffects: item ? (item.effects ?? []).map((effect) => ({ id: effect.id, assetId: effect.assetId })) : [],
  };
}

function validateTransitionUpdate(ctx: AgentContext, entry: Entry): OpResult {
  const id = String(entry.id ?? '');
  const transition = ctx.getState().transitions?.find((item) => item.id === id || item.id.startsWith(id));
  if (!transition) return { error: `transition not found: ${id}` };
  const patch: Record<string, unknown> = {};
  if (typeof entry.durationInFrames === 'number') patch.durationInFrames = entry.durationInFrames;
  if (typeof entry.assetId === 'string') {
    const type = parseTransitionAssetId(entry.assetId);
    if (!type) return { error: `unknown transition assetId ${entry.assetId}` };
    patch.type = type;
  }
  if (typeof entry.transitionType === 'string') {
    const type = parseTransitionAssetId(entry.transitionType) ?? entry.transitionType as TransitionType;
    if (type) patch.type = type;
  }
  return { ok: true, kind: 'transition', plan: 'setTransition', id: transition.id, patch };
}

function validateTransitionDelete(ctx: AgentContext, entry: Entry): OpResult {
  const id = String(entry.id ?? '');
  const transition = ctx.getState().transitions?.find((item) => item.id === id || item.id.startsWith(id));
  if (!transition) return { error: `transition not found: ${id}` };
  return { ok: true, kind: 'transition', plan: 'removeTransition', id: transition.id };
}

function findEffectOwner(ctx: AgentContext, targetId: unknown, effectId: string): TimelineItem | null {
  const target = findItem(ctx.getState().items, targetId);
  if (target || !effectId) return target;
  return ctx.getState().items.find((item) =>
    (item.effects ?? []).some((effect) => effect.id === effectId || effect.id.startsWith(effectId))) ?? null;
}

function filterDeletedEffects(item: TimelineItem, effectId: string, assetId: string): ClipEffect[] {
  const effects = item.effects ?? [];
  if (effectId) return effects.filter((effect) => effect.id !== effectId && !effect.id.startsWith(effectId));
  if (assetId) return effects.filter((effect) => effect.assetId !== assetId);
  return [];
}
