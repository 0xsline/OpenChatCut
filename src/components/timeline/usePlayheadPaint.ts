// 播放头绘制机(逐字搬自 Timeline.tsx):frameupdate → rAF 合帧直绘播放头线
// (GPU transform)与 ~12fps 节流的时码文本;Player 实例看门狗(预览重挂即重订监听,
// 走针冻结的根因修复);播放头断点续播(节流持久化 + 项目附着后一次性恢复)。
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
    let attached: unknown = null; // 当前监听器挂在哪个 Player 实例上
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
      // 硬刷新不跑 React 卸载清理,detach flush 靠不住——播放/拖动的 frameupdate
      // 流里节流存一次(~800ms),暂停点/拖到哪都能在 refresh 后恢复。
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
        // Flush last head before detaching (refresh / project switch)。已销毁的
        // player 会读到 0——写 0 等于删键,会把暂停时存的头位擦掉,只在 >0 时写。
        try { const f = player.getCurrentFrame(); if (f > 0) persistHead(f); } catch { /* ignore */ }
        player.removeEventListener('frameupdate', onFrame);
        player.removeEventListener('play', onPlay);
        player.removeEventListener('pause', onPause);
        player.removeEventListener('ended', onEnded);
        // 必须清零:若实例切换时恰有 paint rAF 在途,只 cancel 不清零会让
        // onFrame 永远以为"已有排程"而不再排 → 新实例走针/时间码永冻
        // (pause 的 force 直绘不受影响,故症状=播放冻结、暂停能同步一次)。
        if (paintRafRef.current) { cancelAnimationFrame(paintRafRef.current); paintRafRef.current = 0; }
      };
    };
    // 实例看门狗:Player 会随预览重挂(空时间线→占位符→再有内容 = 新实例),
    // 一次性 attach 会把监听留在死实例上 → 播放时走针/时间码/播放态全部不动。
    // 每帧比对实例身份,变了就重订(播放头修复的根因)。
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
