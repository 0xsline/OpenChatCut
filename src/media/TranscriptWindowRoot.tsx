import { useEffect, useMemo, useState } from 'react';
import type { TranscriptWindowPayload } from '../../shared/transcript-window';
import { TranscriptViewerDialog, type TranscriptViewerAsset } from './TranscriptViewerDialog';

/**
 * Desktop-only root for the floating transcript window
 * (`/?transcript-window=1`). Receives the full entry list over IPC and
 * swaps assets locally; closing goes through the window-action channel.
 */
export function TranscriptWindowRoot() {
  const [payload, setPayload] = useState<TranscriptWindowPayload | null>(null);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const desktop = window.openChatCutDesktop;
    if (!desktop?.subscribeTranscriptWindow) return;
    const apply = (next: TranscriptWindowPayload): void => {
      setPayload(next);
      setIndex(Math.min(Math.max(0, Math.round(next.index)), Math.max(0, next.entries.length - 1)));
    };
    // The main process pushes once at did-finish-load, which can precede this
    // effect on a slow machine (React mounts after locale/chunk loads) — that
    // lost push left the window permanently blank. Pull the current payload
    // now that the subscription is in place. A push that lands before the
    // pull resolves is fresher, so the pull then discards its snapshot.
    let live = true;
    let pushed = false;
    const unsubscribe = desktop.subscribeTranscriptWindow((next) => {
      pushed = true;
      apply(next);
    });
    void desktop.requestTranscriptWindowPayload?.().then((current) => {
      if (live && current && !pushed) apply(current);
    });
    return () => { live = false; unsubscribe(); };
  }, []);
  const entries = useMemo<TranscriptViewerAsset[]>(
    () => (payload?.entries ?? []).map((entry) => ({ id: entry.id, name: entry.name, transcript: entry.transcript })),
    [payload],
  );
  const asset = entries[Math.min(index, Math.max(0, entries.length - 1))];
  if (!asset) return null;
  return (
    <TranscriptViewerDialog
      asset={asset}
      entries={entries}
      onClose={() => { void window.openChatCutDesktop?.windowAction('close'); }}
      onStep={(delta) => setIndex((current) => {
        if (entries.length < 2) return current;
        return (current + delta + entries.length) % entries.length;
      })}
    />
  );
}
