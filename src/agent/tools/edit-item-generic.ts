// Generic (non-library) item ops for edit_item — the unified entry for
// video/image/audio/gif/svg/motion-graphic/text/solid updates + deletes. Kept in its own
// PURE module (imports only editor types) so it's unit-testable without pulling the GL
// `.frag` chain that edit-item-tools.ts drags in. Validation is pure; commit delegates to
// the same editor commands the dedicated move_item / set_item_timing / remove_item tools
// use — no logic duplication, just atomic-batch semantics.
import type {
  ClipFilters, ClipTransform, ItemKeyframes, Keyframe, KeyframeProp,
  MediaAsset, TimelineItem, TimelineState,
} from '../../editor/types';
import { defaultTrackId, resolveTrackId } from '../../editor/types';
import { isValidEasing } from '../../editor/keyframes';
import { getKeyframePropertyDefinition, KEYFRAME_PROPS, supportsKeyframeProperty } from '../../editor/keyframeRegistry';
import { planSlip, type SlipFailure, type SlipResult } from '../../editor/slip';
import { rejectUnknownFields } from './edit-item-fields';
import { clampNum, parseFiltersArg, parseTransformArg } from './edit-item-visual';
import { validateMediaSourceUpdate } from './edit-item-media-ops';
export { didYouMean, rejectUnknownFields } from './edit-item-fields';
export { validateMediaSourceUpdate } from './edit-item-media-ops';

type OpResult = Record<string, unknown>;

function slipFailureToOpResult(failure: SlipFailure): OpResult {
  return {
    ok: false,
    code: failure.code,
    itemId: failure.itemId,
    error: failure.error,
  };
}

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
  props: true,
  volume: true,
  fadeInSeconds: true,
  fadeOutSeconds: true,
  keyframes: true,
  filters: true,
  transform: true,
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

/** Editor command subset the generic committer needs (satisfied by EditorCommands). */
export interface GenericCommands {
  moveItem: (id: string, to: { track?: string; startFrame?: number }) => void;
  setItemTiming: (id: string, timing: { startFrame?: number; durationInFrames?: number; srcInFrame?: number }) => void;
  slipItem: (id: string, deltaInFrames: number) => SlipResult;
  updateItemProps: (id: string, patch: Record<string, unknown>) => void;
  setItemVolume: (id: string, volume: number) => void;
  setItemFade: (id: string, fade: { fadeInFrames?: number; fadeOutFrames?: number }) => void;
  setItemKeyframe: (id: string, prop: KeyframeProp, frame: number, value: number, easing?: Keyframe['easing']) => void;
  setItemFilters: (id: string, patch: ClipFilters) => void;
  setItemTransform: (id: string, patch: ClipTransform) => void;
  setItemSpeed: (id: string, rate: number) => void;
  clearItemKeyframes: (id: string, prop?: KeyframeProp) => void;
  replaceItemMedia: (id: string, src: string) => void;
  relinkTimelineItem: (id: string, next: { src: string; name?: string; durationInFrames?: number; width?: number; height?: number; sourceRevision?: string; sourceFilename?: string }) => void;
  removeItem: (id: string) => void;
  rippleDeleteItem: (id: string) => void;
}

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
      if (k.easing !== undefined && !isValidEasing(k.easing)) {
        return { error: `keyframes.${prop}: easing must be linear/easeIn/easeOut/easeInOut or [x1,y1,x2,y2]` };
      }
      kfs.push({ frame: Math.round(frame), value, ...(k.easing !== undefined ? { easing: k.easing as Keyframe['easing'] } : {}) });
    }
    if (kfs.length) out[prop as KeyframeProp] = kfs;
  }
  if (!Object.keys(out).length) return { error: 'keyframes has no keyframe entries' };
  return { keyframes: out };
}

// Move (track/startFrame|fromFrame), trim (duration/srcIn), props, volume, fades (seconds→frames).
// assetId is immutable on update; media replacement uses delete + add in one batch.
export function validateGenericUpdate(state: TimelineState, entry: Record<string, unknown>): OpResult {
  const unknown = rejectUnknownFields(entry, GENERIC_UPDATE_KEYS, { banAssetId: true });
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
  if (finiteNum(entry.durationInFrames) !== undefined) plan.durationInFrames = Math.max(1, Math.round(finiteNum(entry.durationInFrames)!));
  if (finiteNum(entry.srcInFrame) !== undefined) plan.srcInFrame = Math.max(0, Math.round(finiteNum(entry.srcInFrame)!));
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
    'fadeInFrames', 'fadeOutFrames', 'keyframes', 'filters', 'transform', 'speed', 'clearKeyframes',
  ];
  if (!FIELDS.some((k) => k in plan)) {
    return {
      error: 'update needs at least one of: track/trackId, startFrame/fromFrame, durationInFrames, srcInFrame, props, volume, fadeInSeconds, fadeOutSeconds, keyframes, clearKeyframes, filters, transform, speed',
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

// Place an existing POOL asset (video/image/gif/svg/audio) onto a track as a clip.
// submit_*/import only registers the asset; it's placed onto the timeline by a
// separate edit_item. The library adds (effect/transition/mg/
// sfx) never covered pool media, so the agent previously had NO way to place B-roll — this
// closes that. Pure: resolves asset (id/prefix, G2) + track + position; the committer calls
// addMediaItem. Optional durationInFrames trims stills/clips at placement (applied as an
// asset copy so the committer needs no post-placement item lookup).
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
  // Pool media add: reject extra keys (live: unknown field "name" on adds[0]).
  const unknown = rejectUnknownFields(entry, GENERIC_ADD_KEYS);
  if (unknown) return { error: unknown };
  const q = String(entry.assetId ?? '').trim();
  if (!q) return { error: `${type} add needs assetId (a pool asset id/prefix; see manage_media_pool action=list)` };
  const exact = assets.find((a) => a.id === q);
  const hits = exact ? [exact] : assets.filter((a) => a.id.startsWith(q));
  if (hits.length === 0) return { error: `no pool asset matching "${q}"`, hint: 'manage_media_pool action=list shows asset ids/names' };
  if (hits.length > 1) {
    return { error: `ambiguous asset prefix "${q}"`, candidates: hits.slice(0, 6).map((a) => ({ id: a.id, name: a.name, kind: a.kind })) };
  }
  const asset = hits[0]!;
  if (asset.kind !== type) return { error: `asset ${asset.id} is kind=${asset.kind}, not ${type} — pass type:"${asset.kind}"` };

  const family = type === 'audio' ? 'audio' : 'video';
  const track = resolveTrackId(state, entry.track ?? entry.trackId ?? (family === 'audio' ? 'A1' : 'V1'), family)
    ?? defaultTrackId(state, family);
  if (!track) return { error: `no ${family} track for placement — create one with edit_track first` };

  const startFrame = finiteNum(entry.startFrame) ?? finiteNum(entry.fromFrame);
  const durationInFrames = finiteNum(entry.durationInFrames);
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

/** Commit a generic plan. Returns the op result; unknown plans return null so the caller
 *  can fall through to its own switch. move and trim are separate commands so startFrame
 *  isn't double-applied; each is a no-op when its fields are absent. */
export function applyGeneric(plan: OpResult, commands: GenericCommands): OpResult | null {
  const id = String(plan.itemId);
  if (plan.plan === 'genericUpdate') {
    if (plan.track !== undefined || plan.startFrame !== undefined) {
      commands.moveItem(id, { track: plan.track as string | undefined, startFrame: plan.startFrame as number | undefined });
    }
    if (plan.durationInFrames !== undefined || plan.srcInFrame !== undefined) {
      commands.setItemTiming(id, { durationInFrames: plan.durationInFrames as number | undefined, srcInFrame: plan.srcInFrame as number | undefined });
    }
    if (plan.props !== undefined) commands.updateItemProps(id, plan.props as Record<string, unknown>);
    if (plan.volume !== undefined) commands.setItemVolume(id, plan.volume as number);
    if (plan.fadeInFrames !== undefined || plan.fadeOutFrames !== undefined) {
      commands.setItemFade(id, { fadeInFrames: plan.fadeInFrames as number | undefined, fadeOutFrames: plan.fadeOutFrames as number | undefined });
    }
    if (plan.keyframes !== undefined) {
      // batch: one setKeyframe per point (same-frame overwrites in the reducer)
      for (const [prop, kfs] of Object.entries(plan.keyframes as ItemKeyframes)) {
        for (const k of kfs ?? []) commands.setItemKeyframe(id, prop as KeyframeProp, k.frame, k.value, k.easing);
      }
    }
    if (plan.filters !== undefined) commands.setItemFilters(id, plan.filters as ClipFilters);
    if (plan.transform !== undefined) commands.setItemTransform(id, plan.transform as ClipTransform);
    if (plan.speed !== undefined) commands.setItemSpeed(id, plan.speed as number);
    if (plan.clearKeyframes === true) commands.clearItemKeyframes(id);
    else if (typeof plan.clearKeyframes === 'string') {
      commands.clearItemKeyframes(id, plan.clearKeyframes as KeyframeProp);
    }
    return { ok: true, kind: plan.kind, plan: 'genericUpdate', itemId: id };
  }
  if (plan.plan === 'slip') {
    const committed = commands.slipItem(id, Number(plan.appliedDeltaInFrames));
    if (!committed.ok) return slipFailureToOpResult(committed);
    return {
      ...plan,
      srcInFrame: committed.srcInFrame,
      sourceWindow: committed.sourceWindow,
      status: plan.clamped ? 'clamped' : 'applied',
    };
  }
  if (plan.plan === 'replaceMedia') {
    commands.replaceItemMedia(id, String(plan.src));
    return { ok: true, kind: 'video', plan: 'replaceMedia', itemId: id, src: plan.src };
  }
  if (plan.plan === 'relinkMedia') {
    commands.relinkTimelineItem(id, {
      src: String(plan.src),
      name: plan.name as string | undefined,
      durationInFrames: plan.durationInFrames as number | undefined,
      width: plan.width as number | undefined,
      height: plan.height as number | undefined,
      sourceFilename: plan.sourceFilename as string | undefined,
    });
    return {
      ok: true,
      kind: plan.kind,
      plan: 'relinkMedia',
      itemId: id,
      src: plan.src,
      note: plan.note,
    };
  }
  if (plan.plan === 'genericDelete') {
    if (plan.ripple === true) commands.rippleDeleteItem(id);
    else commands.removeItem(id);
    return { ok: true, kind: plan.kind, plan: 'genericDelete', itemId: id, ripple: plan.ripple === true };
  }
  return null;
}
