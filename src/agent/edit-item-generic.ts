// Generic (non-library) item ops for edit_item — the source-faithful unified entry for
// video/image/audio/gif/svg/motion-graphic/text/solid updates + deletes. Kept in its own
// PURE module (imports only editor types) so it's unit-testable without pulling the GL
// `.frag` chain that edit-item-tools.ts drags in. Validation is pure; commit delegates to
// the same editor commands the dedicated move_item / set_item_timing / remove_item tools
// use — no logic duplication, just atomic-batch semantics.
import type { TimelineItem, TimelineState } from '../editor/types';
import { resolveTrackId } from '../editor/types';

type OpResult = Record<string, unknown>;

export const GENERIC_ITEM_KINDS: ReadonlySet<string> = new Set([
  'video', 'image', 'audio', 'gif', 'svg', 'motion-graphic', 'text', 'solid',
]);

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
  removeItem: (id: string) => void;
  rippleDeleteItem: (id: string) => void;
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

  const FIELDS = ['track', 'startFrame', 'durationInFrames', 'srcInFrame', 'props', 'volume', 'fadeInFrames', 'fadeOutFrames'];
  if (!FIELDS.some((k) => k in plan)) {
    return { error: 'update needs at least one of: track, startFrame, durationInFrames, srcInFrame, props, volume, fadeInSeconds, fadeOutSeconds' };
  }
  return plan;
}

// Delete any kind. Per-entry ripple closes the gap (independent of batch-level ripple).
export function validateGenericDelete(state: TimelineState, entry: Record<string, unknown>): OpResult {
  const it = findItem(state.items, entry.itemId);
  if (!it) return { error: `item not found: ${String(entry.itemId ?? '')}` };
  return { ok: true, kind: it.kind, plan: 'genericDelete', itemId: it.id, ripple: entry.ripple === true };
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
    return { ok: true, kind: plan.kind, plan: 'genericUpdate', itemId: id };
  }
  if (plan.plan === 'genericDelete') {
    if (plan.ripple === true) commands.rippleDeleteItem(id);
    else commands.removeItem(id);
    return { ok: true, kind: plan.kind, plan: 'genericDelete', itemId: id, ripple: plan.ripple === true };
  }
  return null;
}
