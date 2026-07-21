import type { MediaAsset } from '../editor/types';
import type { SemanticMatch } from './semantic-search/types';

export type MediaSortKey = 'newest' | 'name' | 'duration';
export type MediaTypeFilter = 'all' | MediaAsset['kind'];

interface MediaFilterOptions {
  assets: MediaAsset[];
  query: string;
  semanticResults: SemanticMatch[] | null;
  currentFolderId?: string;
  type: MediaTypeFilter;
  favoritesOnly: boolean;
  sort: MediaSortKey;
}

function semanticAssetOrder(matches: SemanticMatch[] | null): Map<string, number> {
  const order = new Map<string, number>();
  for (const match of matches ?? []) {
    if (!order.has(match.assetId)) order.set(match.assetId, order.size);
  }
  return order;
}

export function filterMediaAssets(options: MediaFilterOptions) {
  const { assets, semanticResults, currentFolderId, type, favoritesOnly, sort } = options;
  const query = options.query.trim().toLowerCase();
  const importOrder = new Map(assets.map((asset, index) => [asset.id, index]));
  const semanticOrder = semanticAssetOrder(semanticResults);
  const visible = assets
    .filter((asset) => !query || asset.name.toLowerCase().includes(query))
    .filter((asset) => semanticResults ? semanticOrder.has(asset.id) : (query || asset.folderId === currentFolderId))
    .filter((asset) => type === 'all' || asset.kind === type)
    .filter((asset) => !favoritesOnly || asset.favorite)
    .toSorted((left, right) => semanticResults
      ? (semanticOrder.get(left.id) ?? 0) - (semanticOrder.get(right.id) ?? 0)
      : sort === 'name' ? left.name.localeCompare(right.name, 'zh-CN')
        : sort === 'duration' ? right.durationInFrames - left.durationInFrames
          : (importOrder.get(right.id) ?? 0) - (importOrder.get(left.id) ?? 0));
  return { query, visible };
}
