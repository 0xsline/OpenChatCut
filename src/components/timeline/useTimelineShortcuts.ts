// 时间线快捷键 API 装配(源 shortcut-dispatcher):全局分发器在 Editor,Timeline 每次
// 渲染用最新闭包重建 TimelineShortcutApi 塞进 shortcutApiRef(effect 无依赖数组=永远
// 新鲜,与原 Timeline 内联写法逐字等价)。I/O 区间(zoneIn/Out)、JKL 穿梭机器、片段
// 剪贴板整个归本 hook 所有;fxClip 剪贴板与右键菜单共用,留在 Timeline 传入。
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import {
  selectedIdsOf, timelineTrackIds, trackKind,
  type TimelineItem, type TimelineState,
} from '../../editor/types';
import { removeItemsFromState } from '../../editor/multiSelect';
import type { EditorCommands } from '../../editor/store';
import type { AtomicAction } from '../../editor/store';
import type { FxClip } from './ClipContextMenu';
import type { TimelineShortcutApi, ItemClipboard } from '../../shortcuts/timelineApi';

interface ShortcutDeps {
  shortcutApiRef: RefObject<TimelineShortcutApi | null> | undefined;
  state: TimelineState;
  commands: EditorCommands;
  playerRef: RefObject<PlayerRef | null>;
  playheadRef: RefObject<number>;
  total: number;
  seekFrame: (frame: number) => void;
  paintPlayhead: (frame: number, forceTc?: boolean) => void;
  setEditMode: (m: 'selection' | 'blade' | 'trim' | 'pen') => void;
  setSnapping: (updater: (s: boolean) => boolean) => void;
  fitToView: () => void;
  zoomBy: (factor: number) => void;
  bladeSelected: () => void;
  setEditMarker: (id: string | null) => void;
  fxClip: FxClip | null;
  setFxClip: (fx: FxClip | null) => void;
}

export function useTimelineShortcuts(deps: ShortcutDeps): { zoneIn: number | null; zoneOut: number | null } {
  const {
    shortcutApiRef, state, commands, playerRef, playheadRef, total,
    seekFrame, paintPlayhead, setEditMode, setSnapping, fitToView, zoomBy,
    bladeSelected, setEditMarker, fxClip, setFxClip,
  } = deps;

  // ── I/O marks + shuttle + clipboard ─────────────────────────────────────
  const [zoneIn, setZoneIn] = useState<number | null>(null);
  const [zoneOut, setZoneOut] = useState<number | null>(null);
  const itemClipRef = useRef<ItemClipboard>(null);
  const shuttleRateRef = useRef(0); // -4..+4 steps
  const shuttleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopShuttle = () => {
    shuttleRateRef.current = 0;
    if (shuttleTimerRef.current) {
      clearInterval(shuttleTimerRef.current);
      shuttleTimerRef.current = null;
    }
  };
  const runShuttle = () => {
    if (shuttleTimerRef.current) clearInterval(shuttleTimerRef.current);
    const rate = shuttleRateRef.current;
    if (rate === 0) {
      playerRef.current?.pause();
      return;
    }
    playerRef.current?.pause();
    // step frames proportional to |rate| (~15fps * rate)
    const step = Math.sign(rate) * Math.max(1, Math.abs(rate));
    const ms = Math.max(16, 80 / Math.max(1, Math.abs(rate)));
    shuttleTimerRef.current = setInterval(() => {
      const cur = playheadRef.current;
      const next = Math.max(0, Math.min(total - 1, cur + step * 2));
      playerRef.current?.seekTo(next);
      paintPlayhead(next, true);
      if (next <= 0 || next >= total - 1) stopShuttle();
    }, ms);
  };

  const gotoMarker = (dir: 1 | -1) => {
    const sorted = [...(state.markers ?? [])].filter((m) => m.scope === 'project').sort((a, b) => a.fromFrame - b.fromFrame);
    const next = dir === 1 ? sorted.find((m) => m.fromFrame > playheadRef.current) : [...sorted].reverse().find((m) => m.fromFrame < playheadRef.current);
    if (next) seekFrame(next.fromFrame);
  };

  // Expose shortcut API to Editor (single global dispatcher lives there)
  useEffect(() => {
    if (!shortcutApiRef) return;
    const api: TimelineShortcutApi = {
      getPlayhead: () => playheadRef.current,
      seekTo: (frame) => seekFrame(frame),
      playPause: () => {
        stopShuttle();
        playerRef.current?.toggle();
      },
      isPlaying: () => {
        try { return !!playerRef.current?.isPlaying?.(); } catch { return false; }
      },
      setEditMode: (m) => setEditMode(m),
      toggleSnap: () => setSnapping((s) => !s),
      fitToView: () => fitToView(),
      zoomBy: (f) => zoomBy(f),
      splitAtPlayhead: () => bladeSelected(),
      nudgeSelected: (delta) => {
        const ids = selectedIdsOf(state);
        const actions: AtomicAction[] = [];
        for (const id of ids) {
          const it = state.items.find((x) => x.id === id);
          if (!it || state.tracks?.[it.track]?.locked) continue;
          actions.push({ type: 'move' as const, id, startFrame: Math.max(0, it.startFrame + delta) });
        }
        commands.batch(actions, '微移所选片段');
      },
      trimSelectedToPlayhead: (side) => {
        const id = state.selectedId;
        if (!id) return;
        const it = state.items.find((x) => x.id === id);
        if (!it) return;
        const ph = playheadRef.current;
        if (side === 'start') {
          if (ph <= it.startFrame || ph >= it.startFrame + it.durationInFrames) return;
          const delta = ph - it.startFrame;
          const timing: { startFrame: number; durationInFrames: number; srcInFrame?: number } = {
            startFrame: ph,
            durationInFrames: it.durationInFrames - delta,
          };
          // Advance source in-point so the visible media stays aligned (split semantics).
          if (it.kind === 'video' || it.kind === 'audio') {
            timing.srcInFrame = (it.srcInFrame ?? 0) + delta;
          }
          commands.setItemTiming(id, timing);
        } else {
          if (ph <= it.startFrame || ph >= it.startFrame + it.durationInFrames) return;
          commands.setItemTiming(id, { durationInFrames: Math.max(1, ph - it.startFrame) });
        }
      },
      selectAfterPlayhead: () => {
        const ph = playheadRef.current;
        const next = [...state.items]
          .filter((it) => it.startFrame >= ph)
          .sort((a, b) => a.startFrame - b.startFrame)[0]
          ?? [...state.items].filter((it) => it.startFrame + it.durationInFrames > ph).sort((a, b) => a.startFrame - b.startFrame)[0];
        if (next) commands.selectItem(next.id);
      },
      selectUnderPlayhead: () => {
        const ph = playheadRef.current;
        const hit = state.items.find((it) => ph >= it.startFrame && ph < it.startFrame + it.durationInFrames);
        commands.selectItem(hit?.id ?? state.items[0]?.id ?? null);
      },
      gotoEdit: (dir) => {
        const ph = playheadRef.current;
        const cuts = new Set<number>([0, total]);
        for (const it of state.items) {
          cuts.add(it.startFrame);
          cuts.add(it.startFrame + it.durationInFrames);
        }
        const sorted = [...cuts].sort((a, b) => a - b);
        if (dir === 1) {
          const n = sorted.find((f) => f > ph + 0.5);
          if (n != null) seekFrame(n);
        } else {
          const n = [...sorted].reverse().find((f) => f < ph - 0.5);
          if (n != null) seekFrame(n);
        }
      },
      gotoMarker: (dir) => gotoMarker(dir),
      addMarker: (open) => {
        const id = commands.addMarker(playheadRef.current);
        if (open) setEditMarker(id);
      },
      modifyMarkerAtPlayhead: () => {
        const ph = playheadRef.current;
        const m = (state.markers ?? []).find((x) => x.scope === 'project' && Math.abs(x.fromFrame - ph) <= 1);
        if (m) setEditMarker(m.id);
        else {
          const id = commands.addMarker(ph);
          setEditMarker(id);
        }
      },
      deleteMarkerAtPlayhead: () => {
        const ph = playheadRef.current;
        const m = (state.markers ?? []).find((x) => x.scope === 'project' && Math.abs(x.fromFrame - ph) <= 1);
        if (m) commands.removeMarker(m.id);
      },
      setZoneIn: () => setZoneIn(playheadRef.current),
      setZoneOut: () => setZoneOut(playheadRef.current),
      clearZone: () => { setZoneIn(null); setZoneOut(null); },
      zoneFromClip: () => {
        const ph = playheadRef.current;
        const hit = state.items.find((it) => ph >= it.startFrame && ph < it.startFrame + it.durationInFrames)
          ?? state.items.find((it) => it.id === state.selectedId);
        if (hit) {
          setZoneIn(hit.startFrame);
          setZoneOut(hit.startFrame + hit.durationInFrames);
        }
      },
      zoneFromSelection: () => {
        const it = state.items.find((x) => x.id === state.selectedId);
        if (it) {
          setZoneIn(it.startFrame);
          setZoneOut(it.startFrame + it.durationInFrames);
        }
      },
      getZone: () => ({ inFrame: zoneIn, outFrame: zoneOut }),
      shuttle: (dir) => {
        if (dir === 0) {
          stopShuttle();
          playerRef.current?.pause();
          return;
        }
        // stack rate like JKL
        const cur = shuttleRateRef.current;
        let next = cur;
        if (dir === 1) next = cur <= 0 ? 1 : Math.min(4, cur + 1);
        else next = cur >= 0 ? -1 : Math.max(-4, cur - 1);
        shuttleRateRef.current = next;
        runShuttle();
      },
      shuttleJog: (dir) => {
        stopShuttle();
        seekFrame(playheadRef.current + dir);
      },
      moveSelectedTrack: (dir) => {
        const id = state.selectedId;
        if (!id) return;
        const it = state.items.find((x) => x.id === id);
        if (!it) return;
        const ids = timelineTrackIds(state);
        const idx = ids.indexOf(it.track);
        if (idx < 0) return;
        const ni = idx + dir;
        if (ni < 0 || ni >= ids.length) return;
        const dest = ids[ni]!;
        if (trackKind(state, dest) !== trackKind(state, it.track)) return;
        commands.moveItem(id, { track: dest, startFrame: it.startFrame });
      },
      moveSelectedToBoundary: (side) => {
        const id = state.selectedId;
        if (!id) return;
        const it = state.items.find((x) => x.id === id);
        if (!it) return;
        const same = state.items.filter((x) => x.track === it.track && x.id !== id);
        if (side === 'left') {
          const left = same.filter((x) => x.startFrame + x.durationInFrames <= it.startFrame)
            .sort((a, b) => (b.startFrame + b.durationInFrames) - (a.startFrame + a.durationInFrames))[0];
          const target = left ? left.startFrame + left.durationInFrames : 0;
          commands.moveItem(id, { startFrame: target });
        } else {
          const right = same.filter((x) => x.startFrame >= it.startFrame + it.durationInFrames)
            .sort((a, b) => a.startFrame - b.startFrame)[0];
          const target = right ? right.startFrame - it.durationInFrames : it.startFrame;
          commands.moveItem(id, { startFrame: Math.max(0, target) });
        }
      },
      copySelected: () => {
        const ids = selectedIdsOf(state);
        const items = ids.map((id) => state.items.find((x) => x.id === id)).filter(Boolean) as TimelineItem[];
        if (!items.length) return;
        // store primary (last) for single paste; multi-paste pastes all relative to earliest
        const snap = (it: TimelineItem): TimelineItem => ({
          ...it,
          props: it.props ? { ...it.props } : it.props,
          effects: it.effects?.map((e) => ({ ...e, overrides: e.overrides ? { ...e.overrides } : undefined })),
        });
        itemClipRef.current = {
          kind: 'item',
          item: snap(items[items.length - 1]!),
          multi: items.length > 1 ? items.map(snap) : undefined,
        };
      },
      cutSelected: () => {
        const ids = selectedIdsOf(state);
        const items = ids.map((id) => state.items.find((x) => x.id === id)).filter(Boolean) as TimelineItem[];
        if (!items.length) return;
        const snap = (it: TimelineItem): TimelineItem => ({
          ...it,
          props: it.props ? { ...it.props } : it.props,
          effects: it.effects?.map((e) => ({ ...e, overrides: e.overrides ? { ...e.overrides } : undefined })),
        });
        itemClipRef.current = {
          kind: 'item',
          item: snap(items[items.length - 1]!),
          multi: items.length > 1 ? items.map(snap) : undefined,
        };
        // remove all in one history step
        const idSet = new Set(ids);
        commands.applyState({
          ...state,
          items: state.items.filter((it) => !idSet.has(it.id)),
          transitions: (state.transitions ?? []).filter((t) => !idSet.has(t.incomingItemId) && !idSet.has(t.outgoingItemId)),
          selectedId: null,
          selectedIds: [],
        });
      },
      pasteClipboard: () => {
        const clip = itemClipRef.current;
        if (!clip || clip.kind !== 'item') return;
        const batch = clip.multi?.length ? clip.multi : [clip.item];
        const baseStart = Math.min(...batch.map((it) => it.startFrame));
        const ph = Math.max(0, playheadRef.current);
        const newItems: TimelineItem[] = batch.map((src) => {
          const newId = `item_${crypto.randomUUID()}`;
          return {
            ...src,
            id: newId,
            startFrame: ph + (src.startFrame - baseStart),
            props: src.props ? { ...src.props } : src.props,
            effects: src.effects?.map((e) => ({ ...e, overrides: e.overrides ? { ...e.overrides } : undefined })),
          };
        });
        const newIds = newItems.map((it) => it.id);
        commands.applyState({
          ...state,
          items: [...state.items, ...newItems],
          selectedIds: newIds,
          selectedId: newIds[newIds.length - 1] ?? null,
        });
      },
      pasteEffects: () => {
        const it = state.items.find((x) => x.id === state.selectedId);
        if (!it || !fxClip || it.kind === 'audio') return;
        const actions: AtomicAction[] = [
          ...(fxClip.filters ? [{ type: 'setFilters' as const, id: it.id, patch: fxClip.filters }] : []),
          ...(fxClip.transform ? [{ type: 'setTransform' as const, id: it.id, patch: fxClip.transform }] : []),
          { type: 'setZoom' as const, id: it.id, patch: fxClip.zoom ?? null },
          {
            type: 'setFade' as const,
            id: it.id,
            fadeInFrames: fxClip.fadeInFrames ?? 0,
            fadeOutFrames: fxClip.fadeOutFrames ?? 0,
          },
        ];
        commands.batch(actions, '粘贴片段效果');
      },
      copyEffects: () => {
        const it = state.items.find((x) => x.id === state.selectedId);
        if (!it || it.kind === 'audio') return;
        setFxClip({
          filters: it.filters,
          transform: it.transform,
          zoom: it.zoom,
          fadeInFrames: it.fadeInFrames,
          fadeOutFrames: it.fadeOutFrames,
        });
      },
      duplicateSelected: () => {
        const ids = selectedIdsOf(state);
        if (!ids.length) return;
        if (ids.length === 1) {
          commands.duplicateItem(ids[0]!);
          return;
        }
        // multi-duplicate in one step at track ends is awkward; duplicate each with new ids after last
        let next = { ...state, items: [...state.items] };
        const newIds: string[] = [];
        for (const id of ids) {
          const it = next.items.find((x) => x.id === id);
          if (!it) continue;
          const newId = `item_${crypto.randomUUID()}`;
          const copy: TimelineItem = {
            ...it,
            id: newId,
            props: it.props ? { ...it.props } : it.props,
            startFrame: Math.max(...next.items.filter((x) => x.track === it.track).map((x) => x.startFrame + x.durationInFrames), 0),
          };
          next = { ...next, items: [...next.items, copy] };
          newIds.push(newId);
        }
        commands.applyState({
          ...next,
          selectedIds: newIds,
          selectedId: newIds[newIds.length - 1] ?? null,
        });
      },
      deleteSelected: (ripple) => {
        const ids = selectedIdsOf(state);
        if (!ids.length) return;
        if (ids.length === 1) {
          if (ripple) commands.rippleDeleteItem(ids[0]!);
          else commands.removeItem(ids[0]!);
          return;
        }
        // multi-delete: one undo step
        commands.applyState(removeItemsFromState(state, ids, ripple));
      },
      fullscreenPreview: () => {
        const player = playerRef.current;
        if (!player) return;
        if (player.isFullscreen()) player.exitFullscreen();
        else player.requestFullscreen();
      },
      getFxClip: () => fxClip,
      setFxClip: (fx) => setFxClip(fx),
    };
    shortcutApiRef.current = api;
    return () => {
      if (shortcutApiRef.current === api) shortcutApiRef.current = null;
      stopShuttle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keep API fresh each render
  });

  return { zoneIn, zoneOut };
}
