import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  anchoredTimelineScrollLeft,
  defaultTimelineZoom,
  fitTimelineZoom,
  scaleTimelineZoom,
} from '../../editor/timelineZoom';
import {
  HEADER_W,
  MIN_TIME_ZOOM,
  PX_PER_FRAME,
  RULER_LABEL_MIN_PX,
} from './timelineUtil';

const TIME_LIMITS = { min: MIN_TIME_ZOOM, max: 6 };
const TRACK_MIN = 0.6;
const TRACK_MAX = 3;

interface TimelineZoomControllerOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  totalFrames: number;
  fps: number;
  timelineId?: string;
}

export function useTimelineZoomController(options: TimelineZoomControllerOptions) {
  const { scrollRef, totalFrames, fps, timelineId } = options;
  const [zoom, setZoom] = usePersistedState('cc.timelineZoom', 1);
  const [trackScale, setTrackScale] = usePersistedState('cc.trackScale', 1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const zoomBy = useCallback(
    (factor: number) => setZoom((current) => scaleTimelineZoom(current, factor, TIME_LIMITS)),
    [setZoom],
  );
  const fitToView = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const next = fitTimelineZoom(
      element.clientWidth, HEADER_W, 24, totalFrames, PX_PER_FRAME, TIME_LIMITS,
    );
    if (next == null) return;
    setZoom(next);
    element.scrollLeft = 0;
  }, [scrollRef, setZoom, totalFrames]);

  useEffect(() => {
    setZoom(defaultTimelineZoom(fps, PX_PER_FRAME, RULER_LABEL_MIN_PX, TIME_LIMITS));
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, [fps, scrollRef, setZoom, timelineId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const oldZoom = zoomRef.current;
        const next = scaleTimelineZoom(oldZoom, event.deltaY < 0 ? 1.12 : 1 / 1.12, TIME_LIMITS);
        if (next === oldZoom) return;
        const pointerX = event.clientX - element.getBoundingClientRect().left;
        const nextScroll = anchoredTimelineScrollLeft(
          element.scrollLeft, pointerX, HEADER_W,
          PX_PER_FRAME * oldZoom, PX_PER_FRAME * next,
        );
        setZoom(next);
        requestAnimationFrame(() => { element.scrollLeft = nextScroll; });
        return;
      }
      if (!event.altKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setTrackScale((current) => Math.min(TRACK_MAX, Math.max(TRACK_MIN, current * factor)));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [scrollRef, setTrackScale, setZoom]);

  return {
    zoom,
    setZoom,
    zoomBy,
    fitToView,
    pixelsPerFrame: PX_PER_FRAME * zoom,
    trackScale,
  };
}
