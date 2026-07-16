// Generic (non-library) item ops for edit_item — the source-faithful unified entry for
// video/image/audio/gif/svg/motion-graphic/text/solid updates + deletes. Kept in its own
// PURE module (imports only editor types) so it's unit-testable without pulling the GL
// `.frag` chain that edit-item-tools.ts drags in. Validation is pure; commit delegates to
// the same editor commands the dedicated move_item / set_item_timing / remove_item tools
// use — no logic duplication, just atomic-batch semantics.
import type { ItemKeyframes, Keyframe, KeyframeProp, MediaAsset, TimelineItem, TimelineState } from '../editor/types';
import { KEYFRAME_PROPS, defaultTrackId, resolveTrackId } from '../editor/types';
import { KEYFRAME_RANGE, isValidEasing } from '../editor/keyframes';

type OpResult = Record<string, unknown>;

export const GENERIC_ITEM_KINDS: ReadonlySet<string> = new Set([
  'video', 'image', 'audio', 'gif', 'svg', 'motion-graphic', 'text', 'solid',
]);

/** Pool-asset kinds that edit_item.adds can place as a clip. MG has its own library
 *  path (validateMgAdd); text/solid are authored, not pool media — so they're excluded. */
export const GENERIC_ADD_KINDS: ReadonlySet<string> = new Set(['video', 'image', 'gif', 'svg', 'audio']);

const finiteNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const q = String(id ?? '');
  if (!q) return null;
  return items.find((it) => it.id === q || it.id.startsWith(q)) ?? null;
}

/** Editor command subset the generic committer needs (satisfied by EditorCommands). */
export interface GenericCommands {
  moveItem: (id: string, to: { track?: string; startFrame?: number }) => void;
  setItemTiming: (id: string, timing: { startFrame?: number; durationInFrames?: number; srcInFrame?: number }) => void;
  updateItemProps: (id: string, patch: Record<string, unknown>) => void;
  setItemVolume: (id: string, volume: number) => void;
  setItemFade: (id: string, fade: { fadeInFrames?: number; fadeOutFrames?: number }) => void;
  setItemKeyframe: (id: string, prop: KeyframeProp, frame: number, value: number, easing?: Keyframe['easing']) => void;
  removeItem: (id: string) => void;
  rippleDeleteItem: (id: string) => void;
}

// keyframes arg: {x|y|scale|rotation|opacity: [{frame,value,easing?}…]} — boundary
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
    const [lo, hi] = KEYFRAME_RANGE[prop as KeyframeProp];
    const kfs: Keyframe[] = [];
    for (const entry of list) {
      const k = (entry ?? {}) as Record<string, unknown>;
      const frame = finiteNum(k.frame);
      const value = finiteNum(k.value);
      if (frame === undefined || frame < 0) return { error: `keyframes.${prop}: frame must be a finite number ≥ 0` };
      if (value === undefined || value < lo || value > hi) {
        return { error: `keyframes.${prop}: value must be a finite number in ${lo}..${hi}` };
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

// Move (track/startFrame), trim (duration/srcIn), props, volume, fades (seconds→frames).
export function validateGenericUpdate(state: TimelineState, entry: Record<string, unknown>): OpResult {
  const it = findItem(state.items, entry.itemId);
  if (!it) return { error: `item not found: ${String(entry.itemId ?? '')}` };
  const plan: OpResult = { ok: true, kind: it.kind, plan: 'genericUpdate', itemId: it.id };

  if (entry.track !== undefined) {
    const kind = it.kind === 'audio' ? 'audio' : 'video';
    const track = resolveTrackId(state, entry.track, kind);
    if (!track) return { error: `no compatible ${kind} track "${String(entry.track)}"` };
    plan.track = track;
  }
  if (finiteNum(entry.startFrame) !== undefined) plan.startFrame = Math.max(0, Math.round(finiteNum(entry.startFrame)!));
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
    // generic transform keyframes (PRD §4.5) — visual clips only, item-local frames
    if (it.kind === 'audio') return { error: 'keyframes apply to visual clips only (audio has no x/y/scale/rotation/opacity)' };
    const parsed = parseKeyframesArg(entry.keyframes);
    if (parsed.error) return { error: parsed.error };
    plan.keyframes = parsed.keyframes;
  }

  const FIELDS = ['track', 'startFrame', 'durationInFrames', 'srcInFrame', 'props', 'volume', 'fadeInFrames', 'fadeOutFrames', 'keyframes'];
  if (!FIELDS.some((k) => k in plan)) {
    return { error: 'update needs at least one of: track, startFrame, durationInFrames, srcInFrame, props, volume, fadeInSeconds, fadeOutSeconds, keyframes' };
  }
  return plan;
}

// Delete any kind. Per-entry ripple closes the gap (independent of batch-level ripple).
export function validateGenericDelete(state: TimelineState, entry: Record<string, unknown>): OpResult {
  const it = findItem(state.items, entry.itemId);
  if (!it) return { error: `item not found: ${String(entry.itemId ?? '')}` };
  return { ok: true, kind: it.kind, plan: 'genericDelete', itemId: it.id, ripple: entry.ripple === true };
}

// Place an existing POOL asset (video/image/gif/svg/audio) onto a track as a clip.
// Source: submit_*/import only registers the asset; it's placed onto the timeline by a
// separate edit_item (复刻规格 line 173/190/200). The library adds (effect/transition/mg/
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
  if (!GENERIC_ADD_KINDS.has(type)) {
    return { error: `add type not supported: ${type}`, supported: [...GENERIC_ADD_KINDS] };
  }
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
    return { ok: true, kind: plan.kind, plan: 'genericUpdate', itemId: id };
  }
  if (plan.plan === 'genericDelete') {
    if (plan.ripple === true) commands.rippleDeleteItem(id);
    else commands.removeItem(id);
    return { ok: true, kind: plan.kind, plan: 'genericDelete', itemId: id, ripple: plan.ripple === true };
  }
  return null;
}
