// Track clip band (translated verbatim from Timeline.tsx): the editable area of a track - clip box (drag/crop/
// Blade/pen/reference picking dispatched by editMode), audio waveform, effect marker, pen transparency keyframe
// Overlay, library asset drag and drop (fx/lut/zoom/transition drop clip, sound/template drop track), transition seam mark.
// The pointer machine (drag/penDrag, etc.) is provided by useTimelinePointer and is passed in through the pointer prop.
import { type Dispatch, type RefObject, type SetStateAction, useMemo } from 'react';
import { theme, themeAlpha } from '../../theme';
import { Icon } from '../icons';
import {
  TRANSITION_LABELS, isItemSelected, timelineTrackIds, trackKind,
  type TimelineItem, type TimelineState, type TrackId, type TransitionItem, type TransitionType,
} from '../../editor/types';
import { upsertKeyframe } from '../../editor/keyframes';
import { getKeyframePropertyDefinition } from '../../editor/keyframeRegistry';
import { rateStretchGeometry } from '../../editor/rateStretch';
import type { EditorCommands } from '../../editor/store';
import { hasLibraryDrag, parseLibraryDrag, type LibraryDragPayload } from '../../library/drag';
import { ALL_FX, FX_EFFECTS, LUT_EFFECTS } from '../../gl/fx/effects';
import { ZOOM_SHAPE_LABELS } from '../../editor/types';
import { useT } from '../../i18n/locale';
import {
  CLIP_COLOR, intersectFrameRange, visibleTimelineItems, waveformPath,
  type EditMode, type TimelineFrameWindow, type TimelineIndexes,
} from './timelineUtil';
import { ClipMediaLayers } from './ClipMediaLayers';
import { isPreviewable } from '../../media/clipPreview';
import { canDropMediaAsset, hasCompatibleMediaDrag, parseMediaAssetDrag } from '../../media/drag';
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
    // The plugin envelope curve has no shape, use the built-in label (plugin data, not entered into the dictionary)
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
  indexes: TimelineIndexes;
  state: TimelineState;
  commands: EditorCommands;
  pointer: ReturnType<typeof useTimelinePointer>;
  editMode: EditMode;
  pickMode: boolean;
  locked: boolean;
  hidden: boolean;
  px: number;
  rowHeight: number;
  visibleWindow: TimelineFrameWindow;
  pinnedItemIds: ReadonlySet<string>;
  libDropTarget: string | null;
  setLibDropTarget: Dispatch<SetStateAction<string | null>>;
  applyLibraryToClip: (payload: LibraryDragPayload, item: TimelineItem) => boolean;
  applyLibraryToTrack: (payload: LibraryDragPayload, trackId: TrackId, startFrame: number) => boolean;
  frameFromClientX: (clientX: number) => number;
  onContextMenu: (menu: { id: string; x: number; y: number }) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function TrackLane({
  trackId, state, commands, pointer, editMode, pickMode, locked, hidden, px, rowHeight,
  visibleWindow, pinnedItemIds, indexes, libDropTarget, setLibDropTarget,
  applyLibraryToClip, applyLibraryToTrack, frameFromClientX, onContextMenu, scrollRef,
}: TrackLaneProps) {
  const t = useT();
  const { drag, penDrag, setPenDrag, startDrag, startPick, startMarquee } = pointer;
  const trackIds = timelineTrackIds(state);
  const items = indexes.itemsByTrack.get(trackId) ?? [];
  const renderedItems = useMemo(() => visibleTimelineItems(
    indexes.itemWindowsByTrack.get(trackId),
    visibleWindow,
    pinnedItemIds,
    indexes.itemById,
    indexes.itemOrderById,
    trackId,
  ), [indexes, pinnedItemIds, trackId, visibleWindow]);
  const transitions = indexes.transitionsByTrack.get(trackId) ?? [];
  const visibleTransitions = useMemo(() => transitions.filter((transition) => {
    const incoming = indexes.itemById.get(transition.incomingItemId);
    if (!incoming) return false;
    const transitionStart = incoming.startFrame - Math.floor(transition.durationInFrames / 2);
    return pinnedItemIds.has(transition.incomingItemId)
      || pinnedItemIds.has(transition.outgoingItemId)
      || !!intersectFrameRange(transitionStart, transition.durationInFrames, visibleWindow);
  }), [indexes, pinnedItemIds, transitions, visibleWindow]);
  const laneKind = trackKind(state, trackId);
  const dragOffsetY = drag?.mode === 'move'
    && trackKind(state, drag.targetTrack) === trackKind(state, drag.baseTrack)
    && !state.tracks?.[drag.targetTrack]?.locked
    ? (trackIds.indexOf(drag.targetTrack) - trackIds.indexOf(drag.baseTrack)) * rowHeight
    : 0;
  return (
    <div
      className="cc-track-lane"
      style={{
        // locked lane: slightly dimmed (the background color of the locked lane is dimmed; the lock icon is highlighted at the same time)
        flex: 1, position: 'relative', background: locked ? `color-mix(in srgb, ${theme.bg} 70%, ${themeAlpha.shadow(1)})` : undefined, opacity: hidden ? 0.4 : locked ? 0.75 : 1,
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
        if (locked || (!hasLibraryDrag(e) && !hasCompatibleMediaDrag(e, laneKind))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setLibDropTarget(`track:${trackId}`);
      }}
      onDragLeave={() => setLibDropTarget((t) => (t === `track:${trackId}` ? null : t))}
      onDrop={(e) => {
        const mediaAssetId = parseMediaAssetDrag(e);
        if (mediaAssetId) {
          setLibDropTarget(null);
          e.preventDefault();
          e.stopPropagation();
          const asset = (state.assets ?? []).find((item) => item.id === mediaAssetId);
          if (!locked && asset && canDropMediaAsset(asset, laneKind)) {
            commands.addMediaItem(asset, { track: trackId, startFrame: frameFromClientX(e.clientX) });
          }
          return;
        }
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
      {renderedItems.map((it) => {
        const selected = isItemSelected(state, it.id);
        // Group-move preview: every selected clip rides the same delta as the grab handle
        const groupMove = !!drag && drag.mode === 'move' && isItemSelected(state, drag.id) && selected;
        const dragging = drag?.id === it.id || groupMove;
        const stretchEdge = drag?.mode === 'trim-left' ? 'left' : drag?.mode === 'trim-right' ? 'right' : null;
        const stretch = editMode === 'rate-stretch' && drag?.id === it.id && stretchEdge
          ? rateStretchGeometry(it, stretchEdge, drag.deltaF) : null;
        const start = stretch?.startFrame ?? (it.startFrame + (dragging && drag && drag.mode !== 'trim-right' ? drag.deltaF : 0));
        const durTrim = drag?.id === it.id && drag.mode === 'trim-left' ? -drag.deltaF
          : drag?.id === it.id && drag.mode === 'trim-right' ? drag.deltaF : 0;
        const dur = stretch?.durationInFrames ?? Math.max(1, it.durationInFrames + durTrim);
        const mediaIntersection = intersectFrameRange(start, dur, visibleWindow);
        const renderSrcIn = (it.srcInFrame ?? 0)
          + (drag?.id === it.id && drag.mode === 'trim-left' && !stretch ? drag.deltaF : 0);
        const renderPlaybackRate = stretch?.playbackRate ?? (it.playbackRate ?? 1);
        const canRateStretch = it.kind === 'video' || it.kind === 'audio';
        const showHandles = !pickMode && editMode !== 'blade' && editMode !== 'pen'
          && (editMode !== 'rate-stretch' || canRateStretch);
        const isLibOver = libDropTarget === it.id;
        return (
          <div
            key={it.id}
            className={`cc-timeline-clip${selected ? ' is-selected' : ''}${isLibOver ? ' is-library-over' : ''}`}
            title={it.name}
            data-clip-kind={it.kind}
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
              if (editMode === 'pen') { // pen: 1st click selects, next clicks punch a kf (vertical = value; audio = volume, rest = transparency)
                e.stopPropagation();
                if (e.button !== 0) return;
                if (!isItemSelected(state, it.id)) { commands.selectItem(it.id); return; }
                if (locked) return;
                const prop = it.kind === 'audio' ? 'volume' as const : 'opacity' as const;
                const [lo, hi] = getKeyframePropertyDefinition(prop).editorRange;
                const rect = e.currentTarget.getBoundingClientRect();
                const f = Math.max(0, Math.min(it.durationInFrames - 1, Math.round(frameFromClientX(e.clientX)) - it.startFrame));
                const frac = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / Math.max(1, rect.height)));
                commands.setItemKeyframe(it.id, prop, f, Math.round((lo + frac * (hi - lo)) * 100) / 100);
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
              // The video thumbnail frame bar is drawn by ClipMediaLayers (CSS background cannot load mp4); the image still uses itself as the background
              backgroundImage: it.kind === 'image' && it.src ? `linear-gradient(90deg, transparent 0%, rgba(0,0,0,.4) 78%), url(${it.src})` : undefined,
              backgroundSize: 'auto 100%', backgroundRepeat: 'no-repeat',
              borderRadius: 3, color: '#fff', fontSize: 11,
              display: 'flex', alignItems: 'flex-end', padding: '0 8px 5px', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap',
              transform: dragging && dragOffsetY ? `translate3d(0, ${dragOffsetY}px, 0)` : undefined,
              zIndex: dragging ? 10 : undefined,
              cursor: pickMode ? 'copy' : locked ? 'not-allowed' : editMode === 'blade' || editMode === 'pen' ? 'crosshair' : 'grab', userSelect: 'none', touchAction: 'none',
            }}
          >
            {(it.kind === 'audio' || it.kind === 'video') && (
              <ClipMediaLayers
                item={it} px={px} fps={state.fps} height={rowHeight - 8}
                clipStartFrame={start} durationInFrames={dur}
                srcInFrame={renderSrcIn} playbackRate={renderPlaybackRate}
                visibleWindow={visibleWindow}
              />
            )}
            {it.kind === 'audio' && !isPreviewable(it.src) && mediaIntersection && (() => {
              const left = (mediaIntersection.startFrame - start) * px + 3;
              const width = Math.max(1, (mediaIntersection.endFrame - mediaIntersection.startFrame) * px - 6);
              return (
                <svg className="cc-audio-waveform" viewBox={`0 0 ${width} 24`}
                  preserveAspectRatio="none" aria-hidden style={{ left, width }}>
                  <path d={waveformPath(`${it.id}:${it.name}:${mediaIntersection.startFrame}`, width)} />
                </svg>
              );
            })()}
            <ClipEffectBadges item={it} inTransition={indexes.transitionByIncomingId.get(it.id) ?? null} />
            {/* pen mode: keyframe rubber band on the selected clip (vertical = value; audio = volume 0..2, rest = transparency 0..1)*/}
            {editMode === 'pen' && selected && (() => {
              const prop = it.kind === 'audio' ? 'volume' as const : 'opacity' as const;
              const [lo, hi] = getKeyframePropertyDefinition(prop).editorRange;
              const raw = it.keyframes?.[prop] ?? [];
              const kfs = penDrag?.itemId === it.id
                ? upsertKeyframe(raw.filter((k) => k.frame !== penDrag.fromFrame), penDrag.frame, penDrag.value, penDrag.easing)
                : raw;
              if (!kfs.length) return null;
              const h = rowHeight - 8;
              const w = Math.max(1, dur * px);
              const yOf = (v: number) => 3 + (1 - Math.max(0, Math.min(1, (v - lo) / (hi - lo)))) * (h - 6);
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
                      title={t(prop === 'volume' ? '音量 {pct}% @ {sec}s — 拖动改帧/值 · 右键删除' : '透明度 {pct}% @ {sec}s — 拖动改帧/值 · 右键删除', { pct: Math.round(k.value * 100), sec: (k.frame / state.fps).toFixed(2) })}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (e.button !== 0 || locked) return;
                        // capture on the scroll container: the dot itself remounts as its
                        // frame (= React key) changes mid-drag, which would drop capture
                        scrollRef.current?.setPointerCapture?.(e.pointerId);
                        const lane = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                        setPenDrag({ itemId: it.id, prop, fromFrame: k.frame, frame: k.frame, value: k.value, easing: k.easing, laneTop: lane.top, laneHeight: lane.height });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!locked) commands.removeItemKeyframe(it.id, prop, k.frame);
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
            {showHandles && <div onPointerDown={(e) => startDrag(e, it.id, 'trim-left', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
              style={{ position: 'absolute', left: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: editMode === 'trim' || editMode === 'rate-stretch' ? themeAlpha.accent(0.5) : selected ? themeAlpha.shadow(0.25) : 'transparent' }} />}
            <span className={`cc-clip-label${it.kind === 'audio' ? ' audio' : ''}`}>{it.name}</span>
            {showHandles && <div onPointerDown={(e) => startDrag(e, it.id, 'trim-right', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
              style={{ position: 'absolute', right: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: editMode === 'trim' || editMode === 'rate-stretch' ? themeAlpha.accent(0.5) : selected ? themeAlpha.shadow(0.25) : 'transparent' }} />}
          </div>
        );
      })}
      {/* transition badges at each cut on this track */}
      {visibleTransitions.map((tn) => {
        const inItem = indexes.itemById.get(tn.incomingItemId);
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
