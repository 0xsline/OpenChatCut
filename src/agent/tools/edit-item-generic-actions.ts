import type {
  ClipFilters,
  ClipTransform,
  ItemKeyframes,
  Keyframe,
  KeyframeProp,
  MediaAssetRelinkPatch,
  MediaRelinkResult,
} from '../../editor/types';
import type { SlipResult } from '../../editor/slip';
import { slipFailureToOpResult, type OpResult } from './edit-item-generic-result';

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
  setItemBackgroundFill: (id: string, enabled: boolean, strength?: number) => void;
  setItemSpeed: (id: string, rate: number) => void;
  clearItemKeyframes: (id: string, prop?: KeyframeProp) => void;
  replaceItemMedia: (id: string, src: string) => void;
  relinkTimelineItem: (id: string, next: MediaAssetRelinkPatch) => MediaRelinkResult;
  removeItem: (id: string) => void;
  rippleDeleteItem: (id: string) => void;
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
    if (plan.backgroundFill !== undefined) {
      commands.setItemBackgroundFill(
        id,
        plan.backgroundFill as boolean,
        plan.backgroundFillStrength as number | undefined,
      );
    }
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
    const committed = commands.relinkTimelineItem(id, {
      src: String(plan.src),
      sourceContentHash: undefined,
      name: plan.name as string | undefined,
      durationInFrames: plan.durationInFrames as number | undefined,
      width: plan.width as number | undefined,
      height: plan.height as number | undefined,
      sourceFilename: plan.sourceFilename as string | undefined,
    });
    if (!committed.changed) {
      return {
        ok: false,
        code: committed.reason,
        itemId: id,
        error: `relink_media did not change item ${id}`,
      };
    }
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
