import { trackKind, type TimelineState, type TrackId } from '../../editor/types';
import { groupMoveIds, moveItemsByDelta } from '../../editor/multiSelect';
import { rateStretchItem } from '../../editor/rateStretch';
import { sourceFramesToTimelineFrames, sourceWindowForTimelineRange } from '../../editor/sourceLimit';
import type { EditorCommands } from '../../editor/store';
import { hasOperationalTranscript } from '../../transcript/types';
import type { Drag, EditMode } from './timelineUtil';

/**
 * The right edge of the nearest same-track clip that ends at or before `baseStart`.
 * Used to clamp a left-extend trim so the dragged edge never overlaps its predecessor
 * (which would be rolled back by the overlap guard and "bounce" on release).
 */
export function predecessorRightEdge(state: TimelineState, id: string, track: TrackId | undefined, baseStart: number): number {
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
