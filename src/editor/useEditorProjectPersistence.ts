import { useCallback, useEffect, useRef } from 'react';
import type { PlayerRef } from '@remotion/player';
import { enqueueVisualAnalysis } from '../agent/progress/visual-analysis-jobs';
import { useT } from '../i18n/locale';
import { recoverFailedAutosave } from '../persist/autosaveRecovery';
import { acknowledgeIngestedGenerationResults, resumeOpenGenerationJobs } from '../persist/jobRegistryStore';
import {
  flushProjectSaves,
  hasPendingProjectSaves,
  hasProjectSaveFailure,
  saveProject,
} from '../persist/projectStore';
import type { ProjectSaveResult } from '../persist/projectStoreCoordinators';
import { showAppToast } from '../ui/appToast';
import type { EditorCommands } from './store';
import type { ProjectDoc, TimelineState } from './types';

type MutableRef<T> = { current: T };

interface EditorProjectPersistenceOptions {
  projectId: string;
  doc: ProjectDoc;
  commands: Pick<EditorCommands, 'addAsset'>;
  stateRef: MutableRef<TimelineState>;
  docRef: MutableRef<ProjectDoc>;
  playerRef: MutableRef<PlayerRef | null>;
  flushBeforeLeaveRef: MutableRef<() => Promise<boolean>>;
  onHome: () => void;
}

interface PendingSave {
  projectId: string;
  doc: ProjectDoc;
}

function usePendingSaveQueue(): {
  unsavedRef: MutableRef<PendingSave | null>;
  enqueuePendingSave: () => Promise<ProjectSaveResult> | null;
} {
  const t = useT();
  const unsavedRef = useRef<PendingSave | null>(null);
  const latestSaveAttemptRef = useRef(0);
  const saveFailureShownRef = useRef(false);
  const observeSave = useCallback((result: ProjectSaveResult): void => {
    if (result.status === 'failed') {
      if (!saveFailureShownRef.current) {
        showAppToast(t('工程保存失败。请重试；在保存成功前不会关闭或切换工程。'), { error: true });
        saveFailureShownRef.current = true;
      }
      return;
    }
    saveFailureShownRef.current = false;
  }, [t]);
  const enqueuePendingSave = useCallback((): Promise<ProjectSaveResult> | null => {
    const pending = unsavedRef.current;
    if (!pending) return null;
    unsavedRef.current = null;
    const attempt = ++latestSaveAttemptRef.current;
    const saving = saveProject(pending.projectId, pending.doc);
    void saving.then((result) => {
      if (result.status === 'failed') {
        unsavedRef.current = recoverFailedAutosave({
          currentUnsaved: unsavedRef.current,
          failedSnapshot: pending,
          failedAttempt: attempt,
          latestEnqueuedAttempt: latestSaveAttemptRef.current,
        });
      } else if (result.status === 'saved') {
        void acknowledgeIngestedGenerationResults(pending.projectId, pending.doc.assets ?? []);
      }
      observeSave(result);
    });
    return saving;
  }, [observeSave]);
  return { unsavedRef, enqueuePendingSave };
}

function useEditorAutosave(projectId: string, doc: ProjectDoc): () => Promise<boolean> {
  const t = useT();
  const { unsavedRef, enqueuePendingSave } = usePendingSaveQueue();
  useEffect(() => {
    unsavedRef.current = { projectId, doc };
    const timer = setTimeout(() => { enqueuePendingSave(); }, 500);
    return () => clearTimeout(timer);
  }, [doc, enqueuePendingSave, projectId, unsavedRef]);
  const flushBeforeLeave = useCallback(async (): Promise<boolean> => {
    enqueuePendingSave();
    const result = await flushProjectSaves(projectId);
    if (!result.ok) {
      showAppToast(t('工程仍未保存，已阻止离开。请继续编辑以重试保存。'), { error: true });
      return false;
    }
    return true;
  }, [enqueuePendingSave, projectId, t]);
  useBrowserSaveGuards(projectId, enqueuePendingSave);
  return flushBeforeLeave;
}

function useBrowserSaveGuards(projectId: string, enqueuePendingSave: () => unknown): void {
  useEffect(() => {
    const flushWithoutWaiting = (): void => {
      enqueuePendingSave();
      void flushProjectSaves(projectId);
    };
    const blockUnfinishedSave = (event: BeforeUnloadEvent): void => {
      enqueuePendingSave();
      if (!hasPendingProjectSaves(projectId) && !hasProjectSaveFailure(projectId)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', blockUnfinishedSave);
    window.addEventListener('pagehide', flushWithoutWaiting);
    return () => {
      window.removeEventListener('beforeunload', blockUnfinishedSave);
      window.removeEventListener('pagehide', flushWithoutWaiting);
      flushWithoutWaiting();
    };
  }, [enqueuePendingSave, projectId]);
}

function useGenerationJobResume(
  projectId: string,
  commands: Pick<EditorCommands, 'addAsset'>,
  stateRef: MutableRef<TimelineState>,
  docRef: MutableRef<ProjectDoc>,
): void {
  useEffect(() => {
    let alive = true;
    void (async () => {
      await acknowledgeIngestedGenerationResults(projectId, docRef.current.assets ?? []).catch(() => undefined);
      if (!alive) return;
      await resumeOpenGenerationJobs(projectId, {
        getState: () => stateRef.current,
        onAsset: (asset) => {
          if (!alive) return;
          if ((docRef.current.assets ?? []).some((candidate) => candidate.id === asset.id || candidate.src === asset.src)) return;
          commands.addAsset(asset);
          if (asset.kind !== 'audio') enqueueVisualAnalysis(asset);
        },
        timeoutSeconds: 180,
      });
    })();
    return () => { alive = false; };
  }, [projectId, commands, stateRef, docRef]);
}

function useActiveTimelineSeek(activeTimelineId: string, playerRef: MutableRef<PlayerRef | null>): void {
  const firstTimelineRef = useRef(true);
  useEffect(() => {
    if (firstTimelineRef.current) {
      firstTimelineRef.current = false;
      return;
    }
    playerRef.current?.seekTo(0);
  }, [activeTimelineId, playerRef]);
}

export function useEditorProjectPersistence({
  projectId,
  doc,
  commands,
  stateRef,
  docRef,
  playerRef,
  flushBeforeLeaveRef,
  onHome,
}: EditorProjectPersistenceOptions): { handleHome: () => Promise<void> } {
  const flushBeforeLeave = useEditorAutosave(projectId, doc);
  flushBeforeLeaveRef.current = flushBeforeLeave;
  useGenerationJobResume(projectId, commands, stateRef, docRef);
  useActiveTimelineSeek(doc.activeTimelineId, playerRef);

  const handleHome = useCallback(async (): Promise<void> => {
    if (await flushBeforeLeave()) onHome();
  }, [flushBeforeLeave, onHome]);

  return { handleHome };
}
