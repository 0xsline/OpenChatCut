// Timeline pointer state machine (translated verbatim from Timeline.tsx): four mutually exclusive gestures - fragment drag/crop (drag),
// Marquee selection in blank space (marquee), pen keyframe point drag (penDrag), selection mode reference picking (pickDrag).
// move/up are hung on the scroll container; each gesture setsPointerCapture to the appropriate target.
// The applySnap and multi-select click semantics are also here - they are only used by this machine.
import { useCallback, useEffect, useRef, useState, type RefObject, type SetStateAction } from 'react';
import {
  isItemSelected, selectedIdsOf, trackKind,
  type KeyframeEasing, type KeyframeProp, type TimelineItem, type TimelineState, type TrackId,
} from '../../editor/types';
import { groupMoveIds, moveItemsByDelta } from '../../editor/multiSelect';
import { upsertKeyframe } from '../../editor/keyframes';
import { getKeyframePropertyDefinition } from '../../editor/keyframeRegistry';
import { rateStretchItem } from '../../editor/rateStretch';
import { remainingSourceFrames, sourceFramesToTimelineFrames, sourceWindowForTimelineRange } from '../../editor/sourceLimit';
import {
  collectTimelineSnapPoints, snapDraggedEdges, sortTimelineSnapPoints,
  type SnapHold, type SnapPoint,
} from '../../editor/snap';
import type { EditorCommands } from '../../editor/store';
import type { CaptionSelectionRef } from '../../captions/captionSelection';
import {
  clampTimelineSelectionDelta,
  moveTimelineSelectionByDelta,
  resolveItemDragSelection,
} from '../../captions/captionGroupMove';
import { emitSelectionRef, resolveTimelinePick, type TimelinePickDrag } from '../../agent/selection-refs';
import { hasOperationalTranscript } from '../../transcript/types';
import { SNAP_PX, type Drag, type DragMode, type EditMode } from './timelineUtil';

export interface PenDrag {
  itemId: string; prop: KeyframeProp; fromFrame: number; frame: number; value: number; easing?: KeyframeEasing;
  laneTop: number; laneHeight: number;
}
export interface Marquee { x0: number; y0: number; x1: number; y1: number; additive: boolean }
export interface TimelineMarqueeSelection {
  itemIds: string[];
  captionSelections: CaptionSelectionRef[];
}

type PointerStateSetter<T> = (next: SetStateAction<T>, publish?: boolean) => void;

function usePointerState<T>(initial: T) {
  const [value, publishValue] = useState(initial);
  const ref = useRef(value);
  const setValue: PointerStateSetter<T> = useCallback((next, publish = true) => {
    const resolved = typeof next === 'function'
      ? (next as (current: T) => T)(ref.current)
      : next;
    ref.current = resolved;
    if (publish) publishValue(resolved);
  }, [publishValue]);
  return [value, setValue, ref] as const;
}

interface PointerDeps {
  state: TimelineState;
  commands: EditorCommands;
  editMode: EditMode;
  snapping: boolean;
  pickMode: boolean;
  px: number;
  playheadRef: RefObject<number>;
  scrollRef: RefObject<HTMLDivElement | null>;
  frameFromClientX: (clientX: number) => number;
  trackFromClientY: (clientY: number) => TrackId;
  /** clips and caption cues intersecting a client-space marquee rect */
  selectionInMarquee: (left: number, top: number, right: number, bottom: number) => TimelineMarqueeSelection;
  onMarqueeCaptionSelect: (
    selections: CaptionSelectionRef[],
    options: { additive: boolean; preserveWithItems: boolean },
  ) => void;
  selectedCaptions: CaptionSelectionRef[];
  /** True when a timeline drag is released over the Agent composer. */
  isOverChatComposer?: (clientX: number, clientY: number) => boolean;
  /** Add the frozen mixed selection to chat instead of committing a timeline move. */
  onDropSelectionToChat?: (selection: TimelineMarqueeSelection) => void;
}

/**
 * The right edge of the nearest same-track clip that ends at or before `baseStart`.
 * Used to clamp a left-extend trim so the dragged edge never overlaps its predecessor
 * (which would be rolled back by the overlap guard and "bounce" on release).
 */
function predecessorRightEdge(state: TimelineState, id: string, track: TrackId | undefined, baseStart: number): number {
  let rightEdge = -Infinity;
  for (const item of state.items) {
    if (item.id === id || item.track !== track) continue;
    const end = item.startFrame + item.durationInFrames;
    if (end > baseStart) continue;
    if (end > rightEdge) rightEdge = end;
  }
  return rightEdge;
}

function commitMoveGesture(state: TimelineState, commands: EditorCommands, drag: Drag) {
  const { id, baseStart, deltaF, targetTrack, baseTrack } = drag;
  const validTrack = !!targetTrack
    && trackKind(state, targetTrack) === trackKind(state, baseTrack)
    && !state.tracks?.[targetTrack]?.locked;
  const track = validTrack ? targetTrack : baseTrack;
  if (deltaF === 0 && track === baseTrack) return;
  const ids = groupMoveIds(state, id);
  if (ids.length === 1) {
    commands.moveItem(id, { startFrame: Math.max(0, baseStart + deltaF), track });
    return;
  }
  const next = moveItemsByDelta(
    state,
    ids,
    deltaF,
    track !== baseTrack ? { from: baseTrack, to: track } : null,
  );
  if (next !== state) commands.applyState(next);
}

function commitTrimGesture(
  state: TimelineState,
  commands: EditorCommands,
  drag: Drag,
  editMode: EditMode,
) {
  const { id, mode, baseStart, baseDur, baseSrcIn, deltaF, baseTrack } = drag;
  if (editMode === 'rate-stretch') {
    const next = rateStretchItem(state, id, mode === 'trim-left' ? 'left' : 'right', deltaF);
    if (next !== state) commands.applyState(next);
    return;
  }
  if (mode === 'trim-left') {
    const target = state.items.find((item) => item.id === id);
    if (!target) return;
    const sourceTimed = target.kind === 'video' || target.kind === 'audio' || target.kind === 'sequence';
    const wordDriven = target.kind === 'audio' && hasOperationalTranscript(target);
    // Pictures, MG, text, solids and word-driven audio have no source
    // duration limit: their left edge can extend back to timeline zero.
    // Only real file media (video/plain audio/sequence) are bounded by
    // srcInFrame.
    let earliestDelta = -baseStart;
    if (sourceTimed) {
      const sourceBacktrack = wordDriven
        ? baseSrcIn
        : sourceFramesToTimelineFrames(target, baseSrcIn);
      earliestDelta = Math.max(earliestDelta, -Math.floor(sourceBacktrack));
    }
    // Left-extend must stop at the nearest preceding same-track clip's right edge.
    // Without this clamp the retime would overlap the predecessor and the reducer's
    // overlap guard would roll the whole gesture back — dragging past it would show
    // a preview extension but "bounce" on release.
    earliestDelta = Math.max(earliestDelta, predecessorRightEdge(state, id, baseTrack, baseStart) - baseStart);
    const delta = Math.max(Math.min(deltaF, baseDur - 1), earliestDelta);
    if (delta === 0) return;
    const timing = {
      startFrame: baseStart + delta,
      durationInFrames: baseDur - delta,
      ...(sourceTimed ? {
        srcInFrame: wordDriven
          ? sourceWindowForTimelineRange(
              { srcInFrame: baseSrcIn, playbackRate: 1 },
              delta,
              baseDur - delta,
            ).startFrame
          : sourceWindowForTimelineRange(
              { ...target, srcInFrame: baseSrcIn },
              delta,
              baseDur - delta,
            ).startFrame,
      } : {}),
    };
    commands.setItemTiming(id, timing);
    return;
  }
  const durationInFrames = Math.max(1, baseDur + deltaF);
  const actual = durationInFrames - baseDur;
  if (actual === 0) return;
  if (editMode !== 'trim') {
    commands.setItemTiming(id, { durationInFrames });
    return;
  }
  const clipEnd = baseStart + baseDur;
  const items = state.items.map((item) =>
    item.id === id ? { ...item, durationInFrames }
      : item.track === baseTrack && item.startFrame >= clipEnd
        ? { ...item, startFrame: item.startFrame + actual }
        : item);
  commands.applyState({ ...state, items });
}

export function commitTimelineDragGesture(
  state: TimelineState,
  commands: EditorCommands,
  drag: Drag,
  editMode: EditMode,
) {
  if (drag.mode === 'slip') {
    if (Math.abs(drag.deltaF) >= 1e-6) commands.slipItem(drag.id, drag.deltaF);
  } else if (drag.mode === 'move') commitMoveGesture(state, commands, drag);
  else commitTrimGesture(state, commands, drag, editMode);
}

export function useTimelinePointer(deps: PointerDeps) {
  const {
    state, commands, editMode, snapping, pickMode, px,
    playheadRef, scrollRef, frameFromClientX, trackFromClientY, selectionInMarquee,
    onMarqueeCaptionSelect, selectedCaptions, isOverChatComposer, onDropSelectionToChat,
  } = deps;
  const [drag, setDrag, dragRef] = usePointerState<Drag | null>(null);
  // pen mode: one opacity keyframe dot being dragged (live preview, atomic commit on release)
  const [penDrag, setPenDrag, penDragRef] = usePointerState<PenDrag | null>(null);
  /** Rubber-band multi-select on empty lane (selection mode). Client coords. */
  const [marquee, setMarquee, marqueeRef] = usePointerState<Marquee | null>(null);
  const [pickDrag, setPickDrag, pickDragRef] = usePointerState<TimelinePickDrag | null>(null);
  /** Complete mixed selection frozen at pointer-down. */
  const dragSelectionRef = useRef<TimelineMarqueeSelection>({ itemIds: [], captionSelections: [] });
  /** The currently sucked target is held (hysteresis) across pointermove within one drag, and cleared when released. */
  const snapHold = useRef<SnapHold | null>(null);
  const gestureSnapPoints = useRef<SnapPoint[]>([]);
  const pendingMove = useRef<{ clientX: number; clientY: number } | null>(null);
  const pointerMoveRaf = useRef(0);

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
    e.preventDefault();
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!additive) {
      commands.selectItem(null);
      onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
    }
    // Capture on the scroll container so move/up keep firing (same target as handlers).
    scrollRef.current?.setPointerCapture?.(e.pointerId);
    setMarquee({
      x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY,
      additive,
    });
  };

  const startDrag = (e: React.PointerEvent, id: string, mode: DragMode, baseStart: number, baseDur: number, baseTrack: TrackId, baseSrcIn = 0) => {
    if (state.tracks?.[baseTrack]?.locked) return;
    const wasSelected = isItemSelected(state, id);
    const additive = e.metaKey || e.ctrlKey;
    const resolvedSelection = resolveItemDragSelection(
      id,
      selectedIdsOf(state),
      selectedCaptions,
      { shiftKey: e.shiftKey, anchorItemId: state.selectedId, items: state.items },
    );
    dragSelectionRef.current = mode === 'move'
      ? additive && !wasSelected
        ? { itemIds: [...new Set([...selectedIdsOf(state), id])], captionSelections: [...selectedCaptions] }
        : resolvedSelection
      : { itemIds: [id], captionSelections: [] };
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!wasSelected && !additive && !e.shiftKey) {
      onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
    }
    // Multi-select: ⌘/Ctrl toggle, ⇧ range on same track; plain click replaces.
    if (additive) {
      onMarqueeCaptionSelect([], { additive: true, preserveWithItems: true });
      commands.selectItem(id, { mode: 'toggle' });
    } else if (e.shiftKey && state.selectedId) {
      if (resolvedSelection.itemIds.length > 1) commands.selectItems(resolvedSelection.itemIds);
      else commands.selectItem(id);
    } else if (!wasSelected) {
      commands.selectItem(id);
    }
    // Only start move drag when not pure multi-toggle without drag intent — still allow drag
    snapHold.current = null;
    const excluded = mode === 'move' && dragSelectionRef.current.itemIds.includes(id)
      ? dragSelectionRef.current.itemIds
      : [id];
    gestureSnapPoints.current = sortTimelineSnapPoints(
      collectTimelineSnapPoints(state, { excludeItemIds: excluded }),
    );
    setDrag({ id, mode, baseStart, baseDur, baseTrack, baseSrcIn, startX: e.clientX, deltaF: 0, targetTrack: baseTrack, snapAt: null });
  };
  // All snap targets come from the editor snap registry. Group moves exclude
  // every selected clip so members never snap to each other.
  const applySnap = (mode: DragMode, baseStart: number, baseDur: number, rawDelta: number): { deltaF: number; snapAt: number | null } => {
    if (mode === 'slip') return { deltaF: rawDelta, snapAt: null };
    if (!snapping) return { deltaF: rawDelta, snapAt: null };
    const points = gestureSnapPoints.current;
    const result = snapDraggedEdges({
      mode, baseStart, baseDuration: baseDur, rawDelta, points,
      thresholdFrames: SNAP_PX / px, hold: snapHold.current,
      dynamicPlayheadFrame: playheadRef.current,
    });
    snapHold.current = result.hold;
    return result;
  };
  /**
   * The maximum number of frames the right handle can be dragged to the right: the remaining length of the source asset minus the current duration. Unable to determine (picture/MG/
   * Word Driven Audio) Return to Infinity. Variable speed stretching does not consume additional source frames, so there is no limit to that mode.
   */
  const trimRightCap = (id: string, baseDur: number): number => {
    if (editMode === 'rate-stretch') return Infinity;
    const it = state.items.find((x) => x.id === id);
    if (!it) return Infinity;
    const limit = remainingSourceFrames(it, it.srcInFrame ?? 0, state.assets);
    return limit === null ? Infinity : limit - baseDur;
  };
  /**
   * The minimum (most-negative) delta the left handle may reach: it cannot extend
   * past the nearest preceding same-track clip's right edge (or timeline zero).
   * Mirrors commitTrimGesture so the preview does not show an overlap the commit
   * would clamp away.
   */
  const trimLeftFloor = (id: string, baseStart: number): number => {
    const it = state.items.find((x) => x.id === id);
    if (!it) return -baseStart;
    let floor = -baseStart;
    if (it.kind === 'video' || it.kind === 'audio' || it.kind === 'sequence') {
      const wordDriven = it.kind === 'audio' && hasOperationalTranscript(it);
      const sourceBacktrack = wordDriven
        ? (it.srcInFrame ?? 0)
        : sourceFramesToTimelineFrames(it, it.srcInFrame ?? 0);
      floor = Math.max(floor, -Math.floor(sourceBacktrack));
    }
    return Math.max(
      floor,
      predecessorRightEdge(state, id, it.track, baseStart) - baseStart,
    );
  };
  const applyPointerMove = (clientX: number, clientY: number, publish = true) => {
    const currentMarquee = marqueeRef.current;
    if (currentMarquee) {
      setMarquee({ ...currentMarquee, x1: clientX, y1: clientY }, publish);
      return;
    }
    const currentPick = pickDragRef.current;
    if (currentPick) {
      setPickDrag({ ...currentPick, endFrame: frameFromClientX(clientX) }, publish);
      return;
    }
    const currentPen = penDragRef.current;
    if (currentPen) {
      const it = state.items.find((item) => item.id === currentPen.itemId);
      if (!it) return;
      const frame = Math.max(0, Math.min(
        it.durationInFrames - 1,
        frameFromClientX(clientX) - it.startFrame,
      ));
      const [lo, hi] = getKeyframePropertyDefinition(currentPen.prop).editorRange;
      const frac = Math.max(0, Math.min(
        1,
        1 - (clientY - currentPen.laneTop) / Math.max(1, currentPen.laneHeight),
      ));
      const value = Math.round((lo + frac * (hi - lo)) * 100) / 100;
      setPenDrag({ ...currentPen, frame, value }, publish);
      return;
    }
    const currentDrag = dragRef.current;
    if (!currentDrag) return;
    const rawDelta = Math.round((clientX - currentDrag.startX) / px);
    if (currentDrag.mode === 'slip') {
      setDrag({ ...currentDrag, deltaF: rawDelta, targetTrack: currentDrag.baseTrack, snapAt: null }, publish);
      return;
    }
    const snapped = applySnap(currentDrag.mode, currentDrag.baseStart, currentDrag.baseDur, rawDelta);
    const cap = currentDrag.mode === 'trim-right'
      ? trimRightCap(currentDrag.id, currentDrag.baseDur)
      : Infinity;
    const floor = currentDrag.mode === 'trim-left'
      ? trimLeftFloor(currentDrag.id, currentDrag.baseStart)
      : -Infinity;
    const selectionDelta = currentDrag.mode === 'move'
      ? clampTimelineSelectionDelta(
        state,
        dragSelectionRef.current.itemIds,
        dragSelectionRef.current.captionSelections,
        snapped.deltaF,
      )
      : snapped.deltaF;
    const deltaF = Math.min(Math.max(selectionDelta, floor), cap);
    const snapAt = deltaF === snapped.deltaF ? snapped.snapAt : null;
    const targetTrack = currentDrag.mode === 'move'
      ? trackFromClientY(clientY)
      : currentDrag.baseTrack;
    setDrag({ ...currentDrag, deltaF, targetTrack, snapAt }, publish);
  };
  const flushPointerMove = (publish: boolean) => {
    if (pointerMoveRaf.current) cancelAnimationFrame(pointerMoveRaf.current);
    pointerMoveRaf.current = 0;
    const move = pendingMove.current;
    pendingMove.current = null;
    if (move) applyPointerMove(move.clientX, move.clientY, publish);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!marqueeRef.current && !pickDragRef.current && !penDragRef.current && !dragRef.current) return;
    pendingMove.current = { clientX: e.clientX, clientY: e.clientY };
    if (pointerMoveRaf.current) return;
    pointerMoveRaf.current = requestAnimationFrame(() => flushPointerMove(true));
  };
  const cancelPointerGesture = useCallback(() => {
    if (pointerMoveRaf.current) cancelAnimationFrame(pointerMoveRaf.current);
    pointerMoveRaf.current = 0;
    pendingMove.current = null;
    snapHold.current = null;
    gestureSnapPoints.current = [];
    dragSelectionRef.current = { itemIds: [], captionSelections: [] };
    setDrag(null);
    setPenDrag(null);
    setMarquee(null);
    setPickDrag(null);
  }, [setDrag, setMarquee, setPenDrag, setPickDrag]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (
        !dragRef.current && !penDragRef.current && !marqueeRef.current && !pickDragRef.current
      )) return;
      event.preventDefault();
      event.stopPropagation();
      cancelPointerGesture();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (pointerMoveRaf.current) cancelAnimationFrame(pointerMoveRaf.current);
      pointerMoveRaf.current = 0;
      pendingMove.current = null;
    };
  }, [cancelPointerGesture, dragRef, marqueeRef, penDragRef, pickDragRef]);
  const onPointerUp = (event: React.PointerEvent) => {
    flushPointerMove(false);
    const currentMarquee = marqueeRef.current;
    if (currentMarquee) {
      setMarquee(null);
      const dx = Math.abs(currentMarquee.x1 - currentMarquee.x0);
      const dy = Math.abs(currentMarquee.y1 - currentMarquee.y0);
      if (dx < 4 && dy < 4) {
        return;
      }
      const selection = selectionInMarquee(
        Math.min(currentMarquee.x0, currentMarquee.x1),
        Math.min(currentMarquee.y0, currentMarquee.y1),
        Math.max(currentMarquee.x0, currentMarquee.x1),
        Math.max(currentMarquee.y0, currentMarquee.y1),
      );
      onMarqueeCaptionSelect(selection.captionSelections, {
        additive: currentMarquee.additive,
        preserveWithItems: selection.itemIds.length > 0,
      });
      if (currentMarquee.additive) {
        commands.selectItems([...new Set([...selectedIdsOf(state), ...selection.itemIds])]);
      } else {
        commands.selectItems(selection.itemIds);
      }
      return;
    }
    const currentPick = pickDragRef.current;
    if (currentPick) {
      const ref = resolveTimelinePick(currentPick, Math.max(1, Math.round(4 / px)), state);
      if (ref) emitSelectionRef(ref);
      setPickDrag(null);
      return;
    }
    const currentPen = penDragRef.current;
    if (currentPen) {
      const item = state.items.find((candidate) => candidate.id === currentPen.itemId);
      const original = item?.keyframes?.[currentPen.prop]?.find(
        (keyframe) => keyframe.frame === currentPen.fromFrame,
      );
      if (item && original && (
        original.frame !== currentPen.frame || original.value !== currentPen.value
      )) {
        const moved = upsertKeyframe(
          (item.keyframes?.[currentPen.prop] ?? []).filter(
            (keyframe) => keyframe.frame !== currentPen.fromFrame,
          ),
          currentPen.frame,
          currentPen.value,
          currentPen.easing,
        );
        commands.applyState({
          ...state,
          items: state.items.map((candidate) => candidate.id === item.id
            ? { ...candidate, keyframes: { ...candidate.keyframes, [currentPen.prop]: moved } }
            : candidate),
        });
      }
      setPenDrag(null);
      return;
    }
    const currentDrag = dragRef.current;
    if (!currentDrag) return;
    if (currentDrag.mode === 'move') {
      if (onDropSelectionToChat && isOverChatComposer?.(event.clientX, event.clientY)) {
        onDropSelectionToChat(dragSelectionRef.current);
        snapHold.current = null;
        gestureSnapPoints.current = [];
        dragSelectionRef.current = { itemIds: [], captionSelections: [] };
        setDrag(null);
        return;
      }
      const validTrack = !!currentDrag.targetTrack
        && trackKind(state, currentDrag.targetTrack) === trackKind(state, currentDrag.baseTrack)
        && !state.tracks?.[currentDrag.targetTrack]?.locked;
      const track = validTrack ? currentDrag.targetTrack : currentDrag.baseTrack;
      const next = moveTimelineSelectionByDelta(
        state,
        dragSelectionRef.current.itemIds,
        dragSelectionRef.current.captionSelections,
        currentDrag.deltaF,
        track !== currentDrag.baseTrack ? { from: currentDrag.baseTrack, to: track } : null,
      );
      if (next !== state) commands.applyState(next);
    } else {
      commitTimelineDragGesture(state, commands, currentDrag, editMode);
    }
    snapHold.current = null;
    gestureSnapPoints.current = [];
    dragSelectionRef.current = { itemIds: [], captionSelections: [] };
    setDrag(null);
  };
  const onPointerCancel = () => cancelPointerGesture();

  return {
    drag,
    dragSelection: dragSelectionRef.current,
    penDrag,
    setPenDrag,
    marquee,
    pickDrag,
    startDrag,
    startPick,
    startMarquee,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}
