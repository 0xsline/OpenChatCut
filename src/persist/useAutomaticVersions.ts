import { useCallback, useEffect, useRef } from 'react';
import type { ProjectDoc } from '../editor/types';
import { saveAutomaticVersion } from './versionStore';

export const AUTO_VERSION_IDLE_MS = 30_000;
export const AUTO_VERSION_MAX_INTERVAL_MS = 5 * 60_000;

interface CaptureState {
  project: { current: string };
  latestDoc: { current: ProjectDoc };
  dirty: { current: boolean };
  active: { current: Promise<void> | null };
}

function captureAutomaticVersion(state: CaptureState): Promise<void> {
  if (state.active.current) {
    return state.active.current.then(() => captureAutomaticVersion(state));
  }
  if (!state.dirty.current) return Promise.resolve();
  const snapshotProject = state.project.current;
  const snapshot = state.latestDoc.current;
  state.dirty.current = false;
  const run = saveAutomaticVersion(snapshotProject, '自动保存', snapshot).then(
    () => {
      if (state.project.current === snapshotProject && state.latestDoc.current !== snapshot) {
        state.dirty.current = true;
      }
    },
    () => {
      if (state.project.current === snapshotProject) state.dirty.current = true;
    },
  );
  const tracked = run.finally(() => {
    if (state.active.current === tracked) state.active.current = null;
  });
  state.active.current = tracked;
  return tracked;
}

/** Capture changed documents after an idle editing burst and at least every five minutes. */
export function useAutomaticVersions(projectId: string, doc: ProjectDoc): void {
  const project = useRef(projectId);
  const latestDoc = useRef(doc);
  const previousDoc = useRef(doc);
  const dirty = useRef(false);
  const activeCapture = useRef<Promise<void> | null>(null);
  const idleTimer = useRef<number | null>(null);

  const capture = useCallback(() => captureAutomaticVersion({
    project,
    latestDoc,
    dirty,
    active: activeCapture,
  }), []);

  useEffect(() => {
    if (project.current !== projectId) {
      const previousProject = project.current;
      const pendingDoc = latestDoc.current;
      const shouldCapture = dirty.current;
      project.current = projectId;
      latestDoc.current = doc;
      previousDoc.current = doc;
      dirty.current = false;
      clearTimeout(idleTimer.current ?? undefined);
      idleTimer.current = null;
      if (shouldCapture) {
        void saveAutomaticVersion(previousProject, '自动保存', pendingDoc).catch(() => undefined);
      }
      return;
    }
    latestDoc.current = doc;
    if (previousDoc.current === doc) return;
    previousDoc.current = doc;
    dirty.current = true;
    clearTimeout(idleTimer.current ?? undefined);
    idleTimer.current = window.setTimeout(() => void capture(), AUTO_VERSION_IDLE_MS);
  }, [capture, doc, projectId]);

  useEffect(() => {
    const interval = window.setInterval(() => void capture(), AUTO_VERSION_MAX_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [capture]);

  useEffect(() => () => {
    clearTimeout(idleTimer.current ?? undefined);
    void capture();
  }, [capture]);
}
