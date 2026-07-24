// Generic (non-library) item ops for edit_item — the unified entry for
// video/image/audio/gif/svg/motion-graphic/text/solid updates + deletes. Kept in its own
// PURE module (imports only editor types) so it's unit-testable without pulling the GL
// `.frag` chain that edit-item-tools.ts drags in. Validation is pure; commit delegates to
// the same editor commands the dedicated move_item / set_item_timing / remove_item tools
// use — no logic duplication, just atomic-batch semantics.
import type { ItemKeyframes, Keyframe, KeyframeProp, MediaAsset, TimelineItem, TimelineState } from '../../editor/types';
import { defaultTrackId, resolveTrackId } from '../../editor/types';
import { isValidEasing } from '../../editor/keyframes';
import { getKeyframePropertyDefinition, KEYFRAME_PROPS } from '../../editor/keyframeRegistry';

type OpResult = Record<string, unknown>;

export const GENERIC_ITEM_KINDS: ReadonlySet<string> = new Set([
  'video', 'image', 'audio', 'gif', 'svg', 'motion-graphic', 'text', 'solid',
]);

/** Pool-asset kinds that edit_item.adds can place as a clip.
 *  motion-graphic: pool assets from submit_motion_graphic / create_motion_graphic_from_code
 *  (library MG still uses library:motion-graphic:* via validateMgAdd).
 *  text/solid are authored, not pool media — excluded. */
export const GENERIC_ADD_KINDS: ReadonlySet<string> = new Set(['video', 'image', 'gif', 'svg', 'audio', 'motion-graphic']);

const finiteNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const q = String(id ?? '');
  if (!q) return null;
  return items.find((it) => it.id === q || it.id.startsWith(q)) ?? null;
}

/** Reject unknown fields with actionable edit_item errors. */
const GENERIC_UPDATE_KEYS = new Set([
  'type', 'itemId', 'id', 'track', 'trackId',
  'startFrame', 'fromFrame', 'durationInFrames', 'srcInFrame',
  'props', 'volume', 'fadeInSeconds', 'fadeOutSeconds', 'keyframes',
  'ripple', 'projectId',
]);
const GENERIC_ADD_KEYS = new Set([
  'type', 'assetId', 'track', 'trackId', 'startFrame', 'fromFrame', 'durationInFrames', 'projectId',
]);

/** Closest allowed key by edit distance (cap 3) for "Did you mean …?" hints. */
export function didYouMean(got: string, allowed: readonly string[]): string | null {
  const g = got.toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const a of allowed) {
    const d = levenshtein(g, a.toLowerCase());
    if (d < bestD) { bestD = d; best = a; }
  }
  return bestD <= 3 ? best : null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n]!;
}

/** Reject keys not in the allowed set; special-case assetId on updates. */
export function rejectUnknownFields(
  entry: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  opts?: { banAssetId?: boolean },
): string | null {
  if (opts?.banAssetId && entry.assetId !== undefined) {
    return (
      'assetId cannot be updated on an existing timeline item.\n\n'
      + 'To replace media, use one edit_item batch with deletes:[{id:"old item id"}] and '
      + 'adds:[{type:"video|audio|image|gif|svg|motion-graphic", assetId:"new asset id", trackId, '
      + 'fromFrame, durationInFrames}] (read the old item first and reuse its timing). '
      + 'srcInFrame / fades / props are not add fields — set them with a follow-up edit_item '
      + 'update on the new item id after this batch applies.'
    );
  }
  const allowedList = [...allowed];
  for (const key of Object.keys(entry)) {
    if (allowed.has(key)) continue;
    // assetId already handled above when banAssetId; if not banned, still reject as unknown
    const hint = didYouMean(key, allowedList);
    return hint
      ? `unknown field "${key}". Did you mean "${hint}"?\n\nUse only supported fields from the edit_item schema. If this was a spelling variant, retry with the exact field name from the tool description.`
      : `unknown field "${key}".\n\nUse only supported fields from the edit_item schema. Supported: ${allowedList.join(', ')}.`;
  }
  return null;
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
    // generic transform keyframes (PRD §4.5) — visual clips only, item-local frames
    if (it.kind === 'audio') return { error: 'keyframes apply to visual clips only (audio has no x/y/scale/rotation/opacity)' };
    const parsed = parseKeyframesArg(entry.keyframes);
    if (parsed.error) return { error: parsed.error };
    plan.keyframes = parsed.keyframes;
  }

  const FIELDS = ['track', 'startFrame', 'durationInFrames', 'srcInFrame', 'props', 'volume', 'fadeInFrames', 'fadeOutFrames', 'keyframes'];
  if (!FIELDS.some((k) => k in plan)) {
    return { error: 'update needs at least one of: track/trackId, startFrame/fromFrame, durationInFrames, srcInFrame, props, volume, fadeInSeconds, fadeOutSeconds, keyframes' };
  }
  return plan;
}

// Delete any kind. Per-entry ripple closes the gap (independent of batch-level ripple).
// Delete operations accept either {id} or {itemId}.
const GENERIC_DELETE_KEYS = new Set(['type', 'itemId', 'id', 'ripple', 'projectId']);
export function validateGenericDelete(state: TimelineState, entry: Record<string, unknown>): OpResult {
  const unknown = rejectUnknownFields(entry, GENERIC_DELETE_KEYS);
  if (unknown) return { error: unknown };
  const itemRef = entry.itemId ?? entry.id;
  const it = findItem(state.items, itemRef);
  if (!it) return { error: `item not found: ${String(itemRef ?? '')}` };
  return { ok: true, kind: it.kind, plan: 'genericDelete', itemId: it.id, ripple: entry.ripple === true };
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
  if (!GENERIC_ADD_KINDS.has(type)) {
    return { error: `add type not supported: ${type}`, supported: [...GENERIC_ADD_KINDS] };
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
    return { ok: true, kind: plan.kind, plan: 'genericUpdate', itemId: id };
  }
  if (plan.plan === 'genericDelete') {
    if (plan.ripple === true) commands.rippleDeleteItem(id);
    else commands.removeItem(id);
    return { ok: true, kind: plan.kind, plan: 'genericDelete', itemId: id, ripple: plan.ripple === true };
  }
  return null;
}
