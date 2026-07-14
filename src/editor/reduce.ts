// Pure reducer layer: the per-timeline reducer (`reduce`) + the project reducer
// (`projectReduce`, routing per-timeline actions to the active timeline) + the
// undo/redo history wrapper. The command set + React hook live in store.ts.
import type { AspectFit, ClipEffect, ClipFilters, ClipTransform, Marker, MediaAsset, ProjectDoc, Timeline, TimelineItem, TimelineState, TrackId, TransitionItem, TransitionType, ZoomEffect } from './types';
import { activeTimeline, trackEnd } from './types';
import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';
import { editedFrames, fillerIndices } from '../transcript/edit';

// ── command actions (these map 1:1 to the future agent tools) ─────────────
export type Action =
  | { type: 'add'; item: Omit<TimelineItem, 'startFrame'>; startFrame?: number; ripple?: boolean }
  | { type: 'updateProps'; id: string; patch: Record<string, unknown> }
  | { type: 'move'; id: string; track?: TrackId; startFrame?: number }
  | { type: 'retime'; id: string; startFrame?: number; durationInFrames?: number; srcInFrame?: number }
  | { type: 'setVolume'; id: string; volume: number }
  | { type: 'setFade'; id: string; fadeInFrames?: number; fadeOutFrames?: number }
  | { type: 'setTransform'; id: string; patch: ClipTransform }
  | { type: 'setFilters'; id: string; patch: ClipFilters }
  | { type: 'setZoom'; id: string; patch: Partial<ZoomEffect> | null }
  | { type: 'setEffects'; id: string; effects: ClipEffect[] }
  | { type: 'addMarker'; marker: Marker }
  | { type: 'updateMarker'; id: string; patch: Partial<Marker> }
  | { type: 'removeMarker'; id: string }
  | { type: 'reframeKeyframe'; id: string; frame: number; focalPointX: number; focalPointY: number; magnification: number }
  | { type: 'removeReframeKeyframe'; id: string; frame: number }
  | { type: 'addTransition'; id: string; incomingItemId: string; transType: TransitionType; durationInFrames?: number }
  | { type: 'setTransition'; id: string; patch: Partial<TransitionItem> }
  | { type: 'removeTransition'; id: string }
  | { type: 'duplicate'; id: string; newId: string }
  | { type: 'remove'; id: string; ripple?: boolean }
  | { type: 'split'; id: string; atFrame: number; newId: string }
  | { type: 'clear' }
  | { type: 'addAsset'; asset: MediaAsset }
  | { type: 'setCanvas'; width: number; height: number; fit?: AspectFit }
  | { type: 'toggleTrack'; track: TrackId; flag: 'hidden' | 'muted' }
  | { type: 'setCaptions'; captions: CaptionsData | null }
  | { type: 'updateCaptions'; patch: Partial<CaptionsData> }
  | { type: 'setItemTranscript'; id: string; words: TranscriptWord[] }
  | { type: 'toggleWord'; id: string; idx: number }
  | { type: 'deleteWords'; id: string; idxs: number[] }
  | { type: 'cleanScript'; id: string; silenceFrames?: number; removeFillers: boolean }
  | { type: 'clearEdits'; id: string }
  | { type: 'select'; id: string | null }
  | { type: 'setFullState'; state: TimelineState };

// ── project-level actions (multi-timeline; source manage_timelines) ────────
// These operate on the ProjectDoc (the set of timelines), not on any single
// timeline's items. All per-timeline Actions above are routed to the active
// timeline by projectReduce.
export type ProjectAction =
  | { type: 'tl.create'; timeline: Timeline; activate?: boolean }
  | { type: 'tl.switch'; id: string }
  | { type: 'tl.duplicate'; id: string; newId: string; name: string; retarget?: { width: number; height: number; fit?: AspectFit }; activate?: boolean }
  | { type: 'tl.delete'; id: string }
  | { type: 'tl.rename'; id: string; name: string }
  | { type: 'tl.retarget'; id: string; width: number; height: number; fit?: AspectFit }
  | { type: 'tl.setHidden'; id: string; hidden: boolean }
  | { type: 'tl.setDoc'; doc: ProjectDoc };

/** any store action: per-timeline or project-level (what a draft records) */
export type AnyAction = Action | ProjectAction;
/** dispatch accepted by the command set: store actions + history undo/redo */
export type Dispatch = (a: Action | { type: 'undo' } | { type: 'redo' }) => void;
/** dispatch at the project level: per-timeline + project actions + undo/redo */
export type ProjectDispatch = (a: AnyAction | { type: 'undo' } | { type: 'redo' }) => void;

const MUTATING = new Set(['add', 'updateProps', 'move', 'retime', 'setVolume', 'setFade', 'setTransform', 'setFilters', 'setZoom', 'setEffects', 'reframeKeyframe', 'removeReframeKeyframe', 'addTransition', 'setTransition', 'removeTransition', 'addMarker', 'updateMarker', 'removeMarker', 'duplicate', 'remove', 'split', 'clear', 'addAsset', 'setCanvas', 'toggleTrack', 'setCaptions', 'updateCaptions', 'toggleWord', 'deleteWords', 'cleanScript', 'clearEdits', 'setFullState',
  // project-level (tl.switch is navigation → deliberately NOT here, so it makes no history step)
  'tl.create', 'tl.duplicate', 'tl.delete', 'tl.rename', 'tl.retarget', 'tl.setHidden', 'tl.setDoc']);

const EMPTY_CURVE = { version: 1, timebase: 'effect-frame', coordinateSpace: 'composition-normalized', keyframes: [] } as const;

// recompute a transcript-edited clip's duration under its current edit state
function editedDuration(it: TimelineItem, deleted: Set<number>, fps: number): number {
  return editedFrames(it.transcript!, deleted, fps, { maxGapFrames: it.silenceFrames });
}

export function reduce(s: TimelineState, a: Action): TimelineState {
  switch (a.type) {
    case 'add': {
      // compute placement from CURRENT state (correct for sequential adds)
      const startFrame = a.startFrame ?? trackEnd(s, a.item.track);
      const item: TimelineItem = { ...a.item, startFrame };
      // ripple insert (source insert edit): push same-track clips at/after the
      // insertion point right by the new clip's duration to make room (no overwrite).
      const base = a.ripple
        ? s.items.map((it) => (it.track === item.track && it.startFrame >= startFrame
            ? { ...it, startFrame: it.startFrame + item.durationInFrames } : it))
        : s.items;
      return { ...s, items: [...base, item], selectedId: item.id };
    }
    case 'updateProps':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id ? { ...it, props: { ...it.props, ...a.patch } } : it,
        ),
      };
    case 'move':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id
            ? { ...it, track: a.track ?? it.track, startFrame: Math.max(0, a.startFrame ?? it.startFrame) }
            : it,
        ),
      };
    case 'retime':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id
            ? {
                ...it,
                startFrame: Math.max(0, a.startFrame ?? it.startFrame),
                durationInFrames: Math.max(1, a.durationInFrames ?? it.durationInFrames),
                srcInFrame: a.srcInFrame === undefined ? it.srcInFrame : Math.max(0, a.srcInFrame),
              }
            : it,
        ),
      };
    case 'setVolume':
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, volume: Math.max(0, Math.min(2, a.volume)) } : it)),
      };
    case 'setFade':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          // clamp each fade to at most the clip's length; keep the other side unchanged
          const cap = it.durationInFrames;
          return {
            ...it,
            fadeInFrames: a.fadeInFrames === undefined ? it.fadeInFrames : Math.max(0, Math.min(cap, a.fadeInFrames)),
            fadeOutFrames: a.fadeOutFrames === undefined ? it.fadeOutFrames : Math.max(0, Math.min(cap, a.fadeOutFrames)),
          };
        }),
      };
    case 'setTransform':
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, transform: { ...it.transform, ...a.patch } } : it)),
      };
    case 'setFilters':
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, filters: { ...it.filters, ...a.patch } } : it)),
      };
    case 'setZoom':
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, zoom: a.patch === null ? undefined : { ...it.zoom, ...a.patch } } : it)),
      };
    case 'setEffects':
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, effects: a.effects.length ? a.effects : undefined } : it)),
      };
    case 'reframeKeyframe':
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
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.zoom?.reframeCurve) return it;
          const keyframes = it.zoom.reframeCurve.keyframes.filter((k) => k.frame !== a.frame);
          const reframeCurve = keyframes.length ? { ...it.zoom.reframeCurve, keyframes } : undefined;
          return { ...it, zoom: { ...it.zoom, reframeCurve } };
        }),
      };
    case 'addTransition': {
      const inItem = s.items.find((x) => x.id === a.incomingItemId);
      if (!inItem || inItem.kind === 'audio') return s;
      // outgoing = the same-track visual clip whose end sits at (adjacent to) the incoming's start
      const prior = s.items.filter(
        (x) => x.id !== inItem.id && x.track === inItem.track && x.kind !== 'audio' && x.startFrame + x.durationInFrames <= inItem.startFrame + 2,
      );
      if (!prior.length) return s;
      const out = prior.reduce((best, x) => (x.startFrame + x.durationInFrames > best.startFrame + best.durationInFrames ? x : best));
      if (inItem.startFrame - (out.startFrame + out.durationInFrames) > 2) return s; // must be adjacent
      const maxL = Math.max(2, Math.min(out.durationInFrames, inItem.durationInFrames));
      const L = Math.max(2, Math.min(a.durationInFrames ?? Math.min(30, maxL), maxL));
      const t: TransitionItem = { id: a.id, type: a.transType, durationInFrames: L, outgoingItemId: out.id, incomingItemId: inItem.id, trackId: inItem.track, enabled: true };
      const others = (s.transitions ?? []).filter((x) => x.incomingItemId !== inItem.id); // one in-transition per clip
      return { ...s, transitions: [...others, t] };
    }
    case 'addMarker':
      return { ...s, markers: [...(s.markers ?? []), a.marker] };
    case 'updateMarker':
      return { ...s, markers: (s.markers ?? []).map((m) => (m.id === a.id ? { ...m, ...a.patch } : m)) };
    case 'removeMarker':
      return { ...s, markers: (s.markers ?? []).filter((m) => m.id !== a.id) };
    case 'setTransition':
      return {
        ...s,
        transitions: (s.transitions ?? []).map((t) => {
          if (t.id !== a.id) return t;
          const merged = { ...t, ...a.patch };
          if (a.patch.durationInFrames !== undefined) {
            // can't exceed either clip's length (avoids freeze frames / overlap, like source edit_item)
            const out = s.items.find((x) => x.id === t.outgoingItemId);
            const inc = s.items.find((x) => x.id === t.incomingItemId);
            const maxL = Math.max(2, Math.min(out?.durationInFrames ?? 2, inc?.durationInFrames ?? 2));
            merged.durationInFrames = Math.max(2, Math.min(merged.durationInFrames, maxL));
          }
          return merged;
        }),
      };
    case 'removeTransition':
      return { ...s, transitions: (s.transitions ?? []).filter((t) => t.id !== a.id) };
    case 'duplicate': {
      const it = s.items.find((x) => x.id === a.id);
      if (!it) return s;
      const copy: TimelineItem = { ...it, id: a.newId, props: { ...it.props }, startFrame: trackEnd(s, it.track) };
      return { ...s, items: [...s.items, copy], selectedId: copy.id };
    }
    case 'clear':
      return { ...s, items: [], selectedId: null };
    case 'addAsset':
      return { ...s, assets: [...(s.assets ?? []), a.asset] };
    case 'setCanvas':
      return { ...s, width: a.width, height: a.height, fit: a.fit ?? s.fit ?? 'contain' };
    case 'toggleTrack': {
      const cur = s.tracks?.[a.track] ?? {};
      return { ...s, tracks: { ...s.tracks, [a.track]: { ...cur, [a.flag]: !cur[a.flag] } } };
    }
    case 'setCaptions':
      return { ...s, captions: a.captions };
    case 'updateCaptions':
      return s.captions ? { ...s, captions: { ...s.captions, ...a.patch } } : s;
    case 'setItemTranscript':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id ? { ...it, transcript: a.words, deletedWordIdx: [], silenceFrames: undefined, durationInFrames: editedFrames(a.words, new Set(), s.fps) } : it,
        ),
      };
    case 'toggleWord':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.transcript) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          del.has(a.idx) ? del.delete(a.idx) : del.add(a.idx);
          return { ...it, deletedWordIdx: [...del], durationInFrames: editedDuration(it, del, s.fps) };
        }),
      };
    case 'deleteWords':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.transcript) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          for (const idx of a.idxs) if (idx >= 0 && idx < it.transcript.length) del.add(idx);
          return { ...it, deletedWordIdx: [...del], durationInFrames: editedDuration(it, del, s.fps) };
        }),
      };
    case 'cleanScript':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.transcript) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          if (a.removeFillers) for (const idx of fillerIndices(it.transcript)) del.add(idx);
          const next = { ...it, deletedWordIdx: [...del], silenceFrames: a.silenceFrames };
          return { ...next, durationInFrames: editedDuration(next, del, s.fps) };
        }),
      };
    case 'clearEdits':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id && it.transcript ? { ...it, deletedWordIdx: [], silenceFrames: undefined, durationInFrames: editedFrames(it.transcript, new Set(), s.fps) } : it,
        ),
      };
    case 'remove': {
      const gone = s.items.find((it) => it.id === a.id);
      // ripple delete (source): close the gap — shift same-track clips that
      // start at/after the removed clip's OUT point left by its duration.
      const end = gone ? gone.startFrame + gone.durationInFrames : 0;
      const kept = s.items
        .filter((it) => it.id !== a.id)
        .map((it) => (a.ripple && gone && it.track === gone.track && it.startFrame >= end
          ? { ...it, startFrame: Math.max(0, it.startFrame - gone.durationInFrames) } : it));
      return {
        ...s,
        items: kept,
        // drop transitions that referenced the removed clip
        transitions: (s.transitions ?? []).filter((t) => t.incomingItemId !== a.id && t.outgoingItemId !== a.id),
        selectedId: s.selectedId === a.id ? null : s.selectedId,
      };
    }
    case 'split': {
      const it = s.items.find((x) => x.id === a.id);
      if (!it || a.atFrame <= it.startFrame || a.atFrame >= it.startFrame + it.durationInFrames) return s;
      const cut = a.atFrame - it.startFrame; // frames of source consumed by the left half
      const left = { ...it, durationInFrames: cut };
      // the right half resumes the source where the left one ended (advances srcInFrame)
      const right = { ...it, id: a.newId, startFrame: a.atFrame, durationInFrames: it.durationInFrames - cut, srcInFrame: (it.srcInFrame ?? 0) + cut };
      return { ...s, items: s.items.flatMap((x) => (x.id === a.id ? [left, right] : [x])) };
    }
    case 'select':
      return { ...s, selectedId: a.id };
    case 'setFullState':
      return a.state; // atomic commit of a proposal's result (one history step)
    default:
      return s;
  }
}

// ── project reducer (routes per-timeline actions to the active timeline) ───
export const maxOrder = (p: ProjectDoc) => p.timelines.reduce((m, t) => Math.max(m, t.order), -1);
const isProjectAction = (a: { type: string }): a is ProjectAction => a.type.startsWith('tl.');

// stamp a per-timeline reducer result back onto its identity (setFullState
// returns a bare TimelineState, so id/name/order must be re-applied).
const stamp = (next: TimelineState, id: string, name: string, order: number): Timeline => ({ ...next, id, name, order });

export function projectReduce(p: ProjectDoc, a: Action | ProjectAction): ProjectDoc {
  if (isProjectAction(a)) {
    switch (a.type) {
      case 'tl.create': {
        const activeTimelineId = a.activate === false ? p.activeTimelineId : a.timeline.id;
        return { timelines: [...p.timelines, a.timeline], activeTimelineId };
      }
      case 'tl.switch':
        return p.timelines.some((t) => t.id === a.id) ? { ...p, activeTimelineId: a.id } : p;
      case 'tl.duplicate': {
        const src = p.timelines.find((t) => t.id === a.id);
        if (!src) return p;
        // clone verbatim (item ids stay — timelines never share one items[] array,
        // so ids can't collide; retarget swaps the canvas for long→short).
        const copy: Timeline = {
          ...src, id: a.newId, name: a.name, order: maxOrder(p) + 1, selectedId: null, hidden: false,
          ...(a.retarget ? { width: a.retarget.width, height: a.retarget.height, fit: a.retarget.fit ?? src.fit ?? 'contain' } : {}),
        };
        return { timelines: [...p.timelines, copy], activeTimelineId: a.activate === false ? p.activeTimelineId : copy.id };
      }
      case 'tl.delete': {
        if (p.timelines.length <= 1) return p; // keep at least one timeline
        const rest = p.timelines.filter((t) => t.id !== a.id);
        const fallback = rest.find((t) => !t.hidden) ?? rest[0];
        const activeTimelineId = p.activeTimelineId === a.id ? fallback.id : p.activeTimelineId;
        return { timelines: rest, activeTimelineId };
      }
      case 'tl.rename':
        return { ...p, timelines: p.timelines.map((t) => (t.id === a.id ? { ...t, name: a.name } : t)) };
      case 'tl.retarget':
        return { ...p, timelines: p.timelines.map((t) => (t.id === a.id ? { ...t, width: a.width, height: a.height, fit: a.fit ?? t.fit ?? 'contain' } : t)) };
      case 'tl.setHidden': {
        // source rule: the last visible timeline can't be hidden
        const visible = p.timelines.filter((t) => !t.hidden);
        if (a.hidden && visible.length <= 1 && visible[0]?.id === a.id) return p;
        const timelines = p.timelines.map((t) => (t.id === a.id ? { ...t, hidden: a.hidden } : t));
        // hiding the active timeline: the editor must show something → first visible
        const activeTimelineId =
          a.hidden && p.activeTimelineId === a.id
            ? (timelines.find((t) => !t.hidden)?.id ?? p.activeTimelineId)
            : p.activeTimelineId;
        return { timelines, activeTimelineId };
      }
      case 'tl.setDoc':
        return a.doc; // atomic commit of a project-level proposal (one history step)
      default:
        return p;
    }
  }
  // per-timeline action → apply to the active timeline only
  const active = activeTimeline(p);
  if (!active) return p;
  const next = reduce(active, a);
  if (next === active) return p;
  const stamped = stamp(next, active.id, active.name, active.order);
  return { ...p, timelines: p.timelines.map((t) => (t.id === active.id ? stamped : t)) };
}

// ── history wrapper (snapshot-based undo/redo over the whole project) ──────
export interface History {
  past: ProjectDoc[];
  present: ProjectDoc;
  future: ProjectDoc[];
}

export function historyReduce(h: History, a: Action | ProjectAction | { type: 'undo' } | { type: 'redo' }): History {
  if (a.type === 'undo') {
    if (!h.past.length) return h;
    const previous = h.past[h.past.length - 1];
    return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future] };
  }
  if (a.type === 'redo') {
    if (!h.future.length) return h;
    const next = h.future[0];
    return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
  }
  const next = projectReduce(h.present, a);
  if (next === h.present) return h;
  if (MUTATING.has(a.type)) return { past: [...h.past, h.present], present: next, future: [] };
  return { ...h, present: next }; // select / tl.switch: no history
}
