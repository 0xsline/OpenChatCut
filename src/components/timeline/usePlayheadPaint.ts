// Playhead drawing machine (imported verbatim from Timeline.tsx): frameupdate → rAF frame straight drawing playhead line
// (GPU transform) timecode text with ~12fps throttling; Player instance watchdog (preview hang and resubmit listening,
// The root cause of needle freezing has been fixed); the playback head resumes playback at breakpoints (throttle persistence + one-time recovery after project attachment).
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { loadPlayhead, savePlayhead } from '../../persist/sessionPrefs';
import { HEADER_W, fmt, fmtClock } from './timelineUtil';

interface PlayheadDeps {
  playerRef: RefObject<PlayerRef | null>;
  projectId?: string;
  fps: number;
  total: number;
  px: number;
}

export function usePlayheadPaint({ playerRef, projectId, fps, total, px }: PlayheadDeps) {
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const totalRef = useRef(total);
  totalRef.current = total;
  // Restore saved playhead once per project attach (after Player is live).
  const restoredForRef = useRef<string | null>(null);
  const pxRef = useRef(px);
  pxRef.current = px;
  const playheadRef = useRef(0);
  const playheadLineRef = useRef<HTMLDivElement | null>(null);
  const toolbarTimecodeRef = useRef<HTMLSpanElement | null>(null);
  const rulerTimecodeRef = useRef<HTMLSpanElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // coalesce frameupdate → one paint per animation frame (smoother playhead)
  const pendingFrameRef = useRef<number | null>(null);
  const paintRafRef = useRef(0);
  const lastTcPaintRef = useRef(0);
  const paintPlayhead = (frame: number, forceTc = false) => {
    const current = Math.max(0, frame);
    playheadRef.current = current;
    const x = HEADER_W + current * pxRef.current;
    if (playheadLineRef.current) {
      playheadLineRef.current.style.transform = `translate3d(${x}px,0,0)`;
    }
    // timecode text is expensive; refresh ~12fps while playing
    const now = performance.now();
    if (forceTc || now - lastTcPaintRef.current > 80) {
      lastTcPaintRef.current = now;
      const f = Math.round(current);
      if (toolbarTimecodeRef.current) toolbarTimecodeRef.current.textContent = `${fmt(f, fps)} / ${fmt(total, fps)}`;
      if (rulerTimecodeRef.current) rulerTimecodeRef.current.textContent = fmtClock(f, fps);
    }
  };
  const paintPlayheadRef = useRef(paintPlayhead);
  paintPlayheadRef.current = paintPlayhead;
  useEffect(() => {
    let raf = 0;
    let detach: (() => void) | null = null;
    let attached: unknown = null; // Which Player instance the listener is currently hung on
    const attachTo = (player: NonNullable<typeof playerRef.current>) => {
      const flush = () => {
        paintRafRef.current = 0;
        if (pendingFrameRef.current != null) {
          paintPlayheadRef.current(pendingFrameRef.current);
          pendingFrameRef.current = null;
        }
      };
      const persistHead = (frame: number) => {
        const pid = projectIdRef.current;
        if (pid) savePlayhead(pid, frame);
      };
      // Hard refresh does not run React uninstall and clean, detach flush is unreliable - play/drag frameupdate
      // The stream is throttled and saved once (~800ms), and it can be resumed after refresh wherever it is paused/draged.
      let lastHeadSave = 0;
      const onFrame = (event: { detail: { frame: number } }) => {
        pendingFrameRef.current = event.detail.frame;
        if (!paintRafRef.current) paintRafRef.current = requestAnimationFrame(flush);
        const now = performance.now();
        if (event.detail.frame > 0 && now - lastHeadSave > 800) {
          lastHeadSave = now;
          persistHead(event.detail.frame);
        }
      };
      const onPlay = () => setPlaying(true);
      const onPause = () => {
        setPlaying(false);
        const f = player.getCurrentFrame();
        paintPlayheadRef.current(f, true);
        persistHead(f);
      };
      const onEnded = () => {
        setPlaying(false);
        persistHead(player.getCurrentFrame());
      };
      player.addEventListener('frameupdate', onFrame);
      player.addEventListener('play', onPlay);
      player.addEventListener('pause', onPause);
      player.addEventListener('ended', onEnded);
      try { setPlaying(!!player.isPlaying?.()); } catch { /* ignore */ }
      // One-shot restore after Player mounts for this project.
      const pid = projectIdRef.current;
      if (pid && restoredForRef.current !== pid) {
        restoredForRef.current = pid;
        const saved = loadPlayhead(pid);
        const max = Math.max(0, totalRef.current - 1);
        const frame = saved > 0 ? Math.min(saved, max) : player.getCurrentFrame();
        if (saved > 0) {
          try { player.seekTo(frame); } catch { /* ignore */ }
        }
        paintPlayheadRef.current(frame, true);
      } else {
        paintPlayheadRef.current(player.getCurrentFrame(), true);
      }
      return () => {
        // Flush last head before detaching (refresh / project switch). Destroyed
        // The player will read 0 - writing 0 is equivalent to deleting the key, which will erase the header bit saved during pause and only write when >0.
        try { const f = player.getCurrentFrame(); if (f > 0) persistHead(f); } catch { /* ignore */ }
        player.removeEventListener('frameupdate', onFrame);
        player.removeEventListener('play', onPlay);
        player.removeEventListener('pause', onPause);
        player.removeEventListener('ended', onEnded);
        // Must be cleared: If there is paint rAF in transit when the instance is switched, only cancel will not clear it.
        // onFrame always thinks "already scheduled" and no longer schedules → New instance movement/timecode is permanently frozen
        // (Pause's force direct drawing is not affected, so the symptoms = playback freeze and pause can be synchronized once).
        if (paintRafRef.current) { cancelAnimationFrame(paintRafRef.current); paintRafRef.current = 0; }
      };
    };
    // Instance watchdog: Player will rehang with preview (empty timeline → placeholder → more content = new instance),
    // A one-time attach will leave the monitoring on the dead instance → the hand movement/timecode/playback state will not move during playback.
    // Compare the instance identity every frame and reset it if it changes (the root cause of playhead repair).
    const tick = () => {
      const player = playerRef.current;
      if (player !== attached) {
        detach?.();
        attached = player;
        detach = player ? attachTo(player) : null;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); detach?.(); };
  }, [playerRef]);
  useEffect(() => { paintPlayheadRef.current(playheadRef.current, true); }, [px, fps, total]);

  return { playheadRef, playheadLineRef, toolbarTimecodeRef, rulerTimecodeRef, paintPlayhead, playing };
}
