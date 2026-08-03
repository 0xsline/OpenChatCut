export function allVisibleAssetsSelected(selected: ReadonlySet<string>, visibleIds: readonly string[]) {
  return visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
}

export function toggleVisibleAssetSelection(selected: ReadonlySet<string>, visibleIds: readonly string[]) {
  const next = new Set(selected);
  if (allVisibleAssetsSelected(selected, visibleIds)) {
    for (const id of visibleIds) next.delete(id);
  } else {
    for (const id of visibleIds) next.add(id);
  }
  return next;
}
