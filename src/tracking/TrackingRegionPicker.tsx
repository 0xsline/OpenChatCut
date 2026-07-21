import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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
  const aspectRatio = (item.width ?? 16) / (item.height ?? 9);
  const seekToStart = () => {
    if (videoRef.current) videoRef.current.currentTime = Math.max(0, (item.srcInFrame ?? 0) / fps);
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
    <div className="cc-tracking-picker" style={{ aspectRatio }}>
      <video ref={videoRef} src={item.src} muted playsInline preload="metadata" onLoadedMetadata={seekToStart} />
      <div className={`cc-tracking-hit-area${disabled ? ' disabled' : ''}`}
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}>
        {!!path && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={path} vectorEffect="non-scaling-stroke" />
        </svg>}
        <i style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />
      </div>
    </div>
  );
}
