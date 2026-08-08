export interface GlVisibilityWindow {
  key: string;
  from: number;
  durationInFrames: number;
  itemIds: readonly string[];
}

export function updateReadyGlWindows(
  current: Set<string>,
  key: string,
  ready: boolean,
): Set<string> {
  if (current.has(key) === ready) return current;
  const next = new Set(current);
  if (ready) next.add(key);
  else next.delete(key);
  return next;
}

export function isGlBaseHidden(
  itemId: string,
  frame: number,
  windows: readonly GlVisibilityWindow[],
  readyWindows: ReadonlySet<string>,
): boolean {
  return windows.some((window) => readyWindows.has(window.key)
    && window.itemIds.includes(itemId)
    && frame >= window.from
    && frame < window.from + window.durationInFrames);
}
