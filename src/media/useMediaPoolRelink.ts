import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import type { MediaAsset, MediaAssetRelinkPatch } from '../editor/types';
import type { t as translate } from '../i18n/locale';
import { matchRelinkFile } from './mediaRelinkMatch';
import { importMedia } from './upload';

interface UseMediaPoolRelinkOptions {
  assets: readonly MediaAsset[];
  offlineAssetIds: ReadonlySet<string>;
  fps: number;
  onAssetLoadError: (asset: MediaAsset) => void;
  onRelinkAsset?: (id: string, next: MediaAssetRelinkPatch) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  t: typeof translate;
}

interface MediaPoolRelinkState {
  missing: ReadonlySet<string>;
  missingList: MediaAsset[];
  relinkInputRef: RefObject<HTMLInputElement | null>;
  directoryInputRef: RefObject<HTMLInputElement | null>;
  relinkBusy: boolean;
  relinkMessage: string | null;
  showRelinkAll: boolean;
  setShowRelinkAll: (open: boolean) => void;
  markMissing: (id: string) => void;
  clearMissing: (id: string) => void;
  startRelink: (id: string) => void;
  pickRelinkFile: (files: FileList | null) => Promise<void>;
  relinkFromFolder: (files: FileList | null) => Promise<void>;
}

function relinkPatch(asset: MediaAsset): MediaAssetRelinkPatch {
  return {
    src: asset.src,
    name: asset.name,
    durationInFrames: asset.durationInFrames,
    width: asset.width,
    height: asset.height,
    kind: asset.kind,
    sourceRevision: asset.sourceRevision,
    sourceSize: asset.sourceSize,
    sourceModifiedAt: asset.sourceModifiedAt,
    sourceFilename: asset.sourceFilename,
    originalFilePath: asset.originalFilePath,
  };
}

function relinkResultMessage(
  relinked: number,
  unmatched: readonly string[],
  t: typeof translate,
): string {
  if (relinked > 0 && unmatched.length === 0) {
    return t('已从文件夹按文件名重链 {n} 个素材', { n: relinked });
  }
  if (relinked > 0) {
    return t('已重链 {n} 个素材；未找到匹配的文件：{list}', {
      n: relinked,
      list: unmatched.join('、'),
    });
  }
  return t('未找到与丢失素材匹配的文件：{list}', { list: unmatched.join('、') });
}

async function relinkMatches(
  assets: readonly MediaAsset[],
  files: readonly File[],
  fps: number,
  relink: (id: string, next: MediaAssetRelinkPatch) => void,
  clearMissing: (id: string) => void,
): Promise<{ relinked: number; unmatched: string[] }> {
  let relinked = 0;
  const unmatched: string[] = [];
  for (const asset of assets) {
    const file = matchRelinkFile(asset, files);
    if (!file) {
      unmatched.push(asset.name);
      continue;
    }
    relink(asset.id, relinkPatch(await importMedia(file, fps)));
    clearMissing(asset.id);
    relinked += 1;
  }
  return { relinked, unmatched };
}

function useMissingMedia(options: UseMediaPoolRelinkOptions): Pick<
MediaPoolRelinkState, 'missing' | 'missingList' | 'markMissing' | 'clearMissing'> {
  const { assets, offlineAssetIds, onAssetLoadError } = options;
  const [mediaErrors, setMediaErrors] = useState<Set<string>>(() => new Set());
  const missing = useMemo(
    () => new Set([...offlineAssetIds, ...mediaErrors]),
    [mediaErrors, offlineAssetIds],
  );
  const missingList = useMemo(
    () => assets.filter((asset) => missing.has(asset.id)),
    [assets, missing],
  );
  const clearMissing = useCallback((id: string) => setMediaErrors((current) => {
    if (!current.has(id)) return current;
    const next = new Set(current);
    next.delete(id);
    return next;
  }), []);
  const markMissing = useCallback((id: string) => {
    const asset = assets.find((item) => item.id === id);
    if (asset) onAssetLoadError(asset);
    setMediaErrors((current) => new Set(current).add(id));
  }, [assets, onAssetLoadError]);
  return { missing, missingList, markMissing, clearMissing };
}

function useSingleRelink(
  options: UseMediaPoolRelinkOptions,
  clearMissing: (id: string) => void,
): Pick<MediaPoolRelinkState, 'relinkInputRef' | 'startRelink' | 'pickRelinkFile'> {
  const { fps, onRelinkAsset, setBusy, setError } = options;
  const [relinkTarget, setRelinkTarget] = useState<string | null>(null);
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const startRelink = useCallback((id: string) => {
    if (!onRelinkAsset) return;
    setRelinkTarget(id);
    requestAnimationFrame(() => relinkInputRef.current?.click());
  }, [onRelinkAsset]);
  const pickRelinkFile = useCallback(async (files: FileList | null) => {
    const file = files?.[0];
    const id = relinkTarget;
    setRelinkTarget(null);
    if (relinkInputRef.current) relinkInputRef.current.value = '';
    if (!file || !id || !onRelinkAsset) return;
    setBusy(true);
    setError(null);
    try {
      onRelinkAsset(id, relinkPatch(await importMedia(file, fps)));
      clearMissing(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [clearMissing, fps, onRelinkAsset, relinkTarget, setBusy, setError]);
  return { relinkInputRef, startRelink, pickRelinkFile };
}

function useBatchRelink(
  options: UseMediaPoolRelinkOptions,
  missingList: readonly MediaAsset[],
  clearMissing: (id: string) => void,
): Pick<MediaPoolRelinkState,
'directoryInputRef' | 'relinkBusy' | 'relinkMessage' | 'relinkFromFolder'> {
  const { fps, onRelinkAsset, setError, t } = options;
  const [relinkBusy, setRelinkBusy] = useState(false);
  const [relinkMessage, setRelinkMessage] = useState<string | null>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const relinkFromFolder = useCallback(async (files: FileList | null) => {
    if (!files?.length || !onRelinkAsset) return;
    setRelinkBusy(true);
    setError(null);
    setRelinkMessage(null);
    try {
      const result = await relinkMatches(
        missingList, Array.from(files), fps, onRelinkAsset, clearMissing,
      );
      setRelinkMessage(relinkResultMessage(result.relinked, result.unmatched, t));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRelinkBusy(false);
      if (directoryInputRef.current) directoryInputRef.current.value = '';
    }
  }, [clearMissing, fps, missingList, onRelinkAsset, setError, t]);
  return { directoryInputRef, relinkBusy, relinkMessage, relinkFromFolder };
}

export function useMediaPoolRelink(options: UseMediaPoolRelinkOptions): MediaPoolRelinkState {
  const [showRelinkAll, setShowRelinkAll] = useState(false);
  const missing = useMissingMedia(options);
  const single = useSingleRelink(options, missing.clearMissing);
  const batch = useBatchRelink(options, missing.missingList, missing.clearMissing);
  return { ...missing, ...single, ...batch, showRelinkAll, setShowRelinkAll };
}
