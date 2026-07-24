import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { captionPages } from './exportCaptions';
import type { TimelineState } from '../editor/types';
import type { CaptionPage, CaptionsData } from './types';
import type { TranscriptWord } from '../transcript/types';
import { theme, themeAlpha } from '../theme';
import { useT } from '../i18n/locale';
import {
  isManualCaptionEntry,
  resizeManualCue,
  resizedManualCueTiming,
  type ManualCueEdge,
} from './manualCaptions';

function cueText(words: Array<{ text: string }>): string {
  return words.map((word) => word.text.trim()).filter(Boolean).join(' ');
}

interface ManualCueTarget {
  laneId: string;
  index: number;
  words: readonly TranscriptWord[];
}

interface TrimDrag {
  key: string;
  target: ManualCueTarget;
  edge: ManualCueEdge;
  startX: number;
  deltaMs: number;
}

interface TrimApi {
  drag: TrimDrag | null;
  start: (event: ReactPointerEvent, key: string, target: ManualCueTarget, edge: ManualCueEdge) => void;
  move: (event: ReactPointerEvent, key: string) => void;
  finish: (event: ReactPointerEvent, key: string) => void;
  cancel: () => void;
  nudge: (target: ManualCueTarget, edge: ManualCueEdge, frames: number) => void;
}

function manualCueTargets(captions: CaptionsData | null): Map<TranscriptWord, ManualCueTarget> {
  const targets = new Map<TranscriptWord, ManualCueTarget>();
  captions?.sourceEntries?.forEach((entry) => {
    if (!isManualCaptionEntry(entry)) return;
    const words = entry.words ?? [];
    words.forEach((word, index) => targets.set(word, { laneId: entry.id, index, words }));
  });
  return targets;
}

function useCaptionTrim(captions: CaptionsData | null, px: number, fps: number, locked: boolean, onUpdate: (patch: Partial<CaptionsData>) => void): TrimApi {
  const [drag, setDrag] = useState<TrimDrag | null>(null);
  const deltaMs = (startX: number, clientX: number) => Math.round((clientX - startX) / px) * 1000 / fps;
  const start: TrimApi['start'] = (event, key, target, edge) => {
    if (locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ key, target, edge, startX: event.clientX, deltaMs: 0 });
  };
  const move: TrimApi['move'] = (event, key) => {
    if (!drag || drag.key !== key) return;
    const next = deltaMs(drag.startX, event.clientX);
    setDrag((current) => current?.key === key ? { ...current, deltaMs: next } : current);
  };
  const finish: TrimApi['finish'] = (event, key) => {
    if (!drag || drag.key !== key || !captions) return;
    const finalDelta = deltaMs(drag.startX, event.clientX);
    const patch = finalDelta ? resizeManualCue(captions, drag.target.laneId, drag.target.index, drag.edge, finalDelta) : null;
    setDrag(null);
    if (patch) onUpdate(patch);
  };
  const nudge: TrimApi['nudge'] = (target, edge, frames) => {
    if (!captions || locked) return;
    const patch = resizeManualCue(captions, target.laneId, target.index, edge, frames * 1000 / fps);
    if (patch) onUpdate(patch);
  };
  return { drag, start, move, finish, cancel: () => setDrag(null), nudge };
}

function CaptionCueBlock({ page, index, target, locked, px, fps, trim }: {
  page: CaptionPage; index: number; target?: ManualCueTarget; locked: boolean; px: number; fps: number; trim: TrimApi;
}) {
  const t = useT();
  const key = target ? `${target.laneId}:${target.index}` : `${page.start}:${index}`;
  const timing = target && trim.drag?.key === key
    ? resizedManualCueTiming(target.words, target.index, trim.drag.edge, trim.drag.deltaMs)
    : null;
  const startMs = timing?.start ?? page.start;
  const endMs = timing?.end ?? page.end;
  const startFrame = Math.max(0, Math.round(startMs * fps / 1000));
  const durationFrames = Math.max(2, Math.round((endMs - startMs) * fps / 1000));
  const text = cueText(page.words);
  const handle = (edge: ManualCueEdge) => target && !locked ? <div
    className={`cc-caption-track-trim ${edge === 'start' ? 'left' : 'right'}`}
    role="separator" aria-orientation="vertical" tabIndex={0}
    aria-label={t(edge === 'start' ? 'Drag to adjust subtitle start time' : 'Drag to adjust subtitle end time')}
    aria-valuenow={Math.round(edge === 'start' ? startMs : endMs)}
    title={t(edge === 'start' ? 'Drag to adjust subtitle start time' : 'Drag to adjust subtitle end time')}
    onPointerDown={(event) => trim.start(event, key, target, edge)}
    onPointerMove={(event) => trim.move(event, key)}
    onPointerUp={(event) => trim.finish(event, key)}
    onPointerCancel={trim.cancel}
    onKeyDown={(event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      trim.nudge(target, edge, event.key === 'ArrowLeft' ? -1 : 1);
    }}
  /> : null;
  return (
    <div className="cc-caption-track-cue" title={text} style={{ left: startFrame * px, width: Math.max(18, durationFrames * px) }}>
      {handle('start')}<span>{text}</span>{handle('end')}
    </div>
  );
}

export function CaptionTrackLane({ state, captions, px, hidden, locked, onUpdate }: {
  state: TimelineState;
  captions: CaptionsData | null;
  px: number;
  hidden: boolean;
  locked: boolean;
  onUpdate: (patch: Partial<CaptionsData>) => void;
}) {
  const t = useT();
  const pages = captions ? captionPages(captions, state.items, state.fps) : [];
  const targets = manualCueTargets(captions);
  const trim = useCaptionTrim(captions, px, state.fps, locked, onUpdate);
  return (
    <div className="cc-caption-track-lane" style={{
      background: locked ? `color-mix(in srgb, ${theme.bg} 70%, ${themeAlpha.shadow(1)})` : theme.bg,
      opacity: hidden ? 0.4 : locked ? 0.75 : 1,
    }}>
      {!pages.length && <span className="cc-caption-track-empty">{t('Subtitle track is empty')}</span>}
      {pages.map((page, index) => <CaptionCueBlock key={`${page.start}:${index}`} page={page} index={index}
        target={page.words.length === 1 ? targets.get(page.words[0]!) : undefined}
        locked={locked} px={px} fps={state.fps} trim={trim} />)}
    </div>
  );
}
