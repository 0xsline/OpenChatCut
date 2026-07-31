export interface ScalarModifiers {
  shiftKey: boolean;
  metaKey: boolean;
}

export function scalarModifier({ shiftKey, metaKey }: ScalarModifiers): number {
  return (shiftKey ? 10 : 1) * (metaKey ? 0.1 : 1);
}

export function clampScalar(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function snapScalar(value: number, min: number, max: number, step: number): number {
  const snapped = min + Math.round((value - min) / step) * step;
  const precision = Math.max(0, `${step}`.split('.')[1]?.length ?? 0) + 2;
  return clampScalar(Number(snapped.toFixed(precision)), min, max);
}

export function scrubScalar(
  start: number,
  deltaX: number,
  step: number,
  min: number,
  max: number,
  modifiers: ScalarModifiers,
): number {
  const next = start + deltaX * step * scalarModifier(modifiers);
  const precision = Math.max(0, `${step}`.split('.')[1]?.length ?? 0) + 2;
  return clampScalar(Number(next.toFixed(precision)), min, max);
}
