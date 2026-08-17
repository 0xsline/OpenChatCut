import { useCallback, useMemo, useState } from 'react';
import type { MediaAsset } from '../editor/types';

export interface TranscriptViewerState {
  /** Pool assets carrying a non-empty transcript, in display order. */
  transcriptEntries: MediaAsset[];
  /** Currently viewed asset, when the in-page panel is open. */
  viewerAsset: MediaAsset | undefined;
  openTranscriptViewer: (id: string) => void;
  closeTranscriptViewer: () => void;
  /** Step the in-page panel; wraps at both ends. */
  stepViewer: (delta: number) => void;
}

/** Viewer selection state. On the desktop build, `openTranscriptViewer`
 *  hands the entry list to the floating window IPC instead of the in-page
 *  panel; web builds keep the in-page panel. */
export function useTranscriptViewer(assets: MediaAsset[]): TranscriptViewerState {
  const [viewerId, setViewerId] = useState<string | null>(null);
  const transcriptEntries = useMemo(
    () => assets.filter((asset) => (asset.transcript?.length ?? 0) > 0),
    [assets],
  );
  const viewerIndex = viewerId
    ? transcriptEntries.findIndex((asset) => asset.id === viewerId)
    : -1;
  const viewerAsset = viewerIndex >= 0 ? transcriptEntries[viewerIndex] : undefined;
  const openTranscriptViewer = useCallback((id: string) => {
    const desktop = window.openChatCutDesktop;
    if (desktop?.openTranscriptWindow) {
      const index = transcriptEntries.findIndex((asset) => asset.id === id);
      void desktop.openTranscriptWindow({
        entries: transcriptEntries.map((asset) => ({
          id: asset.id,
          name: asset.name,
          transcript: (asset.transcript ?? []).map(({ text, start, end }) => ({ text, start, end })),
        })),
        index: Math.max(0, index),
      }).catch(() => setViewerId(id));
    } else {
      setViewerId(id);
    }
  }, [transcriptEntries]);
  const closeTranscriptViewer = useCallback(() => setViewerId(null), []);
  const stepViewer = useCallback((delta: number) => {
    if (transcriptEntries.length < 2 || viewerIndex < 0) return;
    setViewerId(transcriptEntries[(viewerIndex + delta + transcriptEntries.length) % transcriptEntries.length]!.id);
  }, [transcriptEntries, viewerIndex]);
  return {
    transcriptEntries,
    viewerAsset,
    openTranscriptViewer,
    closeTranscriptViewer,
    stepViewer,
  };
}
