import type { TimelineItem, TimelineState } from './types';
import { trackEnd } from './types';
import { capFade } from './clipFit';
import { scaleItemKeyframes, upsertKeyframe } from './keyframes';
import { timelineFramesToSourceFrames } from './sourceLimit';
import { coerceKeyframeValue, supportsKeyframeProperty } from './keyframeRegistry';
import { planSlip } from './slip';
import { createMediaSourceRevision } from './mediaSourceRevision';
import { setBackgroundFillState } from './backgroundFill';
import { normalizeSha256Hash } from '../../shared/content-hash.js';
import { applyRippleShifts, linkedItemIds, moveItemWithGroups, retimeItemWithGroups } from './linkGroups';
import { clampMoveDeltaToTrackGaps } from './trackCollision';
import type { Action } from './reducerActions';
import { contiguousFollowers, EMPTY_CURVE, isRelinkableMediaKind, lockedItem, relinkTiming, retimePatchForItem, type RelinkableTimelineItem } from './reducerTimelineHelpers';

export function applyClipAction(s: TimelineState, a: Action): TimelineState | undefined {
  switch (a.type) {
    case 'add': {
      if (s.tracks?.[a.item.track]?.locked) return s;
      if (s.items.some((item) => item.id === a.item.id)) return s;
      const requestedStart = a.startFrame ?? trackEnd(s, a.item.track);
      let baseState = s;
      if (a.ripple) {
        const shifts = new Map(s.items
          .filter((item) => item.track === a.item.track && item.startFrame >= requestedStart)
          .map((item) => [item.id, a.item.durationInFrames]));
        const shifted = applyRippleShifts(s, shifts);
        if (!shifted) return s;
        baseState = shifted;
      }
      const requested: TimelineItem = { ...a.item, startFrame: requestedStart };
      const delta = clampMoveDeltaToTrackGaps(
        baseState,
        [requested],
        new Set([requested.id]),
        0,
      );
      if (delta === null) return s;
      const item = { ...requested, startFrame: requested.startFrame + delta };
      return {
        ...baseState,
        items: [...baseState.items, item],
        selectedId: item.id,
        selectedIds: [item.id],
      };
    }
    case 'updateProps':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id ? { ...it, props: { ...it.props, ...a.patch } } : it,
        ),
      };
    case 'relinkTimelineItem': {
      const target = s.items.find((item) => item.id === a.id);
      if (!target || s.tracks?.[target.track]?.locked || !isRelinkableMediaKind(target.kind)) return s;
      const timing = relinkTiming(target, a.durationInFrames, a.kind ?? target.kind);
      if (!timing) return s;
      const {
        sourceAssetId: _sourceAssetId,
        denoisedSrc: _denoisedSrc,
        denoiseStrength: _denoiseStrength,
        sourceTimecode: _sourceTimecode,
        captureClock: _captureClock,
        ...sourceIndependent
      } = target as RelinkableTimelineItem;
      const relinked: RelinkableTimelineItem = {
        ...sourceIndependent,
        ...timing,
        src: a.src,
        name: a.name ?? target.name,
        width: a.width ?? target.width,
        height: a.height ?? target.height,
        kind: a.kind ?? target.kind,
        sourceRevision: 'sourceRevision' in a ? a.sourceRevision : target.sourceRevision,
        sourceContentHash: 'sourceContentHash' in a
          ? normalizeSha256Hash(a.sourceContentHash)
          : target.sourceContentHash,
        sourceSize: 'sourceSize' in a ? a.sourceSize : sourceIndependent.sourceSize,
        sourceModifiedAt: 'sourceModifiedAt' in a ? a.sourceModifiedAt : sourceIndependent.sourceModifiedAt,
        sourceFilename: 'sourceFilename' in a ? a.sourceFilename : target.sourceFilename,
        originalFilePath: 'originalFilePath' in a ? a.originalFilePath : target.originalFilePath,
        transcriptStale: target.transcript?.length ? true : target.transcriptStale,
      };
      return {
        ...s,
        items: s.items.map((item) => item.id === a.id ? relinked : item),
      };
    }
    case 'move': {
      const target = s.items.find((it) => it.id === a.id);
      if (!target) return s;
      return moveItemWithGroups(
        s,
        a.id,
        Math.max(0, a.startFrame ?? target.startFrame),
        a.track,
      );
    }
    case 'retime': {
      if (s.items.some((it) => it.id === a.id && s.tracks?.[it.track]?.locked)) return s;
      const target = s.items.find((it) => it.id === a.id);
      if (!target) return s;
      const targetPatch = retimePatchForItem(s, target, a);
      const oldEnd = target.startFrame + target.durationInFrames;
      const newEnd = targetPatch.startFrame + targetPatch.durationInFrames;
      const deltaEnd = newEnd - oldEnd;
      // ripple retime: when the clip's right edge moves, shift later same-track clips
      // by the same delta (shorten = close gap; lengthen = push).
      const linkedIds = new Set(linkedItemIds(s, [a.id]));
      const grouped = retimeItemWithGroups(s, a.id, targetPatch);
      if (!grouped) return s;
      if (!a.ripple || deltaEnd === 0) return grouped;
      const linkedMembers = s.items.filter((item) => linkedIds.has(item.id));
      const shifts = new Map(s.items
        .filter((item) => !linkedIds.has(item.id) && linkedMembers.some((member) =>
          item.track === member.track
          && item.startFrame >= member.startFrame + member.durationInFrames))
        .map((item) => [item.id, deltaEnd]));
      return applyRippleShifts(grouped, shifts, linkedIds) ?? s;
    }
    case 'slip': {
      const plan = planSlip(s, a.id, a.deltaInFrames);
      if (!plan.ok || Math.abs(plan.appliedDeltaInFrames) < 1e-6) return s;
      return {
        ...s,
        items: s.items.map((item) => item.id === a.id
          ? { ...item, srcInFrame: plan.srcInFrame }
          : item),
      };
    }
    case 'setVolume':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, volume: Math.max(0, Math.min(2, a.volume)) } : it)),
      };
    case 'setFade':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          // The fades on both sides combined cannot exceed the clip length. The side that is explicitly set gives way to the side that is not moved
          // (Only adjusting the fade-in should not shorten the user's original fade-out); when both sides are given at the same time, press the fade-in priority.
          const cap = it.durationInFrames;
          const fadeInFrames = a.fadeInFrames === undefined
            ? it.fadeInFrames
            : capFade(a.fadeInFrames, a.fadeOutFrames === undefined ? cap - (it.fadeOutFrames ?? 0) : cap);
          const fadeOutFrames = a.fadeOutFrames === undefined
            ? it.fadeOutFrames
            : capFade(a.fadeOutFrames, cap - (fadeInFrames ?? 0));
          return { ...it, fadeInFrames, fadeOutFrames };
        }),
      };
    case 'setTransform':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, transform: { ...it.transform, ...a.patch } } : it)),
      };
    case 'setFilters':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, filters: { ...it.filters, ...a.patch } } : it)),
      };
    case 'setBackgroundFill':
      if (lockedItem(s, a.id)) return s;
      return setBackgroundFillState(s, a.id, a.enabled, a.strength);
    case 'setZoom':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, zoom: a.patch === null ? undefined : { ...it.zoom, ...a.patch } } : it)),
      };
    case 'setEffects': {
      if (lockedItem(s, a.id)) return s;
      // The def of non-built-in fx (plugin/submit_shader) is snapshotted into state.fxDefs with the action —
      // Refresh and headless export (no memory registry) can be parsed. Not cleaning: def is small, the project can only have dozens of items at most.
      const fxDefs = a.defs?.length
        ? { ...s.fxDefs, ...Object.fromEntries(a.defs.map((d) => [d.id, d])) }
        : s.fxDefs;
      return {
        ...s,
        ...(fxDefs !== s.fxDefs ? { fxDefs } : {}),
        items: s.items.map((it) => (it.id === a.id ? { ...it, effects: a.effects.length ? a.effects : undefined } : it)),
      };
    }
    case 'replaceMedia':
      if (lockedItem(s, a.id)) return s;
      // To video: swap an MG/text clip for the baked video, keeping its slot
      // (track/start/duration/name/volume). Effects/transform/etc. are already
      // rendered into the video, so they're dropped.
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id
          ? { id: it.id, track: it.track, startFrame: it.startFrame, durationInFrames: it.durationInFrames,
              kind: 'video', name: it.name, src: a.src,
              sourceRevision: createMediaSourceRevision({ src: a.src, kind: 'video', durationInFrames: it.durationInFrames }),
              volume: it.volume ?? 1 }
          : it)),
      };
    case 'setSpeed': {
      if (lockedItem(s, a.id)) return s;
      const target = s.items.find((it) => it.id === a.id);
      if (!target) return s;
      const rate = Math.max(0.1, Math.min(8, a.rate));
      // preserve the source span: newDuration = sourceSpan / rate
      const sourceSpan = timelineFramesToSourceFrames(target, target.durationInFrames);
      const durationInFrames = Math.max(1, Math.round(sourceSpan / rate));
      const oldEnd = target.startFrame + target.durationInFrames;
      const deltaEnd = (target.startFrame + durationInFrames) - oldEnd;
      // The right edge moves with the speed → push the following same-track clip to fill in/get out of the way. Push only the closest continuous chain:
      // The gap intentionally left by the user is the boundary. One speed change should not drag away everything behind the entire track.
      const rippled = deltaEnd === 0 ? null : contiguousFollowers(s.items, target.track, oldEnd);
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id === a.id) {
            return {
              ...it,
              playbackRate: rate,
              durationInFrames,
              ...(it.keyframes ? { keyframes: scaleItemKeyframes(it.keyframes, durationInFrames / it.durationInFrames) } : {}),
            };
          }
          if (rippled?.has(it.id)) {
            return { ...it, startFrame: Math.max(0, it.startFrame + deltaEnd) };
          }
          return it;
        }),
      };
    }
    case 'reframeKeyframe':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          const zoom = it.zoom ?? {};
          const curve = zoom.reframeCurve ?? EMPTY_CURVE;
          // replace any keyframe at the same frame, then keep sorted
          const keyframes = [
            ...curve.keyframes.filter((k) => k.frame !== a.frame),
            { frame: a.frame, focalPointX: a.focalPointX, focalPointY: a.focalPointY, magnification: a.magnification },
          ].sort((x, y) => x.frame - y.frame);
          return { ...it, zoom: { ...zoom, reframeCurve: { ...curve, keyframes } } };
        }),
      };
    case 'removeReframeKeyframe':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.zoom?.reframeCurve) return it;
          const keyframes = it.zoom.reframeCurve.keyframes.filter((k) => k.frame !== a.frame);
          const reframeCurve = keyframes.length ? { ...it.zoom.reframeCurve, keyframes } : undefined;
          return { ...it, zoom: { ...it.zoom, reframeCurve } };
        }),
      };
    case 'setKeyframe': {
      // generic transform keyframe (PRD §4.5): same-frame overwrites, kept sorted.
      const target = s.items.find((x) => x.id === a.id);
      if (!target || !supportsKeyframeProperty(target, a.prop) || lockedItem(s, a.id)
        || !Number.isFinite(a.frame) || !Number.isFinite(a.value)) return s;
      const frame = Math.max(0, Math.round(a.frame));
      const value = coerceKeyframeValue(a.prop, a.value);
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id
          ? { ...it, keyframes: { ...it.keyframes, [a.prop]: upsertKeyframe(it.keyframes?.[a.prop], frame, value, a.easing) } }
          : it)),
      };
    }
    case 'removeKeyframe': {
      const target = s.items.find((x) => x.id === a.id);
      if (lockedItem(s, a.id) || !target?.keyframes?.[a.prop]?.some((k) => k.frame === a.frame)) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          const rest = it.keyframes![a.prop]!.filter((k) => k.frame !== a.frame);
          const { [a.prop]: _gone, ...others } = it.keyframes!;
          const keyframes = rest.length ? { ...others, [a.prop]: rest } : others;
          return { ...it, keyframes: Object.keys(keyframes).length ? keyframes : undefined };
        }),
      };
    }
    case 'clearKeyframes': {
      const target = s.items.find((x) => x.id === a.id);
      if (lockedItem(s, a.id) || !target?.keyframes || (a.prop && !target.keyframes[a.prop])) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.keyframes) return it;
          if (!a.prop) return { ...it, keyframes: undefined };
          const { [a.prop]: _gone, ...rest } = it.keyframes;
          return { ...it, keyframes: Object.keys(rest).length ? rest : undefined };
        }),
      };
    }
    default:
      return undefined;
  }
}
