import { useEffect, useState } from 'react';
import type { EditorCommands } from '../../editor/store';
import { captionsOnTrack, trackKind, type TimelineState, type TrackId } from '../../editor/types';
import type { CaptionCueMove } from '../../captions/CaptionTrackLane';
import {
  appendManualCueToFirstLane,
  isManualCaptionEntry,
  newManualCaptions,
  placeManualCueTiming,
  promoteCaptionEntries,
  removeManualCue,
  updateManualCue,
} from '../../captions/manualCaptions';
import { t as translate } from '../../i18n/locale';

interface TrackMenuLocation {
  trackId: TrackId;
  x: number;
  y: number;
  frame: number;
}

interface UseTimelineTrackMenusOptions {
  state: TimelineState;
  commands: EditorCommands;
  t: typeof translate;
}

export function useTimelineTrackMenus({ state, commands, t }: UseTimelineTrackMenusOptions) {
  const [captionMenu, setCaptionMenu] = useState<{ id: TrackId; left: number; top: number; translate?: boolean } | null>(null);
  const [trackMenu, setTrackMenu] = useState<TrackMenuLocation | null>(null);
  const [trackMenuReturn, setTrackMenuReturn] = useState<TrackMenuLocation | null>(null);
  const [captionError, setCaptionError] = useState<string | null>(null);

  const moveCaptionCue = (sourceTrackId: TrackId, move: CaptionCueMove) => {
    const source = captionsOnTrack(state, sourceTrackId);
    if (!source) return;
    const targetTrackId = trackKind(state, move.targetTrackId) === 'caption'
      && !state.tracks?.[move.targetTrackId]?.locked ? move.targetTrackId : sourceTrackId;
    const sourceLane = source.sourceEntries?.find((entry) => entry.id === move.laneId);
    const sourceCue = sourceLane?.words?.[move.index];
    if (targetTrackId === sourceTrackId) {
      const others = (sourceLane?.words ?? []).filter((_, index) => index !== move.index);
      const placed = placeManualCueTiming(others, move.startMs, move.endMs - move.startMs);
      if (!placed || (sourceCue?.start === placed.start && sourceCue.end === placed.end)) return;
      const patch = updateManualCue(
        source,
        move.laneId,
        move.index,
        move.text,
        placed.start,
        placed.end,
      );
      if (patch) commands.updateCaptions(patch, sourceTrackId);
      return;
    }
    const target = captionsOnTrack(state, targetTrackId) ?? newManualCaptions();
    const targetWords = promoteCaptionEntries(target, state.items).find(isManualCaptionEntry)?.words ?? [];
    const placed = placeManualCueTiming(targetWords, move.startMs, move.endMs - move.startMs);
    if (!placed) return;
    const targetPatch = appendManualCueToFirstLane(target, state.items, move.text, placed.start, placed.end);
    if (!targetPatch) return;
    commands.batch([
      { type: 'updateCaptions', patch: removeManualCue(source, move.laneId, move.index), track: sourceTrackId },
      { type: 'setCaptions', captions: { ...target, ...targetPatch }, track: targetTrackId },
    ], t('移动字幕'));
  };

  useEffect(() => {
    if (!captionMenu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target;
      if (!target.closest('.cc-caption-style-menu') && !target.closest('[data-caption-menu-trigger]')) {
        setCaptionMenu(null);
        setTrackMenuReturn(null);
      }
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [captionMenu]);
  const [duckMenu, setDuckMenu] = useState<{ id: TrackId; left: number; top: number } | null>(null);

  useEffect(() => {
    if (!duckMenu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target;
      if (!target.closest('.cc-duck-menu') && !target.closest('[data-duck-menu-trigger]')) {
        setDuckMenu(null);
        setTrackMenuReturn(null);
      }
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [duckMenu]);

  const openCaptionTrackMenu = (
    trackId: TrackId,
    rect: DOMRect,
    translate = false,
    returnMenu: TrackMenuLocation | null = null,
    replace = false,
  ) => {
    setCaptionError(null);
    setDuckMenu(null);
    setTrackMenuReturn(returnMenu);
    setCaptionMenu({
      id: trackId,
      left: replace
        ? Math.max(8, Math.min(rect.left, window.innerWidth - 212 - 8))
        : Math.min(rect.right + 5, window.innerWidth - 350),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - 430)),
      translate,
    });
  };

  const openDuckTrackMenu = (
    trackId: TrackId,
    rect: DOMRect,
    returnMenu: TrackMenuLocation | null = null,
    replace = false,
  ) => {
    setCaptionMenu(null);
    setTrackMenuReturn(returnMenu);
    setDuckMenu({
      id: trackId,
      left: replace
        ? Math.max(8, Math.min(rect.left, window.innerWidth - 160 - 8))
        : Math.min(rect.right + 5, window.innerWidth - 226),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - 310)),
    });
  };

  const closeTrackDrillMenu = () => {
    setCaptionMenu(null);
    setDuckMenu(null);
    setTrackMenuReturn(null);
  };

  const backFromTrackDrillMenu = () => {
    setCaptionMenu(null);
    setDuckMenu(null);
    if (trackMenuReturn) setTrackMenu(trackMenuReturn);
    setTrackMenuReturn(null);
  };

  return {
    captionMenu,
    setCaptionMenu,
    trackMenu,
    setTrackMenu,
    captionError,
    setCaptionError,
    duckMenu,
    setDuckMenu,
    moveCaptionCue,
    openCaptionTrackMenu,
    openDuckTrackMenu,
    closeTrackDrillMenu,
    backFromTrackDrillMenu,
  };
}
