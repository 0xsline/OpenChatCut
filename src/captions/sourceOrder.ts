import type { CaptionSourceEntry } from './types';

const finiteOrder = (entry: CaptionSourceEntry): number | undefined => {
  const value = entry.trackOrder;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
};

/**
 * Return caption sources in their persisted visual order without mutating the
 * project document. Legacy entries without trackOrder keep their array order.
 */
export function orderedCaptionSourceEntries(entries: readonly CaptionSourceEntry[]): CaptionSourceEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, order: finiteOrder(entry) ?? index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Persist a canonical, duplicate-free 0-based trackOrder for every source. */
export function normalizeCaptionSourceEntries(entries: readonly CaptionSourceEntry[]): CaptionSourceEntry[] {
  return orderedCaptionSourceEntries(entries).map((entry, trackOrder) => ({ ...entry, trackOrder }));
}

/** Move one source to a 0-based visual position and re-normalize all orders. */
export function moveCaptionSourceEntry(
  entries: readonly CaptionSourceEntry[],
  sourceId: string,
  trackOrder: number,
): CaptionSourceEntry[] {
  const next = normalizeCaptionSourceEntries(entries);
  const from = next.findIndex((entry) => entry.id === sourceId);
  if (from < 0) return next;
  const [entry] = next.splice(from, 1);
  const to = Math.max(0, Math.min(next.length, Math.floor(trackOrder)));
  next.splice(to, 0, entry);
  return next.map((candidate, order) => ({ ...candidate, trackOrder: order }));
}
