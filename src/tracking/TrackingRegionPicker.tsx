import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { TimelineItem } from '../editor/types';
import type { TrackingPoint, TrackingRegion } from './types';

interface TrackingRegionPickerProps {
  item: TimelineItem;
  fps: number;
  region: TrackingRegion;
  points: TrackingPoint[];
  disabled: boolean;
  onChange: (region: TrackingRegion) => void;
}

interface DragOrigin { x: number; y: number }

const FIRST_RENDERABLE_TIME = 0.001;
const MIN_PREVIEW_ZOOM = 1;
const MAX_PREVIEW_ZOOM = 4;
const PREVIEW_ZOOM_STEP = 1.12;

export function nextTrackingZoom(current: number, deltaY: number): number {
  const factor = deltaY < 0 ? PREVIEW_ZOOM_STEP : 1 / PREVIEW_ZOOM_STEP;
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, current * factor));
}

function useTrackingZoom() {
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(MIN_PREVIEW_ZOOM);
  const [origin, setOrigin] = useState<DragOrigin>({ x: 0.5, y: 0.5 });
  useEffect(() => {
    const picker = pickerRef.current;
    if (!picker) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = picker.getBoundingClientRect();
      setOrigin({ x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height });
      setZoom((current) => nextTrackingZoom(current, event.deltaY));
    };
    picker.addEventListener('wheel', onWheel, { passive: false });
    return () => picker.removeEventListener('wheel', onWheel);
  }, []);
  return { pickerRef, zoom, origin };
}

function normalizedPoint(event: ReactPointerEvent<HTMLDivElement>): DragOrigin {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
  };
}

function regionFromDrag(start: DragOrigin, end: DragOrigin): TrackingRegion {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.max(0.02, Math.abs(end.x - start.x)),
    height: Math.max(0.02, Math.abs(end.y - start.y)),
  };
}

export function TrackingRegionPicker({ item, fps, region, points, disabled, onChange }: TrackingRegionPickerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [drag, setDrag] = useState<DragOrigin | null>(null);
  const { pickerRef, zoom, origin } = useTrackingZoom();
  const aspectRatio = (item.width ?? 16) / (item.height ?? 9);
  const seekToStart = () => {
    if (videoRef.current) videoRef.current.currentTime = Math.max(FIRST_RENDERABLE_TIME, (item.srcInFrame ?? 0) / fps);
  };
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = normalizedPoint(event);
    setDrag(point);
    onChange({ x: point.x, y: point.y, width: 0.02, height: 0.02 });
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || disabled) return;
    onChange(regionFromDrag(drag, normalizedPoint(event)));
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    onChange(regionFromDrag(drag, normalizedPoint(event)));
    setDrag(null);
  };
  const path = points.map((point) => `${point.x * 100},${point.y * 100}`).join(' ');
  return (
    <div ref={pickerRef} className="cc-tracking-picker" style={{ aspectRatio }}>
      <div className="cc-tracking-zoom" style={{ transform: `scale(${zoom})`, transformOrigin: `${origin.x * 100}% ${origin.y * 100}%` }}>
        <video ref={videoRef} src={item.src} muted playsInline preload="auto" onLoadedMetadata={seekToStart} />
        <div className={`cc-tracking-hit-area${disabled ? ' disabled' : ''}`}
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}>
          {!!path && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={path} vectorEffect="non-scaling-stroke" />
          </svg>}
          <i style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
