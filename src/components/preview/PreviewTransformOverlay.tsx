import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { PlayerRef } from '@remotion/player';
import type { ClipCrop, ClipTransform, KeyframeProp, TimelineItem, TimelineState } from '../../editor/types';
import { t } from '../../i18n/locale';
import {
  cyclePreviewCandidate,
  edgeCropPreviewTransform,
  hitPreviewCandidates,
  movePreviewTransform,
  previewCandidateGeometry,
  previewEdgeMidpoints,
  rotatePreviewTransform,
  uniformScaleAxesPreviewTransform,
  visiblePreviewCandidates,
  type ClickCycleState,
  type EffectivePreviewTransform,
  type PreviewPoint,
  type PreviewScaleEdge,
  type PreviewSize,
} from './previewTransform';
import { canPreviewTextEdit, previewTextEditFields } from './previewTextEdit';
import { PreviewTextEditBar } from './PreviewTextEditBar';

export interface PreviewTransformOverlayProps {
  state: TimelineState;
  playerRef: RefObject<PlayerRef | null>;
  onSelectItem: (id: string | null) => void;
  onSetItemTransform: (id: string, patch: ClipTransform) => void;
  onSetItemKeyframe: (id: string, prop: KeyframeProp, localFrame: number, value: number) => void;
  onBeginHistoryGesture: () => void;
  onEndHistoryGesture: () => void;
  /** Live text style edits for text / text-like MG clips. */
  onItemPropChange?: (id: string, key: string, value: unknown) => void;
  onSeedChat?: (text: string) => void;
}

const DOUBLE_CLICK_MS = 320;

type GestureMode = 'move' | 'scale' | 'crop-edge' | 'rotate';

interface GestureState {
  pointerId: number;
  item: TimelineItem;
  mode: GestureMode;
  /** When mode is crop-edge, which edge is being dragged. */
  edge?: PreviewScaleEdge;
  /** Crop snapshot at pointer-down (edge crop keeps the opposite side fixed). */
  startCrop?: ClipCrop;
  startUi: PreviewPoint;
  startComposition: PreviewPoint;
  center: PreviewPoint;
  previewSize: PreviewSize;
  transform: EffectivePreviewTransform;
  localFrame: number;
  moved: boolean;
}

type TransformWriteProp = 'x' | 'y' | 'scale' | 'scaleX' | 'scaleY' | 'rotation';

interface PendingValues {
  item: TimelineItem;
  localFrame: number;
  values: Partial<Record<TransformWriteProp, number>>;
  /** Edge crop writes the full crop object (or undefined to clear). */
  crop?: ClipCrop | undefined;
  cropTouched?: boolean;
}

const CLICK_TOLERANCE = 4;
const DRAG_THRESHOLD = 3;

const uiPoint = (event: ReactPointerEvent, rect: DOMRect): PreviewPoint => ({
  x: event.clientX - rect.left,
  y: event.clientY - rect.top,
});

const compositionPoint = (
  point: PreviewPoint,
  rect: DOMRect,
  state: Pick<TimelineState, 'width' | 'height'>,
): PreviewPoint => ({
  x: rect.width > 0 ? point.x / rect.width * state.width : 0,
  y: rect.height > 0 ? point.y / rect.height * state.height : 0,
});

const EDGE_HANDLES = new Set<string>(['crop-n', 'crop-s', 'crop-e', 'crop-w']);

const handleMode = (target: EventTarget | null): { mode: GestureMode; edge?: PreviewScaleEdge } | null => {
  const handle = target instanceof Element ? target.closest<HTMLElement>('[data-preview-handle]') : null;
  const value = handle?.dataset.previewHandle;
  if (value === 'rotate') return { mode: 'rotate' };
  if (value && EDGE_HANDLES.has(value)) {
    return { mode: 'crop-edge', edge: value.slice('crop-'.length) as PreviewScaleEdge };
  }
  if (value?.startsWith('scale-')) return { mode: 'scale' };
  return null;
};

export function PreviewTransformOverlay({
  state,
  playerRef,
  onSelectItem,
  onSetItemTransform,
  onSetItemKeyframe,
  onBeginHistoryGesture,
  onEndHistoryGesture,
  onItemPropChange,
  onSeedChat,
}: PreviewTransformOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(() => Math.round(playerRef.current?.getCurrentFrame() ?? 0));
  const [previewSize, setPreviewSize] = useState<PreviewSize>({ width: state.width, height: state.height });
  const [textAutoEdit, setTextAutoEdit] = useState(false);
  const lastClickRef = useRef<{ id: string; at: number } | null>(null);
  const cycleRef = useRef<ClickCycleState | null>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const pendingRef = useRef<PendingValues | null>(null);
  const commitRafRef = useRef(0);
  const endHistoryRef = useRef(onEndHistoryGesture);
  endHistoryRef.current = onEndHistoryGesture;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setPreviewSize({ width: root.clientWidth, height: root.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return undefined;
    setFrame(Math.round(player.getCurrentFrame()));
    let paintRaf = 0;
    let pendingFrame: number | null = null;
    const onFrame = (event: { detail: { frame: number } }) => {
      pendingFrame = Math.round(event.detail.frame);
      if (paintRaf) return;
      paintRaf = requestAnimationFrame(() => {
        paintRaf = 0;
        if (pendingFrame != null) setFrame(pendingFrame);
        pendingFrame = null;
      });
    };
    player.addEventListener('frameupdate', onFrame);
    return () => {
      if (paintRaf) cancelAnimationFrame(paintRaf);
      player.removeEventListener('frameupdate', onFrame);
    };
  }, [playerRef]);

  const candidates = useMemo(() => visiblePreviewCandidates(state, frame), [frame, state]);
  const selectedCandidate = useMemo(
    () => state.width > 0 && state.height > 0
      ? candidates.find(({ item }) => item.id === state.selectedId) ?? null
      : null,
    [candidates, state.height, state.selectedId, state.width],
  );
  const selection = useMemo(
    () => selectedCandidate ? previewCandidateGeometry(state, selectedCandidate) : null,
    [selectedCandidate, state],
  );

  useEffect(() => {
    cycleRef.current = null;
  }, [frame, state.height, state.width]);

  useEffect(() => {
    setTextAutoEdit(false);
    lastClickRef.current = null;
  }, [state.selectedId]);

  const commitPending = useCallback(() => {
    if (commitRafRef.current) {
      cancelAnimationFrame(commitRafRef.current);
      commitRafRef.current = 0;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    const patch: ClipTransform = {};
    for (const [prop, value] of Object.entries(pending.values) as Array<[TransformWriteProp, number]>) {
      if (pending.item.keyframes?.[prop]?.length) {
        onSetItemKeyframe(pending.item.id, prop, pending.localFrame, value);
      } else {
        patch[prop] = value;
      }
    }
    if (pending.cropTouched) patch.crop = pending.crop;
    if (Object.keys(patch).length) onSetItemTransform(pending.item.id, patch);
  }, [onSetItemKeyframe, onSetItemTransform]);

  const queueValues = useCallback((pending: PendingValues) => {
    pendingRef.current = pending;
    if (commitRafRef.current) return;
    commitRafRef.current = requestAnimationFrame(() => {
      commitRafRef.current = 0;
      commitPending();
    });
  }, [commitPending]);

  const finishGesture = useCallback((resetCycle: boolean) => {
    if (!gestureRef.current) return;
    commitPending();
    gestureRef.current = null;
    if (resetCycle) cycleRef.current = null;
    onEndHistoryGesture();
  }, [commitPending, onEndHistoryGesture]);

  useEffect(() => () => {
    if (commitRafRef.current) cancelAnimationFrame(commitRafRef.current);
    if (gestureRef.current) endHistoryRef.current();
    gestureRef.current = null;
    pendingRef.current = null;
  }, []);

  useEffect(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const track = state.tracks?.[gesture.item.track];
    const stillExists = state.items.some((item) => item.id === gesture.item.id);
    if (!stillExists || track?.hidden || track?.locked || state.selectedId !== gesture.item.id) {
      finishGesture(true);
    }
  }, [finishGesture, state.items, state.selectedId, state.tracks]);

  const updateGesture = useCallback((event: ReactPointerEvent) => {
    const gesture = gestureRef.current;
    const root = rootRef.current;
    if (!gesture || !root || gesture.pointerId !== event.pointerId) return;
    const rect = root.getBoundingClientRect();
    const currentUi = uiPoint(event, rect);
    const currentComposition = compositionPoint(currentUi, rect, state);
    const delta = { x: currentUi.x - gesture.startUi.x, y: currentUi.y - gesture.startUi.y };
    if (!gesture.moved && Math.hypot(delta.x, delta.y) >= DRAG_THRESHOLD) gesture.moved = true;
    if (!gesture.moved) return;

    if (gesture.mode === 'move') {
      const moved = movePreviewTransform(gesture.transform, delta, gesture.previewSize);
      queueValues({ item: gesture.item, localFrame: gesture.localFrame, values: moved });
    } else if (gesture.mode === 'scale') {
      queueValues({
        item: gesture.item,
        localFrame: gesture.localFrame,
        values: uniformScaleAxesPreviewTransform(
          gesture.transform,
          gesture.center,
          gesture.startComposition,
          currentComposition,
        ),
      });
    } else if (gesture.mode === 'crop-edge' && gesture.edge) {
      const { crop } = edgeCropPreviewTransform(
        state,
        gesture.transform,
        gesture.startCrop,
        currentComposition,
        gesture.edge,
      );
      queueValues({
        item: gesture.item,
        localFrame: gesture.localFrame,
        values: {},
        crop,
        cropTouched: true,
      });
    } else {
      queueValues({
        item: gesture.item,
        localFrame: gesture.localFrame,
        values: {
          rotation: rotatePreviewTransform(
            gesture.transform.rotation,
            gesture.center,
            gesture.startComposition,
            currentComposition,
          ),
        },
      });
    }
  }, [queueValues, state]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || gestureRef.current) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    event.currentTarget.focus({ preventScroll: true });
    const pointUi = uiPoint(event, rect);
    const pointComposition = compositionPoint(pointUi, rect, state);
    const modeFromHandle = handleMode(event.target);
    let candidate = selectedCandidate;
    let mode: GestureMode = modeFromHandle?.mode ?? 'move';
    let edge = modeFromHandle?.edge;

    if (!modeFromHandle) {
      const hits = hitPreviewCandidates(state, frame, pointComposition);
      const cycled = cyclePreviewCandidate(cycleRef.current, pointUi, hits, CLICK_TOLERANCE);
      if (!cycled) {
        cycleRef.current = null;
        onSelectItem(null);
        return;
      }
      cycleRef.current = cycled.next;
      candidate = hits.find(({ item }) => item.id === cycled.id) ?? null;
      if (!candidate) return;
      onSelectItem(candidate.item.id);
      mode = 'move';
      edge = undefined;
    }

    if (!candidate) return;
    event.preventDefault();
    event.stopPropagation();
    playerRef.current?.pause();
    setFrame(Math.round(playerRef.current?.getCurrentFrame() ?? frame));
    event.currentTarget.setPointerCapture(event.pointerId);
    const geometry = previewCandidateGeometry(state, candidate);
    gestureRef.current = {
      pointerId: event.pointerId,
      item: candidate.item,
      mode,
      edge,
      startCrop: candidate.item.transform?.crop,
      startUi: pointUi,
      startComposition: pointComposition,
      center: geometry.center,
      previewSize: { width: rect.width, height: rect.height },
      transform: candidate.transform,
      localFrame: candidate.localFrame,
      moved: false,
    };
    onBeginHistoryGesture();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    updateGesture(event);
    const moved = gesture.moved;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!moved && canPreviewTextEdit(gesture.item) && previewTextEditFields(gesture.item)?.textKey) {
      const now = Date.now();
      const prev = lastClickRef.current;
      if (prev && prev.id === gesture.item.id && now - prev.at <= DOUBLE_CLICK_MS) {
        lastClickRef.current = null;
        setTextAutoEdit(true);
      } else {
        lastClickRef.current = { id: gesture.item.id, at: now };
      }
    } else {
      lastClickRef.current = null;
    }
    finishGesture(moved);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    finishGesture(true);
  };

  const rotateHandle = useMemo(() => {
    if (!selection) return null;
    const top = {
      x: (selection.corners[0].x + selection.corners[1].x) / 2,
      y: (selection.corners[0].y + selection.corners[1].y) / 2,
    };
    const dx = top.x - selection.center.x;
    const dy = top.y - selection.center.y;
    const length = Math.hypot(dx, dy) || 1;
    const compositionOffset = previewSize.height > 0 ? 28 * state.height / previewSize.height : 28;
    return {
      stem: top,
      handle: { x: top.x + dx / length * compositionOffset, y: top.y + dy / length * compositionOffset },
    };
  }, [previewSize.height, selection, state.height]);

  const percentPosition = (point: PreviewPoint) => ({
    left: `${point.x / state.width * 100}%`,
    top: `${point.y / state.height * 100}%`,
  });

  const edgeMidpoints = selection ? previewEdgeMidpoints(selection.corners) : null;
  const edgeHandles: Array<{ edge: PreviewScaleEdge; label: string; className: string }> = [
    { edge: 'n', label: t('裁切上边（拖入则遮住上方）'), className: 'cc-preview-transform-crop-n' },
    { edge: 's', label: t('裁切下边（拖入则遮住下方）'), className: 'cc-preview-transform-crop-s' },
    { edge: 'e', label: t('裁切右边（拖入则遮住右侧）'), className: 'cc-preview-transform-crop-e' },
    { edge: 'w', label: t('裁切左边（拖入则遮住左侧）'), className: 'cc-preview-transform-crop-w' },
  ];

  return (
    <div
      ref={rootRef}
      className="cc-preview-transform-overlay"
      role="group"
      aria-label={t('预览画布片段变换')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={updateGesture}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={() => finishGesture(true)}
    >
      {selection && rotateHandle && (
        <>
          <svg
            className="cc-preview-transform-outline"
            viewBox={`0 0 ${state.width} ${state.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polygon
              data-preview-selection={selectedCandidate!.item.id}
              points={selection.corners.map((point) => `${point.x},${point.y}`).join(' ')}
              fill="none"
              stroke="var(--cc-accent)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={rotateHandle.stem.x}
              y1={rotateHandle.stem.y}
              x2={rotateHandle.handle.x}
              y2={rotateHandle.handle.y}
              stroke="var(--cc-accent)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {selection.corners.map((point, index) => (
            <button
              key={index}
              type="button"
              className={`cc-preview-transform-handle cc-preview-transform-scale cc-preview-transform-scale-${index}`}
              data-preview-handle={`scale-${index}`}
              aria-label={t('从角点 {n} 等比缩放片段', { n: index + 1 })}
              style={percentPosition(point)}
            />
          ))}
          {edgeMidpoints && edgeHandles.map(({ edge, label, className }) => (
            <button
              key={edge}
              type="button"
              className={`cc-preview-transform-handle cc-preview-transform-crop ${className}`}
              data-preview-handle={`crop-${edge}`}
              aria-label={label}
              style={percentPosition(edgeMidpoints[edge])}
            />
          ))}
          <button
            type="button"
            className="cc-preview-transform-handle cc-preview-transform-rotate"
            data-preview-handle="rotate"
            aria-label={t('旋转片段')}
            style={percentPosition(rotateHandle.handle)}
          />
          {onItemPropChange
            && selectedCandidate
            && previewTextEditFields(selectedCandidate.item)
            && (
              <PreviewTextEditBar
                item={selectedCandidate.item}
                selection={selection}
                composition={{ width: state.width, height: state.height }}
                onPropChange={onItemPropChange}
                onSeedChat={onSeedChat}
                autoEdit={textAutoEdit}
                onAutoEditHandled={() => setTextAutoEdit(false)}
              />
            )}
        </>
      )}
    </div>
  );
}
