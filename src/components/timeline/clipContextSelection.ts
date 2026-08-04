import type { TimelineItem } from '../../editor/types';

/** Right-click within a multi-selection keeps every selected live clip in selection order. */
export function contextReferenceItems(
  clickedItemId: string,
  selectedIds: readonly string[],
  items: readonly TimelineItem[],
): TimelineItem[] {
  const ids = selectedIds.includes(clickedItemId) && selectedIds.length > 1
    ? selectedIds
    : [clickedItemId];
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}
