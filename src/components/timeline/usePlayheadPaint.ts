// Playhead drawing machine (translated verbatim from Timeline.tsx):frameupdate → rAF frame-drawn playhead line
// (GPU transform) timecode text with ~12fps throttling; Player instance watchdog (preview re-hang and re-subscribe monitoring,
// Repair the root cause of needle freezing); resume playback at breakpoint (throttle persistence + one-time recovery after project attachment).
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CallbackListener, PlayerRef } from '@remotion/player';
import { loadTimelineView, saveTimelineView } from '../../persist/sessionPrefs';
import { HEADER_W, fmt, fmtClock } from './timelineUtil';

export interface AudibleAudioItem {
  /** Timeline start frame of the audio item. */
  startFrame: number;
  /** Item playback rate (timeline frames per source frame). */
  playbackRate: number;
  /** Source in-point in source-media frames (srcInFrame ?? 0). */
  srcInFrame: number;
  /** Media URL of the item, used to pick the matching media element. */
  src: string;
}

interface PlayheadDeps {
  playerRef: RefObject<PlayerRef | null>;
  projectId?: string;
  timelineId?: string;
  fps: number;
  total: number;
  px: number;
  /**
   * Marking mode: returns the audio item audible at the given playhead frame,
   * or null when the playhead should keep following the Player's frame clock.
   * When an item is returned while playing, the playhead (and therefore the
   * markers placed at it) follows the audible media element's own clock — what
   * you actually hear — instead of the wall-clock frame. This eliminates the
   * drift between playhead and audio caused by main-thread stalls (e.g. rapid
   * marker creation), which Remotion only re-syncs beyond ~0.1–0.45s of drift.
   */
  getAudibleItem?: (playheadFrame: number) => AudibleAudioItem | null;
}

/**
 * Map a media element's currentTime (source seconds) to a timeline frame for
 * an audio item. Pure so it can be unit-verified.
 */
export function audioMediaTimeToTimelineFrame(
  mediaSeconds: number,
  item: AudibleAudioItem,
  fps: number,
): number {
  const sourceFrame = mediaSeconds * fps;
  return item.startFrame + (sourceFrame - item.srcInFrame) / item.playbackRate;
}

// Constant WebAudio output latency shifts what you HEAR vs element.currentTime.
// Measure once (lazily) and subtract, so markers land on the audible beat
// instead of a few frames early. Falls back to 0 when the platform does not
// expose a usable latency (Windows frequently reports 0).
let measuredAudioLatency: number | null = null;
function audioOutputLatencySeconds(): number {
  if (measuredAudioLatency !== null) return measuredAudioLatency;
  try {
    const ctx = new AudioContext();
    const latency = (ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0);
    void ctx.close();
    measuredAudioLatency = Math.min(Math.max(latency, 0), 0.3);
  } catch {
    measuredAudioLatency = 0;
  }
  return measuredAudioLatency;
}

interface MediaMetadataSyncPlayer {
  getContainerNode(): EventTarget | null;
  seekTo(frame: number): void;
}

function attachMediaMetadataSync(
  player: MediaMetadataSyncPlayer | null,
  getDesiredFrame: () => number,
): () => void {
  const target = player?.getContainerNode() ?? null;
  if (!player || !target) return () => undefined;
  const options = { capture: true };
  const onLoadedMetadata = () => player.seekTo(getDesiredFrame());
  target.addEventListener('loadedmetadata', onLoadedMetadata, options);
  return () => target.removeEventListener('loadedmetadata', onLoadedMetadata, options);
}

interface PlayheadMediaSyncPlayer extends MediaMetadataSyncPlayer {
  addEventListener(type: 'frameupdate', listener: CallbackListener<'frameupdate'>): void;
  removeEventListener(type: 'frameupdate', listener: CallbackListener<'frameupdate'>): void;
}

export function attachPlayheadMediaSync(
  player: PlayheadMediaSyncPlayer,
  getDesiredFrame: () => number,
  onFrame: CallbackListener<'frameupdate'>,
): () => void {
  const detachMetadataSync = attachMediaMetadataSync(player, getDesiredFrame);
  player.addEventListener('frameupdate', onFrame);
  return () => {
    detachMetadataSync();
    player.removeEventListener('frameupdate', onFrame);
  };
}

export function usePlayheadPaint({ playerRef, projectId, timelineId, fps, total, px, getAudibleItem }: PlayheadDeps) {
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const timelineIdRef = useRef(timelineId);
  timelineIdRef.current = timelineId;
  const totalRef = useRef(total);
  totalRef.current = total;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const getAudibleItemRef = useRef(getAudibleItem);
  getAudibleItemRef.current = getAudibleItem;
  // Restore once per project + timeline pair. A missing record deliberately seeks
  // to frame 0 instead of inheriting the Player's stale frame from another tab.
  const restoredForRef = useRef<string | null>(null);
  const pxRef = useRef(px);
  pxRef.current = px;
  const playheadRef = useRef(0);
  const playheadLineRef = useRef<HTMLDivElement | null>(null);
  const toolbarTimecodeRef = useRef<HTMLSpanElement | null>(null);
  const rulerTimecodeRef = useRef<HTMLSpanElement | null>(null);
  const timecodePreviewFrameRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  // Marking mode: last playhead frame derived from the audible media element's
  // own clock. Non-null while the audio clock owns the playhead; the Player's
  // frameupdate then only feeds the fallback/resume reference.
  const lastAudioFrameRef = useRef<number | null>(null);
  const lastAudioHeadSaveRef = useRef(0);

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
      const f = Math.round(timecodePreviewFrameRef.current ?? current);
      if (toolbarTimecodeRef.current) toolbarTimecodeRef.current.textContent = `${fmt(f, fps)} / ${fmt(total, fps)}`;
      if (rulerTimecodeRef.current) rulerTimecodeRef.current.textContent = fmtClock(f, fps);
    }
  };
  const setTimecodePreviewFrame = (frame: number | null) => {
    timecodePreviewFrameRef.current = frame;
    const f = Math.round(frame ?? playheadRef.current);
    if (toolbarTimecodeRef.current) toolbarTimecodeRef.current.textContent = `${fmt(f, fps)} / ${fmt(total, fps)}`;
    if (rulerTimecodeRef.current) rulerTimecodeRef.current.textContent = fmtClock(f, fps);
  };
  const paintPlayheadRef = useRef(paintPlayhead);
  paintPlayheadRef.current = paintPlayhead;
  const restorePlayerRef = useRef((_player: NonNullable<typeof playerRef.current>): boolean => false);
  restorePlayerRef.current = (player) => {
    const pid = projectIdRef.current;
    const tid = timelineIdRef.current;
    if (!pid || !tid) return false;
    const key = `${pid}\u0000${tid}`;
    if (restoredForRef.current === key) {
      const frame = Math.min(playheadRef.current, Math.max(0, totalRef.current - 1));
      try { player.seekTo(frame); } catch { /* ignore */ }
      paintPlayheadRef.current(frame, true);
      return true;
    }
    restoredForRef.current = key;
    const saved = loadTimelineView(pid, tid);
    const max = Math.max(0, totalRef.current - 1);
    const frame = Math.min(saved?.playhead ?? 0, max);
    try { player.seekTo(frame); } catch { /* ignore */ }
    paintPlayheadRef.current(frame, true);
    return true;
  };
  useEffect(() => {
    let detach: (() => void) | null = null;
    let attached: unknown = null; // Which Player instance the listener is currently hung on
    const attachTo = (player: NonNullable<typeof playerRef.current>) => {
      // A restored Player frame can precede HTML media metadata. Chrome then keeps
      // the media tag at 0 until another seek; reassert the Player's synchronous
      // current frame once the tag becomes seekable. Capture is required because
      // loadedmetadata does not bubble.
      const flush = () => {
        paintRafRef.current = 0;
        if (pendingFrameRef.current != null) {
          paintPlayheadRef.current(pendingFrameRef.current);
          pendingFrameRef.current = null;
        }
      };
      const persistHead = (frame: number) => {
        const pid = projectIdRef.current;
        const tid = timelineIdRef.current;
        if (pid && tid) saveTimelineView(pid, tid, { playhead: frame });
      };
      // Hard refresh does not run React uninstall and clean, detach flush is unreliable - play/drag frameupdate
      // The stream is throttled and saved once (~800ms), and it can be resumed after refresh wherever it is paused/draged.
      let lastHeadSave = 0;
      const onFrame = (event: { detail: { frame: number } }) => {
        // Marking mode: while the audible media clock owns the playhead, the
        // wall-clock frame must not overwrite it (markers read playheadRef).
        if (lastAudioFrameRef.current !== null) return;
        playheadRef.current = Math.max(0, event.detail.frame);
        pendingFrameRef.current = event.detail.frame;
        if (!paintRafRef.current) paintRafRef.current = requestAnimationFrame(flush);
        const now = performance.now();
        if (event.detail.frame > 0 && now - lastHeadSave > 800) {
          lastHeadSave = now;
          persistHead(event.detail.frame);
        }
      };
      const detachPlayheadSync = attachPlayheadMediaSync(
        player,
        () => playheadRef.current,
        onFrame,
      );
      const onPlay = () => setPlaying(true);
      const onPause = () => {
        setPlaying(false);
        // Prefer the last audio-clock frame when marking mode was active, so
        // pausing does not snap the playhead forward to the wall-clock frame.
        const f = lastAudioFrameRef.current ?? player.getCurrentFrame();
        paintPlayheadRef.current(f, true);
        persistHead(f);
      };
      const onEnded = () => {
        setPlaying(false);
        persistHead(player.getCurrentFrame());
      };
      player.addEventListener('play', onPlay);
      player.addEventListener('pause', onPause);
      player.addEventListener('ended', onEnded);
      try { setPlaying(!!player.isPlaying?.()); } catch { /* ignore */ }
      if (!restorePlayerRef.current(player)) {
        paintPlayheadRef.current(player.getCurrentFrame(), true);
      }
      return () => {
        detachPlayheadSync();
        // Persist the last known frame before this Player instance detaches.
        try { persistHead(player.getCurrentFrame()); } catch { /* ignore */ }
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
    // Check identity at low frequency while paused; frameupdate already drives
    // painting during playback, so a permanent 60fps watchdog only wastes CPU.
    const tick = () => {
      const player = playerRef.current;
      if (player !== attached) {
        detach?.();
        attached = player;
        detach = player ? attachTo(player) : null;
      }
    };
    tick();
    const watchdog = setInterval(tick, 100);
    return () => { clearInterval(watchdog); detach?.(); };
  }, [playerRef]);
  // Marking mode audio lock: while playing and an audible audio item exists,
  // drive the playhead from the media element's own clock (what is actually
  // heard) so marker placement stays locked to the sound even when the main
  // thread stalls. The Remotion Player advances frames by wall-clock time;
  // audio advances on its own hardware clock, and Remotion only re-syncs them
  // beyond ~0.1–0.45s of drift — which is exactly the audible "playhead runs
  // ahead of the beat" symptom during high-frequency marking.
  useEffect(() => {
    if (!playing || !getAudibleItem) return undefined;
    lastAudioFrameRef.current = null;
    let raf = 0;
    const latency = audioOutputLatencySeconds();
    const findAudibleMediaElement = (item: AudibleAudioItem | null): HTMLMediaElement | null => {
      const player = playerRef.current;
      const container = (player as unknown as { getContainerNode?: () => EventTarget | null })?.getContainerNode?.();
      if (!container || !(container instanceof HTMLElement)) return null;
      const media = Array.from(container.querySelectorAll<HTMLMediaElement>('audio,video'));
      if (!media.length) return null;
      // Prefer the element matching the audible item's src; fall back to the
      // first element that is actually playing.
      if (item) {
        const match = media.find((el) => (el.currentSrc || el.src).includes(item.src));
        if (match) return match;
      }
      return media.find((el) => !el.paused && el.readyState >= 2) ?? null;
    };
    const loop = () => {
      const item = getAudibleItemRef.current?.(playheadRef.current) ?? null;
      const el = findAudibleMediaElement(item);
      if (el && item && el.currentTime > 0 && !el.paused) {
        const mediaSec = Math.max(0, el.currentTime - latency);
        const raw = audioMediaTimeToTimelineFrame(mediaSec, item, fpsRef.current);
        const clamped = Math.max(0, Math.min(Math.max(0, totalRef.current - 1), Math.round(raw)));
        lastAudioFrameRef.current = clamped;
        paintPlayheadRef.current(clamped);
        const now = performance.now();
        if (clamped > 0 && now - lastAudioHeadSaveRef.current > 800) {
          lastAudioHeadSaveRef.current = now;
          // persistHead is scoped to attachTo; keep resume position roughly in
          // sync by persisting through the same channel used by frameupdate.
          const pid = projectIdRef.current;
          const tid = timelineIdRef.current;
          if (pid && tid) saveTimelineView(pid, tid, { playhead: clamped });
        }
      } else {
        // Audio clock not available (gap, ended, buffering): hand the playhead
        // back to the wall-clock frameupdate path.
        lastAudioFrameRef.current = null;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, getAudibleItem, playerRef]);
  useEffect(() => {
    const player = playerRef.current;
    if (player) restorePlayerRef.current(player);
    return () => {
      if (projectId && timelineId) {
        saveTimelineView(projectId, timelineId, { playhead: playheadRef.current });
      }
    };
  }, [playerRef, projectId, timelineId]);
  useEffect(() => { paintPlayheadRef.current(playheadRef.current, true); }, [px, fps, total]);

  return {
    playheadRef,
    playheadLineRef,
    toolbarTimecodeRef,
    rulerTimecodeRef,
    paintPlayhead,
    setTimecodePreviewFrame,
    playing,
  };
}
