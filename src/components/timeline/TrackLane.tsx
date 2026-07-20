// 轨道片段带(逐字搬自 Timeline.tsx):一条轨道的可编辑区——片段盒(拖动/裁剪/
// 刀片/钢笔/引用拾取按 editMode 分派)、音频波形、效果角标、钢笔透明度关键帧
// 叠层、库素材拖放(fx/lut/zoom/transition 落片段,sound/template 落轨道)、转场缝标。
// 指针机(drag/penDrag 等)由 useTimelinePointer 供给,经 pointer prop 整只传入。
import { type Dispatch, type RefObject, type SetStateAction } from 'react';
import { theme } from '../../theme';
import { Icon } from '../icons';
import {
  TRANSITION_LABELS, isItemSelected,
  type TimelineItem, type TimelineState, type TrackId, type TransitionItem, type TransitionType,
} from '../../editor/types';
import { upsertKeyframe } from '../../editor/keyframes';
import type { EditorCommands } from '../../editor/store';
import { hasLibraryDrag, parseLibraryDrag, type LibraryDragPayload } from '../../library/drag';
import { ALL_FX, FX_EFFECTS, LUT_EFFECTS } from '../../gl/fx/effects';
import { ZOOM_SHAPE_LABELS } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { CLIP_COLOR, waveformPath } from './timelineUtil';
import { ClipMediaLayers } from './ClipMediaLayers';
import { isPreviewable } from '../../media/clipPreview';
import type { useTimelinePointer } from './useTimelinePointer';

/** corner chips so applied fx / lut / zoom / denoise / transition are visible on the clip */
function ClipEffectBadges({
  item,
  inTransition,
}: {
  item: TimelineItem;
  inTransition: TransitionItem | null;
}) {
  const t = useT();
  const chips: { key: string; label: string; title: string; className: string }[] = [];
  const effects = item.effects ?? [];
  const fxNames = effects
    .filter((e) => e.assetId in FX_EFFECTS)
    .map((e) => t(FX_EFFECTS[e.assetId]?.name ?? e.assetId));
  const lutNames = effects
    .filter((e) => e.assetId in LUT_EFFECTS)
    .map((e) => t(LUT_EFFECTS[e.assetId]?.name ?? e.assetId));
  // custom / uncategorized shaders
  const otherFx = effects.filter((e) => !(e.assetId in FX_EFFECTS) && !(e.assetId in LUT_EFFECTS));

  if (fxNames.length || otherFx.length) {
    const n = fxNames.length + otherFx.length;
    chips.push({
      key: 'fx',
      label: n > 1 ? t('特效×{n}', { n }) : (fxNames[0] ?? t(ALL_FX[otherFx[0]?.assetId]?.name ?? '特效')),
      title: [...fxNames, ...otherFx.map((e) => t(ALL_FX[e.assetId]?.name ?? e.assetId))].join(' · '),
      className: 'fx',
    });
  }
  if (lutNames.length) {
    chips.push({
      key: 'lut',
      label: lutNames.length > 1 ? `LUT×${lutNames.length}` : lutNames[0],
      title: lutNames.join(' · '),
      className: 'lut',
    });
  }
  if (item.zoom?.shape || item.zoom?.envelope || (item.zoom?.reframeCurve?.keyframes.length ?? 0) > 0) {
    const shape = item.zoom?.shape;
    // 插件包络曲线无 shape,用自带 label(插件数据,不进词典)
    const name = shape ? t(ZOOM_SHAPE_LABELS[shape] ?? shape) : item.zoom?.label;
    chips.push({
      key: 'zoom',
      label: name ?? t('缩放'),
      title: name ? t('缩放 · {name}', { name }) : t('关键帧缩放'),
      className: 'zoom',
    });
  }
  if (item.denoisedSrc) {
    chips.push({ key: 'iso', label: t('人声'), title: t('已应用人声隔离'), className: 'iso' });
  }
  if (inTransition) {
    const trName = t(TRANSITION_LABELS[inTransition.type] ?? inTransition.type);
    chips.push({ key: 'tr', label: trName, title: t('入场转场 · {name}', { name: trName }), className: 'tr' });
  }
  if (!chips.length) return null;
  return (
    <div className="cc-clip-badges" aria-hidden>
      {chips.map((c) => (
        <span key={c.key} className={`cc-clip-badge ${c.className}`} title={c.title}>{c.label}</span>
      ))}
    </div>
  );
}

interface TrackLaneProps {
  trackId: TrackId;
  items: TimelineItem[];
  state: TimelineState;
  commands: EditorCommands;
  pointer: ReturnType<typeof useTimelinePointer>;
  editMode: 'selection' | 'blade' | 'trim' | 'pen';
  pickMode: boolean;
  locked: boolean;
  hidden: boolean;
  px: number;
  rowHeight: number;
  libDropTarget: string | null;
  setLibDropTarget: Dispatch<SetStateAction<string | null>>;
  applyLibraryToClip: (payload: LibraryDragPayload, item: TimelineItem) => boolean;
  applyLibraryToTrack: (payload: LibraryDragPayload, trackId: TrackId, startFrame: number) => boolean;
  frameFromClientX: (clientX: number) => number;
  onContextMenu: (menu: { id: string; x: number; y: number }) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function TrackLane({
  trackId, items, state, commands, pointer, editMode, pickMode, locked, hidden, px, rowHeight,
  libDropTarget, setLibDropTarget, applyLibraryToClip, applyLibraryToTrack, frameFromClientX,
  onContextMenu, scrollRef,
}: TrackLaneProps) {
  const t = useT();
  const { drag, penDrag, setPenDrag, startDrag, startPick, startMarquee } = pointer;
  return (
    <div
      style={{
        // locked lane: slightly dimmed (锁定轨底色微暗;锁图标同时高亮)
        flex: 1, position: 'relative', background: locked ? `color-mix(in srgb, ${theme.bg} 70%, #000)` : theme.bg, opacity: hidden ? 0.4 : locked ? 0.75 : 1,
        outline: libDropTarget === `track:${trackId}` ? '0.5px dashed #6a9fd8' : undefined,
        outlineOffset: -2,
        cursor: pickMode ? 'crosshair' : undefined,
      }}
      onPointerDown={(e) => {
        if (pickMode) { startPick(e, 'lane'); return; }
        // selection mode: empty-lane drag → marquee multi-select
        if (editMode === 'selection' && !locked) startMarquee(e);
      }}
      onDragOver={(e) => {
        if (!hasLibraryDrag(e) || locked) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setLibDropTarget(`track:${trackId}`);
      }}
      onDragLeave={() => setLibDropTarget((t) => (t === `track:${trackId}` ? null : t))}
      onDrop={(e) => {
        const payload = parseLibraryDrag(e);
        setLibDropTarget(null);
        if (!payload || locked) return;
        e.preventDefault();
        e.stopPropagation();
        // Prefer clip under cursor if any (fx/lut/zoom/transition)
        const f = frameFromClientX(e.clientX);
        const hit = items.find((it) => f >= it.startFrame && f < it.startFrame + it.durationInFrames);
        if (hit && (payload.kind === 'fx' || payload.kind === 'lut' || payload.kind === 'zoom' || payload.kind === 'transition')) {
          applyLibraryToClip(payload, hit);
          return;
        }
        applyLibraryToTrack(payload, trackId, f);
      }}
    >
      {items.map((it) => {
        const selected = isItemSelected(state, it.id);
        // Group-move preview: every selected clip rides the same delta as the grab handle
        const groupMove = !!drag && drag.mode === 'move' && isItemSelected(state, drag.id) && selected;
        const dragging = drag?.id === it.id || groupMove;
        const start = it.startFrame + (dragging && drag && drag.mode !== 'trim-right' ? drag.deltaF : 0);
        const durTrim = drag?.id === it.id && drag.mode === 'trim-left' ? -drag.deltaF
          : drag?.id === it.id && drag.mode === 'trim-right' ? drag.deltaF : 0;
        const dur = Math.max(1, it.durationInFrames + durTrim);
        const isLibOver = libDropTarget === it.id;
        return (
          <div
            key={it.id}
            title={it.name}
            onPointerDown={(e) => {
              if (pickMode) { // selection mode: click → item ref, drag → timerange (no editing)
                commands.selectItem(it.id);
                startPick(e, 'clip', it);
                return;
              }
              if (editMode === 'blade') { // blade mode: click cuts the clip here
                e.stopPropagation();
                const f = Math.round(frameFromClientX(e.clientX));
                if (f > it.startFrame && f < it.startFrame + it.durationInFrames) commands.splitItem(it.id, f);
                return;
              }
              if (editMode === 'pen') { // pen: 1st click selects, next clicks punch opacity kf (纵向=值)
                e.stopPropagation();
                if (e.button !== 0) return;
                if (!isItemSelected(state, it.id)) { commands.selectItem(it.id); return; }
                if (it.kind === 'audio' || locked) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const f = Math.max(0, Math.min(it.durationInFrames - 1, Math.round(frameFromClientX(e.clientX)) - it.startFrame));
                const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / Math.max(1, rect.height)));
                commands.setItemKeyframe(it.id, 'opacity', f, Math.round(v * 100) / 100);
                return;
              }
              startDrag(e, it.id, 'move', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              // Keep multi-select when right-clicking an already-selected clip
              // The context menu does not collapse the current selection set.
              if (!isItemSelected(state, it.id)) commands.selectItem(it.id);
              onContextMenu({ id: it.id, x: e.clientX, y: e.clientY });
            }}
            onDragOver={(e) => {
              if (!hasLibraryDrag(e) || locked) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'copy';
              setLibDropTarget(it.id);
            }}
            onDragLeave={(e) => {
              e.stopPropagation();
              setLibDropTarget((t) => (t === it.id ? null : t));
            }}
            onDrop={(e) => {
              const payload = parseLibraryDrag(e);
              setLibDropTarget(null);
              if (!payload || locked) return;
              e.preventDefault();
              e.stopPropagation();
              if (!applyLibraryToClip(payload, it)) {
                // sound/template may land on clip → use clip start on same track
                applyLibraryToTrack(payload, it.track, it.startFrame);
              }
            }}
            style={{
              position: 'absolute', left: Math.max(0, start) * px, top: 4, height: rowHeight - 8, width: dur * px,
              background: CLIP_COLOR[it.kind] ?? theme.clipMg,
              // 视频缩略帧条由 ClipMediaLayers 画(CSS 背景加载不了 mp4);图片仍用自身作底
              backgroundImage: it.kind === 'image' && it.src ? `linear-gradient(90deg, transparent 0%, rgba(0,0,0,.4) 78%), url(${it.src})` : undefined,
              backgroundSize: 'auto 100%', backgroundRepeat: 'no-repeat',
              borderRadius: 3, color: '#fff', fontSize: 11,
              display: 'flex', alignItems: 'flex-end', padding: '0 8px 5px', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap',
              border: isLibOver
                ? '2px solid #6a9fd8'
                : selected ? `2px solid ${theme.textStrong}` : '0.5px solid rgba(255,255,255,.08)',
              boxShadow: isLibOver ? 'inset 0 0 0 0.5px #6a9fd855, 0 0 0 0.5px #6a9fd844' : undefined,
              cursor: pickMode ? 'copy' : locked ? 'not-allowed' : editMode === 'blade' || editMode === 'pen' ? 'crosshair' : 'grab', userSelect: 'none', touchAction: 'none',
            }}
          >
            {(it.kind === 'audio' || it.kind === 'video') && (
              <ClipMediaLayers item={it} px={px} fps={state.fps} height={rowHeight - 8} />
            )}
            {it.kind === 'audio' && !isPreviewable(it.src) && (
              <svg className="cc-audio-waveform" viewBox={`0 0 ${Math.max(1, dur * px - 6)} 24`} preserveAspectRatio="none" aria-hidden>
                <path d={waveformPath(`${it.id}:${it.name}`, Math.max(1, dur * px - 6))} />
              </svg>
            )}
            <ClipEffectBadges item={it} inTransition={(state.transitions ?? []).find((t) => t.incomingItemId === it.id) ?? null} />
            {/* pen mode: opacity keyframe rubber band on the selected clip (纵向 = 值 0..1) */}
            {editMode === 'pen' && selected && it.kind !== 'audio' && (() => {
              const raw = it.keyframes?.opacity ?? [];
              const kfs = penDrag?.itemId === it.id
                ? upsertKeyframe(raw.filter((k) => k.frame !== penDrag.fromFrame), penDrag.frame, penDrag.value, penDrag.easing)
                : raw;
              if (!kfs.length) return null;
              const h = rowHeight - 8;
              const w = Math.max(1, dur * px);
              const yOf = (v: number) => 3 + (1 - Math.max(0, Math.min(1, v))) * (h - 6);
              const pts = kfs.map((k) => `${(k.frame * px).toFixed(1)},${yOf(k.value).toFixed(1)}`).join(' ');
              const band = `0,${yOf(kfs[0].value).toFixed(1)} ${pts} ${w.toFixed(1)},${yOf(kfs[kfs.length - 1].value).toFixed(1)}`;
              return (
                <>
                  {/* ponytail: segments draw as straight lines even when eased — the dots are the editing surface */}
                  <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} aria-hidden>
                    <polyline points={band} fill="none" stroke="#ffd866" strokeWidth={1.2} opacity={0.9} />
                  </svg>
                  {kfs.map((k) => (
                    <div
                      key={k.frame}
                      title={t('透明度 {pct}% @ {sec}s — 拖动改帧/值 · 右键删除', { pct: Math.round(k.value * 100), sec: (k.frame / state.fps).toFixed(2) })}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (e.button !== 0 || locked) return;
                        // capture on the scroll container: the dot itself remounts as its
                        // frame (= React key) changes mid-drag, which would drop capture
                        scrollRef.current?.setPointerCapture?.(e.pointerId);
                        const lane = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                        setPenDrag({ itemId: it.id, fromFrame: k.frame, frame: k.frame, value: k.value, easing: k.easing, laneTop: lane.top, laneHeight: lane.height });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!locked) commands.removeItemKeyframe(it.id, 'opacity', k.frame);
                      }}
                      style={{ position: 'absolute', left: k.frame * px - 4, top: yOf(k.value) - 4, width: 8, height: 8,
                        background: '#ffd866', border: '0.5px solid rgba(0,0,0,0.85)', transform: 'rotate(45deg)',
                        cursor: 'grab', zIndex: 3, touchAction: 'none' }}
                    />
                  ))}
                </>
              );
            })()}
            {/* trim handles (hidden in blade / pen / selection-pick modes) */}
            {!pickMode && editMode !== 'blade' && editMode !== 'pen' && <div onPointerDown={(e) => startDrag(e, it.id, 'trim-left', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
              style={{ position: 'absolute', left: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: editMode === 'trim' ? 'rgba(240,86,46,0.5)' : selected ? 'rgba(0,0,0,0.25)' : 'transparent' }} />}
            <span className={`cc-clip-label${it.kind === 'audio' ? ' audio' : ''}`}>{it.name}</span>
            {!pickMode && editMode !== 'blade' && editMode !== 'pen' && <div onPointerDown={(e) => startDrag(e, it.id, 'trim-right', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
              style={{ position: 'absolute', right: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: editMode === 'trim' ? 'rgba(240,86,46,0.5)' : selected ? 'rgba(0,0,0,0.25)' : 'transparent' }} />}
          </div>
        );
      })}
      {/* transition badges at each cut on this track */}
      {(state.transitions ?? []).filter((tn) => tn.trackId === trackId).map((tn) => {
        const inItem = state.items.find((it) => it.id === tn.incomingItemId);
        if (!inItem) return null;
        const label = t(TRANSITION_LABELS[tn.type as TransitionType] ?? tn.type);
        return (
          <div key={tn.id} title={`${label} · ${(tn.durationInFrames / state.fps).toFixed(1)}s`}
            onClick={() => commands.selectItem(tn.incomingItemId)}
            className="cc-transition-marker"
            style={{ position: 'absolute', top: '50%', left: inItem.startFrame * px, transform: 'translate(-50%, -50%)', zIndex: 3 }}>
            <Icon name="swap" size={10} />
          </div>
        );
      })}
    </div>
  );
}
