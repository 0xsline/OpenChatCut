// Pure validation for generic edit_item adds/updates/deletes; kept separate from
// edit-item-tools.ts so unit checks avoid its GL .frag dependency.
// Committers delegate to EditorCommands, preserving atomic-batch semantics.
import type {
  ItemKeyframes, Keyframe, KeyframeProp, MediaAsset, TimelineItem, TimelineState,
} from '../../editor/types';
import { defaultTrackId, resolveTrackId } from '../../editor/types';
import { isValidEasing } from '../../editor/keyframes';
import { validateBackgroundFillUpdate } from './edit-item-background-fill';
import { getKeyframePropertyDefinition, KEYFRAME_PROPS, supportsKeyframeProperty } from '../../editor/keyframeRegistry';
import { planSlip } from '../../editor/slip';
import { rejectUnknownFields } from './edit-item-fields';
import { clampNum, parseFiltersArg, parseTransformArg } from './edit-item-visual';
import { validateMediaSourceUpdate } from './edit-item-media-ops';
import { validateSourceFrameUpdate, validateSourceWindow } from './edit-item-source-window';
import { validatePoolAssetReplacement } from './edit-item-pool-replacement';
import { slipFailureToOpResult, type OpResult } from './edit-item-generic-result';
export { didYouMean, rejectUnknownFields } from './edit-item-fields';
export { validateMediaSourceUpdate } from './edit-item-media-ops';
export { applyGeneric, type GenericCommands } from './edit-item-generic-actions';

export const GENERIC_ITEM_KINDS: ReadonlySet<string> = new Set([
  'video', 'image', 'audio', 'gif', 'svg', 'motion-graphic', 'text', 'solid',
]);

/** Pool-asset kinds that edit_item.adds can place as a clip.
 *  motion-graphic: pool assets from submit_motion_graphic / create_motion_graphic_from_code
 *  (library MG still uses library:motion-graphic:* via validateMgAdd).
 *  text/solid are authored via validateAuthoredAdd (no assetId). */
export const GENERIC_ADD_KINDS: ReadonlySet<string> = new Set(['video', 'image', 'gif', 'svg', 'audio', 'motion-graphic']);

/** Authored non-pool clips agents can create without an assetId. */
export const AUTHORED_ADD_KINDS: ReadonlySet<string> = new Set(['text', 'solid']);

const finiteNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const CSS_EASING_ALIASES: Record<string, Keyframe['easing']> = {
  'ease-in': 'easeIn',
  'ease-out': 'easeOut',
  'ease-in-out': 'easeInOut',
};

function normalizeEasing(easing: unknown): unknown {
  return typeof easing === 'string' ? CSS_EASING_ALIASES[easing] ?? easing : easing;
}

function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const q = String(id ?? '');
  if (!q) return null;
  return items.find((it) => it.id === q || it.id.startsWith(q)) ?? null;
}

/** Reject unknown fields with actionable edit_item errors. */
const GENERIC_UPDATE_KEYS: Record<string, true> = {
  type: true,
  itemId: true,
  id: true,
  track: true,
  trackId: true,
  startFrame: true,
  fromFrame: true,
  durationInFrames: true,
  srcInFrame: true,
  sourceStartFrame: true,
  sourceDurationInFrames: true,
  assetId: true,
  props: true,
  volume: true,
  fadeInSeconds: true,
  fadeOutSeconds: true,
  keyframes: true,
  filters: true,
  transform: true,
  backgroundFill: true,
  backgroundFillStrength: true,
  speed: true,
  playbackRate: true,
  clearKeyframes: true,
};

const GENERIC_ADD_KEYS: Record<string, true> = {
  type: true,
  assetId: true,
  track: true,
  trackId: true,
  startFrame: true,
  fromFrame: true,
  durationInFrames: true,
  sourceStartFrame: true,
  sourceDurationInFrames: true,
  sourceStartSeconds: true,
  sourceEndSeconds: true,
  sourceStartMs: true,
  sourceEndMs: true,
};

const AUTHORED_ADD_KEYS: Record<string, true> = {
  type: true,
  track: true,
  trackId: true,
  startFrame: true,
  fromFrame: true,
  durationInFrames: true,
  name: true,
  // text
  text: true,
  fontSize: true,
  color: true,
  fontWeight: true,
  align: true,
  // solid also uses color + name
};
const SLIP_UPDATE_KEYS: Record<string, true> = {
  type: true,
  itemId: true,
  id: true,
  operation: true,
  deltaInFrames: true,
};

// keyframes arg: {x|y|scale|rotation|opacity|volume: [{frame,value,easing?}…]} — boundary
// validation for LLM output (prop whitelist, finite frame ≥0, value in range, easing shape).
function parseKeyframesArg(raw: unknown): { keyframes?: ItemKeyframes; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'keyframes must be an object mapping prop → [{frame,value,easing?}]' };
  }
  const out: ItemKeyframes = {};
  for (const [prop, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEYFRAME_PROPS.includes(prop as KeyframeProp)) {
      return { error: `keyframes prop must be one of ${KEYFRAME_PROPS.join('/')}, got "${prop}"` };
    }
    if (!Array.isArray(list)) return { error: `keyframes.${prop} must be an array` };
    const [lo, hi] = getKeyframePropertyDefinition(prop as KeyframeProp).valueRange;
    const kfs: Keyframe[] = [];
    for (const entry of list) {
      const k = (entry ?? {}) as Record<string, unknown>;
      const frame = finiteNum(k.frame);
      const value = finiteNum(k.value);
      if (frame === undefined || frame < 0) return { error: `keyframes.${prop}: frame must be a finite number ≥ 0` };
      if (value === undefined || value < lo || value > hi) {
        // Real-life lessons: The model was rejected when sending x/y according to px - the unit is the canvas percentage, and the error is pointed out
        const unitNote = prop === 'x' || prop === 'y' ? ' (x/y are % of canvas, NOT px; 100 = one full canvas width/height)' : '';
        return { error: `keyframes.${prop}: value must be a finite number in ${lo}..${hi}${unitNote}` };
      }
      const easing = normalizeEasing(k.easing);
      if (easing !== undefined && !isValidEasing(easing)) {
        return { error: `keyframes.${prop}: easing must be linear/easeIn/easeOut/easeInOut or [x1,y1,x2,y2]` };
      }
      kfs.push({ frame: Math.round(frame), value, ...(easing !== undefined ? { easing } : {}) });
    }
    if (kfs.length) out[prop as KeyframeProp] = kfs;
  }
  if (!Object.keys(out).length) return { error: 'keyframes has no keyframe entries' };
  return { keyframes: out };
}

// Move (track/startFrame|fromFrame), trim (duration/srcIn), props, volume, fades (seconds→frames).
// A pool assetId update is an atomic replacement; other fields update the live clip.
export function validateGenericUpdate(
  state: TimelineState,
  entry: Record<string, unknown>,
  assets: readonly MediaAsset[] = state.assets ?? [],
): OpResult {
  if (entry.assetId !== undefined) return validatePoolAssetReplacement(state, assets, entry);
  const unknown = rejectUnknownFields(entry, GENERIC_UPDATE_KEYS);
  if (unknown) return { error: unknown };

  const itemRef = entry.itemId ?? entry.id;
  const it = findItem(state.items, itemRef);
  if (!it) return { error: `item not found: ${String(itemRef ?? '')}` };
  const plan: OpResult = { ok: true, kind: it.kind, plan: 'genericUpdate', itemId: it.id };

  const trackRaw = entry.track ?? entry.trackId;
  if (trackRaw !== undefined) {
    const kind = it.kind === 'audio' ? 'audio' : 'video';
    const track = resolveTrackId(state, trackRaw, kind);
    if (!track) return { error: `no compatible ${kind} track "${String(trackRaw)}"` };
    plan.track = track;
  }
  // fromFrame is canonical; startFrame remains an alias for local and legacy tools.
  const start = finiteNum(entry.startFrame) ?? finiteNum(entry.fromFrame);
  if (start !== undefined) plan.startFrame = Math.max(0, Math.round(start));
  const sourceTiming = validateSourceFrameUpdate(it, entry);
  if (sourceTiming.error) return sourceTiming;
  Object.assign(plan, sourceTiming);
  if (entry.props && typeof entry.props === 'object') plan.props = entry.props;
  if (finiteNum(entry.volume) !== undefined) plan.volume = Math.max(0, Math.min(2, finiteNum(entry.volume)!));
  const fps = state.fps || 30;
  const toFrames = (v: unknown): number | undefined =>
    finiteNum(v) !== undefined ? Math.max(0, Math.round(finiteNum(v)! * fps)) : undefined;
  if (toFrames(entry.fadeInSeconds) !== undefined) plan.fadeInFrames = toFrames(entry.fadeInSeconds);
  if (toFrames(entry.fadeOutSeconds) !== undefined) plan.fadeOutFrames = toFrames(entry.fadeOutSeconds);
  if (entry.keyframes !== undefined) {
    // generic keyframes (PRD §4.5), item-local frames — per-prop support by clip
    // kind (visual: x/y/scale/rotation/opacity; audio/video: volume). The reducer
    // silently drops unsupported props, so reject here with a real error.
    const parsed = parseKeyframesArg(entry.keyframes);
    if (parsed.error) return { error: parsed.error };
    for (const prop of Object.keys(parsed.keyframes!) as KeyframeProp[]) {
      if (!supportsKeyframeProperty(it, prop)) {
        return { error: `keyframes.${prop} is not supported on a ${it.kind} clip` };
      }
    }
    plan.keyframes = parsed.keyframes;
  }
  if (entry.filters !== undefined) {
    const visual = it.kind === 'video' || it.kind === 'image' || it.kind === 'gif' || it.kind === 'svg'
      || it.kind === 'text' || it.kind === 'solid' || it.kind === 'motion-graphic';
    if (!visual) return { error: `filters not supported on ${it.kind} clips` };
    const parsed = parseFiltersArg(entry.filters);
    if (parsed.error) return { error: parsed.error };
    plan.filters = parsed.filters;
  }
  if (entry.transform !== undefined) {
    if (it.kind === 'audio') return { error: 'transform is not supported on audio clips' };
    const parsed = parseTransformArg(entry.transform);
    if (parsed.error) return { error: parsed.error };
    plan.transform = parsed.transform;
  }
  const backgroundFill = validateBackgroundFillUpdate(
    state,
    it,
    entry.backgroundFill,
    entry.backgroundFillStrength,
    typeof plan.track === 'string' ? plan.track : undefined,
  );
  if (backgroundFill && 'error' in backgroundFill) return backgroundFill;
  if (backgroundFill) {
    plan.backgroundFill = backgroundFill.enabled;
    if (backgroundFill.strength !== undefined) plan.backgroundFillStrength = backgroundFill.strength;
  }
  const speedRaw = entry.speed ?? entry.playbackRate;
  if (speedRaw !== undefined) {
    if (it.kind !== 'video' && it.kind !== 'audio' && it.kind !== 'gif') {
      return { error: `speed/playbackRate only applies to video/audio/gif (got ${it.kind})` };
    }
    const n = finiteNum(speedRaw);
    if (n === undefined) return { error: 'speed must be a finite number (0.1..8)' };
    plan.speed = clampNum(n, 0.1, 8);
  }
  if (entry.clearKeyframes !== undefined) {
    if (entry.clearKeyframes === true) {
      plan.clearKeyframes = true;
    } else if (typeof entry.clearKeyframes === 'string' && KEYFRAME_PROPS.includes(entry.clearKeyframes as KeyframeProp)) {
      plan.clearKeyframes = entry.clearKeyframes as KeyframeProp;
    } else {
      return { error: `clearKeyframes must be true (all props) or one of ${KEYFRAME_PROPS.join('/')}` };
    }
  }

  const FIELDS = [
    'track', 'startFrame', 'durationInFrames', 'srcInFrame', 'props', 'volume',
    'fadeInFrames', 'fadeOutFrames', 'keyframes', 'filters', 'transform',
    'backgroundFill', 'backgroundFillStrength', 'speed', 'clearKeyframes',
  ];
  if (!FIELDS.some((k) => k in plan)) {
    return {
      error: 'update needs at least one of: track/trackId, startFrame/fromFrame, durationInFrames/sourceDurationInFrames, srcInFrame/sourceStartFrame, assetId, props, volume, fadeInSeconds, fadeOutSeconds, keyframes, clearKeyframes, filters, transform, backgroundFill, backgroundFillStrength, speed',
    };
  }
  return plan;
}

export function validateSlipUpdate(state: TimelineState, entry: Record<string, unknown>): OpResult {
  if (entry.operation !== undefined && entry.operation !== 'slip') {
    if (entry.operation === 'replace_media' || entry.operation === 'relink_media') {
      return validateMediaSourceUpdate(state, entry);
    }
    return {
      ok: false,
      error: `update operation not supported: ${String(entry.operation)}`,
      code: 'unknown-operation',
      supported: ['slip', 'replace_media', 'relink_media'],
    };
  }
  const unknown = rejectUnknownFields(entry, SLIP_UPDATE_KEYS);
  if (unknown) return { error: unknown, code: 'unknown-field' };
  const itemRef = entry.itemId ?? entry.id;
  const item = findItem(state.items, itemRef);
  if (!item) {
    return { ok: false, error: `item not found: ${String(itemRef ?? '')}`, code: 'unknown-item' };
  }
  const deltaInFrames = finiteNum(entry.deltaInFrames);
  if (deltaInFrames === undefined) {
    return { ok: false, error: 'slip needs a finite deltaInFrames', code: 'invalid-delta' };
  }
  const result = planSlip(state, item.id, deltaInFrames);
  if (!result.ok) return slipFailureToOpResult(result);
  return { ...result, kind: item.kind, plan: 'slip', status: result.clamped ? 'clamped' : 'planned' };
}

// Delete any kind. Per-entry ripple closes the gap (independent of batch-level ripple).
// Delete operations accept either {id} or {itemId}.
const GENERIC_DELETE_KEYS: Record<string, true> = {
  type: true,
  itemId: true,
  id: true,
  ripple: true,
};
export function validateGenericDelete(state: TimelineState, entry: Record<string, unknown>): OpResult {
  const unknown = rejectUnknownFields(entry, GENERIC_DELETE_KEYS);
  if (unknown) return { error: unknown };
  const itemRef = entry.itemId ?? entry.id;
  const it = findItem(state.items, itemRef);
  if (!it) return { error: `item not found: ${String(itemRef ?? '')}` };
  return { ok: true, kind: it.kind, plan: 'genericDelete', itemId: it.id, ripple: entry.ripple === true };
}

const isHexColor = (value: unknown): value is string => (
  typeof value === 'string' && /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value.trim())
);

/**
 * Authored text / solid adds — no pool assetId. Props land at creation so one
 * edit_item.adds entry can place a titled lower-third or solid fill.
 */
export function validateAuthoredAdd(
  state: TimelineState,
  entry: Record<string, unknown>,
): OpResult {
  const type = String(entry.type ?? '');
  if (!AUTHORED_ADD_KINDS.has(type)) {
    return { error: `authored add type not supported: ${type}`, supported: [...AUTHORED_ADD_KINDS] };
  }
  const unknown = rejectUnknownFields(entry, AUTHORED_ADD_KEYS);
  if (unknown) return { error: unknown };
  if (entry.assetId !== undefined) {
    return { error: `${type} is authored — do not pass assetId; set text/color/name props directly` };
  }
  const track = resolveTrackId(state, entry.track ?? entry.trackId ?? 'V1', 'video')
    ?? defaultTrackId(state, 'video');
  if (!track) return { error: 'no video track for placement — create one with edit_track first' };
  const startFrame = finiteNum(entry.startFrame) ?? finiteNum(entry.fromFrame);
  const durationInFrames = finiteNum(entry.durationInFrames);
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
  if (type === 'solid') {
    const color = isHexColor(entry.color) ? entry.color.trim() : '#1a1a1a';
    return {
      ok: true,
      kind: 'solid',
      plan: 'addSolid',
      track,
      color,
      ...(name ? { name } : {}),
      ...(startFrame !== undefined ? { startFrame: Math.max(0, Math.round(startFrame)) } : {}),
      ...(durationInFrames !== undefined && durationInFrames > 0
        ? { durationInFrames: Math.round(durationInFrames) }
        : {}),
    };
  }
  const text = typeof entry.text === 'string' && entry.text.trim() ? entry.text.trim() : '文字';
  const color = isHexColor(entry.color) ? entry.color.trim() : '#ffffff';
  const fontSize = finiteNum(entry.fontSize);
  const fontWeight = finiteNum(entry.fontWeight);
  const align = entry.align === 'left' || entry.align === 'right' || entry.align === 'center'
    ? entry.align
    : 'center';
  return {
    ok: true,
    kind: 'text',
    plan: 'addText',
    track,
    text,
    color,
    align,
    ...(name ? { name } : {}),
    ...(fontSize !== undefined && fontSize > 0 ? { fontSize } : {}),
    ...(fontWeight !== undefined && fontWeight > 0 ? { fontWeight } : {}),
    ...(startFrame !== undefined ? { startFrame: Math.max(0, Math.round(startFrame)) } : {}),
    ...(durationInFrames !== undefined && durationInFrames > 0
      ? { durationInFrames: Math.round(durationInFrames) }
      : {}),
  };
}

// Validate placement of an existing pool asset. submit/import only registers it;
// this resolves asset, track, and timing for addMediaItem. Optional duration trims
// a copied asset without requiring a post-placement lookup.
export function validateGenericAdd(
  state: TimelineState,
  assets: readonly MediaAsset[],
  entry: Record<string, unknown>,
): OpResult {
  const type = String(entry.type ?? '');
  if (AUTHORED_ADD_KINDS.has(type)) return validateAuthoredAdd(state, entry);
  if (!GENERIC_ADD_KINDS.has(type)) {
    return {
      error: `add type not supported: ${type}`,
      supported: [...GENERIC_ADD_KINDS, ...AUTHORED_ADD_KINDS],
    };
  }
  const unknown = rejectUnknownFields(entry, GENERIC_ADD_KEYS);
  if (unknown) return { error: unknown };
  const q = String(entry.assetId ?? '').trim();
  if (!q) return { error: `${type} add needs assetId (a pool asset id/prefix; see manage_media_pool action=list)` };
  const exact = assets.find((asset) => asset.id === q);
  const hits = exact ? [exact] : assets.filter((asset) => asset.id.startsWith(q));
  if (hits.length === 0) {
    return { error: `no pool asset matching "${q}"`, hint: 'manage_media_pool action=list shows asset ids/names' };
  }
  if (hits.length > 1) {
    return { error: `ambiguous asset prefix "${q}"`, candidates: hits.slice(0, 6).map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind })) };
  }
  const asset = hits[0]!;
  if (asset.kind !== type) {
    return { error: `asset ${asset.id} is kind=${asset.kind}, not ${type} — pass type:"${asset.kind}"` };
  }
  const family = type === 'audio' ? 'audio' : 'video';
  const track = resolveTrackId(state, entry.track ?? entry.trackId ?? (family === 'audio' ? 'A1' : 'V1'), family)
    ?? defaultTrackId(state, family);
  if (!track) return { error: `no ${family} track for placement — create one with edit_track first` };
  const startFrame = finiteNum(entry.startFrame) ?? finiteNum(entry.fromFrame);
  const durationInFrames = finiteNum(entry.durationInFrames);
  const sourceWindow = validateSourceWindow(type, asset, state.fps || 30, entry, durationInFrames);
  if (sourceWindow?.error) return sourceWindow;
  if (sourceWindow) {
    return {
      ok: true,
      kind: type,
      plan: 'addMedia',
      assetId: asset.id,
      track,
      ...sourceWindow,
      ...(startFrame !== undefined ? { startFrame: Math.max(0, Math.round(startFrame)) } : {}),
    };
  }
  return {
    ok: true,
    kind: type,
    plan: 'addMedia',
    assetId: asset.id,
    track,
    ...(startFrame !== undefined ? { startFrame: Math.max(0, Math.round(startFrame)) } : {}),
    ...(durationInFrames !== undefined && durationInFrames > 0 ? { durationInFrames: Math.round(durationInFrames) } : {}),
  };
}
