// 时间线指针状态机(逐字搬自 Timeline.tsx):四条互斥手势——片段拖动/裁剪(drag)、
// 空白处框选(marquee)、钢笔关键帧点拖(penDrag)、选择模式引用拾取(pickDrag)。
// move/up 统一挂在滚动容器上;各手势自己 setPointerCapture 到合适目标。
// 吸附(applySnap)与多选点击语义也在这——它们只被这台机器用。
import { useState, type RefObject } from 'react';
import {
  isItemSelected, selectedIdsOf, trackKind,
  type KeyframeEasing, type TimelineItem, type TimelineState, type TrackId,
} from '../../editor/types';
import { groupMoveIds, moveItemsByDelta } from '../../editor/multiSelect';
import { upsertKeyframe } from '../../editor/keyframes';
import { collectTimelineSnapPoints, snapDraggedEdges } from '../../editor/snap';
import type { EditorCommands } from '../../editor/store';
import { emitSelectionRef, resolveTimelinePick, type TimelinePickDrag } from '../../agent/selection-refs';
import { SNAP_PX, type Drag, type DragMode } from './timelineUtil';

export interface PenDrag {
  itemId: string; fromFrame: number; frame: number; value: number; easing?: KeyframeEasing;
  laneTop: number; laneHeight: number;
}
export interface Marquee { x0: number; y0: number; x1: number; y1: number; additive: boolean }

interface PointerDeps {
  state: TimelineState;
  commands: EditorCommands;
  editMode: 'selection' | 'blade' | 'trim' | 'pen';
  snapping: boolean;
  pickMode: boolean;
  px: number;
  playheadRef: RefObject<number>;
  scrollRef: RefObject<HTMLDivElement | null>;
  frameFromClientX: (clientX: number) => number;
  trackFromClientY: (clientY: number) => TrackId;
  /** clips whose time range + track lane intersect a client-space rect (marquee commit) */
  itemsInMarquee: (left: number, top: number, right: number, bottom: number) => string[];
}

export function useTimelinePointer(deps: PointerDeps) {
  const {
    state, commands, editMode, snapping, pickMode, px,
    playheadRef, scrollRef, frameFromClientX, trackFromClientY, itemsInMarquee,
  } = deps;
  const [drag, setDrag] = useState<Drag | null>(null);
  // pen mode: one opacity keyframe dot being dragged (live preview, atomic commit on release)
  const [penDrag, setPenDrag] = useState<PenDrag | null>(null);
  /** Rubber-band multi-select on empty lane (selection mode). Client coords. */
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [pickDrag, setPickDrag] = useState<TimelinePickDrag | null>(null);

  const startPick = (e: React.PointerEvent, origin: TimelinePickDrag['origin'], item?: TimelineItem) => {
    e.stopPropagation();
    if (e.button !== 0) return; // left button only; right-click keeps the context menu
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const f = frameFromClientX(e.clientX);
    const trackId = origin === 'clip' ? item?.track : origin === 'lane' ? trackFromClientY(e.clientY) : undefined;
    setPickDrag({ origin, startFrame: f, endFrame: f, trackId, item });
  };
  /** Start rubber-band on empty track body (clips stopPropagation so they never hit this). */
  const startMarquee = (e: React.PointerEvent) => {
    if (pickMode || editMode !== 'selection' || e.button !== 0) return;
    e.stopPropagation();
    // Capture on the scroll container so move/up keep firing (same target as handlers).
    scrollRef.current?.setPointerCapture?.(e.pointerId);
    setMarquee({
      x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY,
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
    });
  };

  const startDrag = (e: React.PointerEvent, id: string, mode: DragMode, baseStart: number, baseDur: number, baseTrack: TrackId, baseSrcIn = 0) => {
    if (state.tracks?.[baseTrack]?.locked) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Multi-select: ⌘/Ctrl toggle, ⇧ range on same track; plain click replaces.
    if (e.metaKey || e.ctrlKey) {
      commands.selectItem(id, { mode: 'toggle' });
    } else if (e.shiftKey && state.selectedId) {
      const anchor = state.items.find((x) => x.id === state.selectedId);
      const target = state.items.find((x) => x.id === id);
      if (anchor && target && anchor.track === target.track) {
        const lo = Math.min(anchor.startFrame, target.startFrame);
        const hi = Math.max(anchor.startFrame, target.startFrame);
        const range = state.items
          .filter((x) => x.track === anchor.track && x.startFrame >= lo && x.startFrame <= hi)
          .map((x) => x.id);
        commands.selectItems(range);
      } else {
        commands.selectItem(id);
      }
    } else if (!isItemSelected(state, id)) {
      commands.selectItem(id);
    } else {
      // already in multi-selection: keep set, set primary via re-add
      commands.selectItem(id, { mode: 'add' });
    }
    // Only start move drag when not pure multi-toggle without drag intent — still allow drag
    setDrag({ id, mode, baseStart, baseDur, baseTrack, baseSrcIn, startX: e.clientX, deltaF: 0, targetTrack: baseTrack, snapAt: null });
  };
  // All snap targets come from the editor snap registry. Group moves exclude
  // every selected clip so members never snap to each other.
  const applySnap = (mode: DragMode, baseStart: number, baseDur: number, rawDelta: number): { deltaF: number; snapAt: number | null } => {
    if (!snapping) return { deltaF: rawDelta, snapAt: null };
    const skip = new Set(
      mode === 'move' && drag?.id ? groupMoveIds(state, drag.id) : drag?.id ? [drag.id] : [],
    );
    const points = collectTimelineSnapPoints(state, {
      playheadFrame: playheadRef.current,
      excludeItemIds: skip,
    });
    return snapDraggedEdges({
      mode, baseStart, baseDuration: baseDur, rawDelta,
      points, thresholdFrames: SNAP_PX / px,
    });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (marquee) {
      setMarquee((m) => (m ? { ...m, x1: e.clientX, y1: e.clientY } : m));
      return;
    }
    if (pickDrag) {
      const f = frameFromClientX(e.clientX);
      setPickDrag((d) => (d ? { ...d, endFrame: f } : d));
      return;
    }
    if (penDrag) {
      const it = state.items.find((x) => x.id === penDrag.itemId);
      if (it) {
        const frame = Math.max(0, Math.min(it.durationInFrames - 1, frameFromClientX(e.clientX) - it.startFrame));
        const value = Math.max(0, Math.min(1, 1 - (e.clientY - penDrag.laneTop) / Math.max(1, penDrag.laneHeight)));
        setPenDrag((d) => (d ? { ...d, frame, value: Math.round(value * 100) / 100 } : d));
      }
      return;
    }
    if (!drag) return;
    const rawDelta = Math.round((e.clientX - drag.startX) / px);
    const { deltaF, snapAt } = applySnap(drag.mode, drag.baseStart, drag.baseDur, rawDelta);
    const targetTrack = drag.mode === 'move' ? trackFromClientY(e.clientY) : drag.baseTrack;
    setDrag((d) => (d ? { ...d, deltaF, targetTrack, snapAt } : d));
  };
  const onPointerUp = () => {
    if (marquee) {
      const m = marquee;
      setMarquee(null);
      const dx = Math.abs(m.x1 - m.x0);
      const dy = Math.abs(m.y1 - m.y0);
      // tiny move = empty-lane click → clear selection (unless additive)
      if (dx < 4 && dy < 4) {
        if (!m.additive) commands.selectItem(null);
        return;
      }
      const ids = itemsInMarquee(
        Math.min(m.x0, m.x1), Math.min(m.y0, m.y1),
        Math.max(m.x0, m.x1), Math.max(m.y0, m.y1),
      );
      if (m.additive) {
        const prev = selectedIdsOf(state);
        commands.selectItems([...new Set([...prev, ...ids])]);
      } else {
        commands.selectItems(ids);
      }
      return;
    }
    if (pickDrag) {
      // click vs drag threshold: ~4px of pointer travel in frames at this zoom
      const ref = resolveTimelinePick(pickDrag, Math.max(1, Math.round(4 / px)), state);
      if (ref) emitSelectionRef(ref);
      setPickDrag(null);
      return;
    }
    if (penDrag) {
      const it = state.items.find((x) => x.id === penDrag.itemId);
      const orig = it?.keyframes?.opacity?.find((k) => k.frame === penDrag.fromFrame);
      if (it && orig && (orig.frame !== penDrag.frame || orig.value !== penDrag.value)) {
        // move = delete old point + set new one, committed as ONE undo step
        const moved = upsertKeyframe(
          (it.keyframes?.opacity ?? []).filter((k) => k.frame !== penDrag.fromFrame),
          penDrag.frame, penDrag.value, penDrag.easing,
        );
        commands.applyState({
          ...state,
          items: state.items.map((x) => (x.id === it.id ? { ...x, keyframes: { ...x.keyframes, opacity: moved } } : x)),
        });
      }
      setPenDrag(null);
      return;
    }
    if (!drag) { return; }
    const { id, mode, baseStart, baseDur, baseSrcIn, deltaF, targetTrack, baseTrack } = drag;
    if (mode === 'move') {
      // keep video clips on video tracks, audio clips on audio tracks
      const isAudio = state.items.find((it) => it.id === id)?.kind === 'audio';
      const okTrack = !!targetTrack && trackKind(state, targetTrack) === (isAudio ? 'audio' : 'video') && !state.tracks?.[targetTrack]?.locked;
      const track = okTrack ? targetTrack : baseTrack;
      const ids = groupMoveIds(state, id);
      if (deltaF !== 0 || track !== baseTrack) {
        if (ids.length === 1) {
          commands.moveItem(id, { startFrame: Math.max(0, baseStart + deltaF), track });
        } else {
          // multi-select: one undo step — same Δt for every selected clip, relative track shift
          const next = moveItemsByDelta(
            state,
            ids,
            deltaF,
            track !== baseTrack ? { from: baseTrack, to: track } : null,
          );
          if (next !== state) commands.applyState(next);
        }
      }
    } else if (mode === 'trim-left') {
      // clamp so the source in-point can't go negative (limits how far left media extends)
      const d = Math.max(Math.min(deltaF, baseDur - 1), -baseSrcIn);
      if (d !== 0) commands.setItemTiming(id, { startFrame: Math.max(0, baseStart + d), durationInFrames: baseDur - d, srcInFrame: baseSrcIn + d });
    } else if (mode === 'trim-right') {
      const newDur = Math.max(1, baseDur + deltaF);
      const actual = newDur - baseDur;
      if (actual !== 0) {
        if (editMode === 'trim') {
          // ripple: retime this clip + slide every later same-track clip by the
          // duration change (one atomic step via applyState, so it's a single undo)
          const clipEnd = baseStart + baseDur;
          const items = state.items.map((it) =>
            it.id === id ? { ...it, durationInFrames: newDur }
              : it.track === baseTrack && it.startFrame >= clipEnd ? { ...it, startFrame: it.startFrame + actual }
              : it,
          );
          commands.applyState({ ...state, items });
        } else {
          commands.setItemTiming(id, { durationInFrames: newDur });
        }
      }
    }
    setDrag(null);
  };

  return { drag, penDrag, setPenDrag, marquee, pickDrag, startDrag, startPick, startMarquee, onPointerMove, onPointerUp };
}
