import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectDoc } from '../editor/types';
import { ensureMediaSrcs, isMediaSrcReachable } from '../persist/mediaBlobStore';

export function useOfflineMedia(doc: Pick<ProjectDoc, 'assets' | 'timelines'>) {
  const [offlineSrcs, setOfflineSrcs] = useState<Set<string>>(() => new Set());
  const offlineSrcsRef = useRef<ReadonlySet<string>>(offlineSrcs);
  offlineSrcsRef.current = offlineSrcs;
  const sourcesKey = useMemo(() => JSON.stringify([...new Set([
    ...doc.assets.filter((asset) => asset.kind !== 'motion-graphic' && asset.src).map((asset) => asset.src),
    ...doc.timelines.flatMap((timeline) => timeline.items.flatMap((item) => (
      [item.src, item.denoisedSrc].filter(Boolean) as string[]
    ))),
  ])].sort()), [doc.assets, doc.timelines]);

  useEffect(() => {
    let alive = true;
    const sources = JSON.parse(sourcesKey) as string[];
    void (async () => {
      await ensureMediaSrcs(sources).catch(() => undefined);
      const results = await Promise.all(sources.map(async (src) => [src, await isMediaSrcReachable(src)] as const));
      if (alive) setOfflineSrcs(new Set(results.filter(([, ok]) => !ok).map(([src]) => src)));
    })();
    return () => { alive = false; };
  }, [sourcesKey]);

  const offlineAssetIds = useMemo(() => new Set(
    doc.assets.filter((asset) => offlineSrcs.has(asset.src)).map((asset) => asset.id),
  ), [doc.assets, offlineSrcs]);
  const markOffline = useCallback((src: string) => {
    setOfflineSrcs((current) => new Set(current).add(src));
  }, []);
  return { offlineSrcs, offlineSrcsRef, offlineAssetIds, markOffline };
}
