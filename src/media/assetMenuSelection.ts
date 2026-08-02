/**
 * A context-menu action is a batch action when its target is already selected.
 * Right-clicking an unselected card deliberately starts a new one-item action.
 */
export function assetMenuSelectionIds(
  targetId: string,
  selectedIds: ReadonlySet<string>,
  assetIdsInOrder: readonly string[],
): string[] {
  if (!selectedIds.has(targetId)) return [targetId];
  return assetIdsInOrder.filter((id) => selectedIds.has(id));
}

/** Mixed selections become a single "收藏" action; all-favorite selections become "取消收藏". */
export function assetMenuFavoriteValue(assets: readonly { favorite?: boolean }[]): boolean {
  return !assets.every((asset) => asset.favorite === true);
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/** Apply one shared display-name root while keeping each media file's extension distinct. */
export function batchAssetRename(
  assets: readonly { id: string; name: string }[],
  requestedBaseName: string,
): Array<{ id: string; name: string }> {
  const baseName = requestedBaseName.trim();
  if (!baseName) return [];
  return assets.map((asset, index) => {
    const extension = fileExtension(asset.name);
    const root = extension && baseName.toLowerCase().endsWith(extension.toLowerCase())
      ? baseName.slice(0, -extension.length)
      : baseName;
    return { id: asset.id, name: `${root}${index ? ` ${index + 1}` : ''}${extension}` };
  });
}
