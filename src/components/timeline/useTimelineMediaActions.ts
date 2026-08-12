import { useRef, useState, type MutableRefObject } from 'react';
import type { EditorCommands } from '../../editor/store';
import { timelineItemAssetId } from '../../editor/mediaAssetUsage';
import { trackKind, type TimelineItem, type TimelineState, type TrackId } from '../../editor/types';
import { exportClipMov, bakeClipToVideo } from '../../media/clipExport';
import { importMedia } from '../../media/upload';
import { kindOf } from '../../media/mediaProbe';
import { mediaAssetRelinkPatch } from '../../media/mediaAssetRelink';
import type { LibraryDragPayload } from '../../library/drag';
import { t as translate } from '../../i18n/locale';
import { applyLibraryToClip as applyToClip, applyLibraryToTrack as applyToTrack } from './libraryDropActions';

interface UseTimelineMediaActionsOptions {
  state: TimelineState;
  commands: EditorCommands;
  liveStateRef: MutableRefObject<TimelineState>;
  onDropExternalFiles?: (files: File[], trackId: TrackId, startFrame: number) => void;
  placeMode: 'insert' | 'overwrite';
  t: typeof translate;
}

export function useTimelineMediaActions({
  state,
  commands,
  liveStateRef,
  onDropExternalFiles,
  placeMode,
  t,
}: UseTimelineMediaActionsOptions) {
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const relinkItemRef = useRef<TimelineItem | null>(null);
  const trackInsertInputRef = useRef<HTMLInputElement>(null);
  const trackInsertTargetRef = useRef<{ trackId: TrackId; frame: number } | null>(null);
  const [clipJob, setClipJob] = useState<{ msg: string; error?: boolean } | null>(null);
  const [libDropTarget, setLibDropTarget] = useState<string | null>(null);

  const beginRelink = (item: TimelineItem) => {
    relinkItemRef.current = item;
    requestAnimationFrame(() => relinkInputRef.current?.click());
  };

  const relinkFile = async (files: FileList | null) => {
    const file = files?.[0];
    const item = relinkItemRef.current;
    relinkItemRef.current = null;
    if (relinkInputRef.current) relinkInputRef.current.value = '';
    if (!file || !item) return;
    const liveState = liveStateRef.current;
    const liveItem = liveState.items.find((candidate) => candidate.id === item.id);
    if (!liveItem) return;
    if (liveState.tracks?.[liveItem.track]?.locked) throw new Error(t('轨道已锁定'));
    // Validate against the picked file BEFORE importing it into the media
    // pool, otherwise a failed relink leaves an orphan duplicate asset.
    const relinkKind = kindOf(file);
    if (relinkKind !== liveItem.kind) throw new Error(t('请重新选择同类型文件'));
    try {
      const media = await importMedia(file, state.fps);
      const liveAssets = liveState.assets ?? [];
      const poolAssetId = timelineItemAssetId(liveItem, liveAssets);
      const result = poolAssetId
        ? commands.relinkMediaAsset(poolAssetId, mediaAssetRelinkPatch(media))
        : commands.relinkTimelineItem(liveItem.id, mediaAssetRelinkPatch(media));
      if (!result.changed) throw new Error(t('重新链接文件失败'));
      const msg = t('已重新链接文件');
      setClipJob({ msg });
      window.setTimeout(() => setClipJob((current) => current?.msg === msg && !current.error ? null : current), 5_000);
    } catch (error) {
      setClipJob({ msg: error instanceof Error ? error.message : t('重新链接文件失败'), error: true });
    }
  };

  const beginTrackInsert = (trackId: TrackId, frame: number) => {
    const input = trackInsertInputRef.current;
    if (!input || !onDropExternalFiles) return;
    const kind = trackKind(state, trackId);
    input.accept = kind === 'audio' ? 'audio/*'
      : kind === 'caption' ? '.srt,.vtt,.txt,text/plain'
        : 'video/*,image/*,.gif,.svg';
    trackInsertTargetRef.current = { trackId, frame };
    requestAnimationFrame(() => input.click());
  };

  const insertTrackFiles = (files: FileList | null) => {
    const target = trackInsertTargetRef.current;
    trackInsertTargetRef.current = null;
    if (trackInsertInputRef.current) trackInsertInputRef.current.value = '';
    if (!target || !files?.length || !onDropExternalFiles) return;
    onDropExternalFiles(Array.from(files), target.trackId, target.frame);
  };

  const exportMg = async (item: TimelineItem) => {
    setClipJob({ msg: t('导出 MG 动画中（ProRes 4444）…') });
    try {
      await exportClipMov(state, item);
      setClipJob(null);
    } catch (error) {
      setClipJob({ msg: error instanceof Error ? error.message : t('导出失败'), error: true });
    }
  };

  const convertToVideo = async (item: TimelineItem) => {
    setClipJob({ msg: t('转为视频中…') });
    try {
      const src = await bakeClipToVideo(state, item);
      commands.replaceItemMedia(item.id, src);
      setClipJob(null);
    } catch (error) {
      setClipJob({ msg: error instanceof Error ? error.message : t('转换失败'), error: true });
    }
  };

  const dropNotice = (msg: string) => {
    setClipJob({ msg });
    window.setTimeout(() => setClipJob((current) => (current && current.msg === msg && !current.error ? null : current)), 3000);
  };
  const dropContext = {
    state,
    commands,
    notice: dropNotice,
    getState: () => liveStateRef.current,
    getAssets: () => liveStateRef.current.assets ?? [],
  };
  const applyLibraryToClip = (payload: LibraryDragPayload, item: TimelineItem): boolean =>
    applyToClip(dropContext, payload, item);
  const applyLibraryToTrack = (payload: LibraryDragPayload, trackId: TrackId, startFrame: number): boolean =>
    applyToTrack(dropContext, payload, trackId, startFrame, placeMode === 'insert', placeMode === 'overwrite');

  return {
    relinkInputRef,
    trackInsertInputRef,
    clipJob,
    setClipJob,
    libDropTarget,
    setLibDropTarget,
    beginRelink,
    relinkFile,
    beginTrackInsert,
    insertTrackFiles,
    exportMg,
    convertToVideo,
    applyLibraryToClip,
    applyLibraryToTrack,
  };
}
