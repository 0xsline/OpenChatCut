import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { loadTimelineView, saveTimelineView } from '../../persist/sessionPrefs';
import {
  anchoredTimelineScrollLeft,
  clampTimelineZoom,
  defaultTimelineZoom,
  fitTimelineZoom,
  scaleTimelineZoom,
  timelinePlayheadAnchorX,
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
const TIMELINE_FIT_PADDING = 48;
type NumberSetter = Dispatch<SetStateAction<number>>;

interface TimelineZoomControllerOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  getPlayheadFrame: () => number;
  totalFrames: number;
  fps: number;
  projectId?: string;
  timelineId?: string;
}

interface ZoomViewState {
  key: string;
  zoom: number;
  trackScale: number;
}

function fittedZoom(element: HTMLDivElement, totalFrames: number, fps: number): number {
  return fitTimelineZoom(
    element.clientWidth, HEADER_W, TIMELINE_FIT_PADDING, totalFrames, PX_PER_FRAME, TIME_LIMITS,
  ) ?? defaultTimelineZoom(fps, PX_PER_FRAME, RULER_LABEL_MIN_PX, TIME_LIMITS);
}

function useTimelineWheelZoom(
  scrollRef: RefObject<HTMLDivElement | null>,
  zoom: number,
  setZoom: NumberSetter,
  setTrackScale: NumberSetter,
) {
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
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
          element.scrollLeft, pointerX, HEADER_W, PX_PER_FRAME * oldZoom, PX_PER_FRAME * next,
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
}

export function useTimelineZoomController(options: TimelineZoomControllerOptions) {
  const { scrollRef, getPlayheadFrame, totalFrames, fps, projectId, timelineId } = options;
  const key = `${projectId ?? 'default'}\u0000${timelineId ?? 'default'}`;
  const [view, setView] = useState<ZoomViewState>({ key: '', zoom: 1, trackScale: 1 });
  const totalFramesRef = useRef(totalFrames);
  totalFramesRef.current = totalFrames;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const zoom = view.key === key ? view.zoom : 1;
  const trackScale = view.key === key ? view.trackScale : 1;
  const viewByKeyRef = useRef<Record<string, Pick<ZoomViewState, 'zoom' | 'trackScale'>>>({});
  if (view.key) viewByKeyRef.current[view.key] = { zoom: view.zoom, trackScale: view.trackScale };
  const pendingAutoFitRef = useRef<string | null>(null);
  const pendingAnchorRef = useRef<{ key: string; frame: number; viewportX: number; zoom: number } | null>(null);

  const setZoom = useCallback<NumberSetter>((next) => {
    setView((current) => {
      const base = current.key === key ? current : { key, zoom: 1, trackScale: 1 };
      const value = typeof next === 'function' ? next(base.zoom) : next;
      return value === base.zoom ? base : { ...base, zoom: value };
    });
  }, [key]);
  const setPlayheadZoom = useCallback<NumberSetter>((next) => {
    const active = pendingAnchorRef.current;
    const pending = active?.key === key ? active : null;
    const current = pending?.zoom ?? zoom;
    const target = clampTimelineZoom(typeof next === 'function' ? next(current) : next, TIME_LIMITS);
    if (target === current) return;

    const element = scrollRef.current;
    const frame = getPlayheadFrame();
    const viewportX = element && Number.isFinite(frame)
      ? (pending?.frame === frame ? pending.viewportX
        : timelinePlayheadAnchorX(frame, element.scrollLeft, element.clientWidth, HEADER_W, PX_PER_FRAME * zoom))
      : null;
    pendingAnchorRef.current = viewportX !== null && totalFrames > 0 && target !== zoom
      ? { key, frame, viewportX, zoom: target }
      : null;
    setZoom(target);
  }, [getPlayheadFrame, key, scrollRef, setZoom, totalFrames, zoom]);

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    const element = scrollRef.current;
    if (!anchor || !element || view.key !== key || anchor.key !== key || anchor.zoom !== zoom) return;
    pendingAnchorRef.current = null;
    // Apply after React commits the new content width so the browser clamps against the new bounds.
    element.scrollLeft = HEADER_W + anchor.frame * PX_PER_FRAME * zoom - anchor.viewportX;
  }, [key, scrollRef, view.key, zoom]);

  const setTrackScale = useCallback<NumberSetter>((next) => {
    setView((current) => {
      const base = current.key === key ? current : { key, zoom: 1, trackScale: 1 };
      const value = typeof next === 'function' ? next(base.trackScale) : next;
      return value === base.trackScale ? base : { ...base, trackScale: value };
    });
  }, [key]);

  useEffect(() => {
    const element = scrollRef.current;
    const views = viewByKeyRef.current;
    if (!element) return;
    pendingAnchorRef.current = null;
    const saved = projectId && timelineId ? loadTimelineView(projectId, timelineId) : null;
    const nextZoom = saved?.zoom ?? (totalFramesRef.current > 0
      ? fittedZoom(element, totalFramesRef.current, fpsRef.current)
      : defaultTimelineZoom(fpsRef.current, PX_PER_FRAME, RULER_LABEL_MIN_PX, TIME_LIMITS));
    pendingAutoFitRef.current = !saved && totalFramesRef.current <= 0 ? key : null;
    setView({ key, zoom: nextZoom, trackScale: saved?.trackScale ?? 1 });
    element.scrollLeft = saved?.scrollLeft ?? 0;
    return () => {
      if (projectId && timelineId) {
        const previous = views[key] ?? { zoom: nextZoom, trackScale: saved?.trackScale ?? 1 };
        saveTimelineView(projectId, timelineId, {
          zoom: previous.zoom,
          trackScale: previous.trackScale,
          scrollLeft: element.scrollLeft,
        });
      }
    };
  }, [key, projectId, scrollRef, timelineId]);

  useEffect(() => {
    if (view.key !== key || !projectId || !timelineId) return;
    saveTimelineView(projectId, timelineId, { zoom: view.zoom, trackScale: view.trackScale });
  }, [key, projectId, timelineId, view]);

  useEffect(() => {
    if (pendingAutoFitRef.current !== key || totalFrames <= 0) return;
    const element = scrollRef.current;
    if (!element) return;
    pendingAutoFitRef.current = null;
    setZoom(fittedZoom(element, totalFrames, fps));
    element.scrollLeft = 0;
  }, [fps, key, scrollRef, setZoom, totalFrames]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !projectId || !timelineId) return;
    let raf = 0;
    const saveScroll = () => {
      raf = 0;
      saveTimelineView(projectId, timelineId, { scrollLeft: element.scrollLeft });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(saveScroll);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      saveScroll();
      element.removeEventListener('scroll', onScroll);
    };
  }, [projectId, scrollRef, timelineId]);

  useTimelineWheelZoom(scrollRef, zoom, setZoom, setTrackScale);

  const zoomBy = useCallback(
    (factor: number) => setPlayheadZoom((current) => scaleTimelineZoom(current, factor, TIME_LIMITS)),
    [setPlayheadZoom],
  );
  const fitToView = useCallback(() => {
    const element = scrollRef.current;
    if (!element || totalFrames <= 0) return;
    pendingAutoFitRef.current = null;
    pendingAnchorRef.current = null;
    setZoom(fittedZoom(element, totalFrames, fps));
    element.scrollLeft = 0;
  }, [fps, scrollRef, setZoom, totalFrames]);

  return {
    zoom,
    setZoom: setPlayheadZoom,
    zoomBy,
    fitToView,
    pixelsPerFrame: PX_PER_FRAME * zoom,
    trackScale,
  };
}
