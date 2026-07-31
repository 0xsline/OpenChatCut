export interface DisposableRuntime {
  dispose: () => void;
}

export interface RuntimeSlot<T extends DisposableRuntime> {
  current: T | null;
}

export function ensureRuntimeSlot<T extends DisposableRuntime>(
  slot: RuntimeSlot<T>,
  create: () => T,
): T {
  if (!slot.current) slot.current = create();
  return slot.current;
}

export function disposeRuntimeSlot<T extends DisposableRuntime>(slot: RuntimeSlot<T>): void {
  const runtime = slot.current;
  slot.current = null;
  runtime?.dispose();
}
