import { useEffect, useRef, useState } from 'react';
import { clampScalar, scalarModifier, scrubScalar } from './scalarMath';

interface ScalarControlProps {
  ariaLabel: string;
  disabled?: boolean;
  formatValue: string;
  inputScale?: number;
  mixed?: boolean;
  max: number;
  min: number;
  onChange: (value: number) => void;
  onGestureEnd: () => void;
  onGestureStart: () => void;
  step: number;
  title: string;
  value: number;
}

interface ScrubState {
  pointerId: number;
  startValue: number;
  startX: number;
  moved: boolean;
}

const displayNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));

export function ScalarControl({
  ariaLabel,
  disabled,
  formatValue,
  inputScale = 1,
  mixed = false,
  max,
  min,
  onChange,
  onGestureEnd,
  onGestureStart,
  step,
  title,
  value,
}: ScalarControlProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => mixed ? '' : displayNumber(value * inputScale));
  const inputRef = useRef<HTMLInputElement>(null);
  const scrub = useRef<ScrubState | null>(null);

  useEffect(() => {
    if (!editing) setDraft(mixed ? '' : displayNumber(value * inputScale));
  }, [editing, inputScale, mixed, value]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed)) {
      const next = clampScalar(parsed / inputScale, min, max);
      if (mixed || Math.abs(next - value) >= 1e-9) onChange(next);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        autoFocus
        className="cc-insp-number"
        max={max * inputScale}
        min={min * inputScale}
        step={step * inputScale}
        type="number"
        value={draft}
        onBlur={() => {
          commit();
          onGestureEnd();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onGestureEnd();
            setEditing(false);
            return;
          }
          if (event.key === 'Enter') {
            event.currentTarget.blur();
            return;
          }
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          const direction = event.key === 'ArrowUp' ? 1 : -1;
          const current = Number(draft) / inputScale;
          const next = clampScalar(
            (Number.isFinite(current) ? current : value) + direction * step * scalarModifier(event),
            min,
            max,
          );
          onGestureStart();
          onChange(next);
          setDraft(displayNumber(next * inputScale));
        }}
        onKeyUp={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') onGestureEnd();
        }}
      />
    );
  }

  return (
    <button
      aria-label={ariaLabel}
      className="cc-insp-scalar"
      disabled={disabled}
      title={title}
      type="button"
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setEditing(true);
        }
      }}
      onPointerCancel={() => {
        if (!scrub.current) return;
        scrub.current = null;
        onGestureEnd();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.focus();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic pointer events have no active browser pointer to capture.
        }
        scrub.current = {
          pointerId: event.pointerId,
          startValue: value,
          startX: event.clientX,
          moved: false,
        };
        onGestureStart();
      }}
      onPointerMove={(event) => {
        const active = scrub.current;
        if (mixed) return;
        if (!active || active.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - active.startX;
        if (Math.abs(deltaX) < 3 && !active.moved) return;
        active.moved = true;
        onChange(scrubScalar(active.startValue, deltaX, step, min, max, event));
      }}
      onPointerUp={(event) => {
        const active = scrub.current;
        if (!active || active.pointerId !== event.pointerId) return;
        scrub.current = null;
        onGestureEnd();
        if (!active.moved) setEditing(true);
      }}
    >
      {mixed ? '—' : formatValue}
    </button>
  );
}
