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
import type { ClipTransform, KeyframeProp, TimelineItem, TimelineState } from '../../editor/types';
import { t } from '../../i18n/locale';
import {
  cyclePreviewCandidate,
  hitPreviewCandidates,
  movePreviewTransform,
  previewCandidateGeometry,
  rotatePreviewTransform,
  scalePreviewTransform,
  visiblePreviewCandidates,
  type ClickCycleState,
  type EffectivePreviewTransform,
  type PreviewPoint,
  type PreviewSize,
} from './previewTransform';

export interface PreviewTransformOverlayProps {
  state: TimelineState;
  playerRef: RefObject<PlayerRef | null>;
  onSelectItem: (id: string | null) => void;
  onSetItemTransform: (id: string, patch: ClipTransform) => void;
  onSetItemKeyframe: (id: string, prop: KeyframeProp, localFrame: number, value: number) => void;
  onBeginHistoryGesture: () => void;
  onEndHistoryGesture: () => void;
}

type GestureMode = 'move' | 'scale' | 'rotate';

interface GestureState {
  pointerId: number;
  item: TimelineItem;
  mode: GestureMode;
  startUi: PreviewPoint;
  startComposition: PreviewPoint;
  center: PreviewPoint;
  previewSize: PreviewSize;
  transform: EffectivePreviewTransform;
  localFrame: number;
  moved: boolean;
}

interface PendingValues {
  item: TimelineItem;
  localFrame: number;
  values: Partial<Record<'x' | 'y' | 'scale' | 'rotation', number>>;
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

const handleMode = (target: EventTarget | null): GestureMode | null => {
  const handle = target instanceof Element ? target.closest<HTMLElement>('[data-preview-handle]') : null;
  const value = handle?.dataset.previewHandle;
  if (value === 'rotate') return 'rotate';
  if (value?.startsWith('scale-')) return 'scale';
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
}: PreviewTransformOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(() => Math.round(playerRef.current?.getCurrentFrame() ?? 0));
  const [previewSize, setPreviewSize] = useState<PreviewSize>({ width: state.width, height: state.height });
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

  const commitPending = useCallback(() => {
    if (commitRafRef.current) {
      cancelAnimationFrame(commitRafRef.current);
      commitRafRef.current = 0;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    const patch: ClipTransform = {};
    for (const [prop, value] of Object.entries(pending.values) as Array<['x' | 'y' | 'scale' | 'rotation', number]>) {
      if (pending.item.keyframes?.[prop]?.length) {
        onSetItemKeyframe(pending.item.id, prop, pending.localFrame, value);
      } else {
        patch[prop] = value;
      }
    }
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
        values: {
          scale: scalePreviewTransform(
            gesture.transform.scale,
            gesture.center,
            gesture.startComposition,
            currentComposition,
          ),
        },
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
    let mode: GestureMode = modeFromHandle ?? 'move';

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
          <button
            type="button"
            className="cc-preview-transform-handle cc-preview-transform-rotate"
            data-preview-handle="rotate"
            aria-label={t('旋转片段')}
            style={percentPosition(rotateHandle.handle)}
          />
        </>
      )}
    </div>
  );
}
