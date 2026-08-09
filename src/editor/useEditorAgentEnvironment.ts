import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { AgentContext } from '../agent/context';
import { AUDIO_ASSETS } from '../audio/library';
import { pluginTemplates, usePluginPacks } from '../library/pluginResources';
import { useOfflineMedia } from '../media/useOfflineMedia';
import { loadCreativeMode, saveCreativeMode } from '../persist/projectStore';
import { loadChatAutoApply } from '../persist/sessionPrefs';
import type { SelectedPreviewStatus } from '../gl/previewAdapter';
import { showAppToast } from '../ui/appToast';
import { TEMPLATES } from './initial';
import { planInspectorBatch } from './inspectorBatch';
import type { EditorCommands } from './store';
import type { ProjectDoc, TimelineState } from './types';
import { selectedIdsOf } from './types';

interface EditorAgentEnvironmentOptions {
  state: TimelineState;
  doc: ProjectDoc;
  commands: EditorCommands;
  projectId: string;
  selectedItemId?: string;
  selectedTransitionId?: string;
  getUndoTarget: () => ProjectDoc | null;
  getRedoTarget: () => ProjectDoc | null;
  onRename: (name: string) => void;
  translate: (text: string, params?: Record<string, string | number>) => string;
}

function useLiveRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function useCreativeMode(projectId: string) {
  const [creativeMode, setCreativeMode] = useState<string | null>(null);
  const creativeModeRef = useLiveRef(creativeMode);
  useEffect(() => { loadCreativeMode(projectId).then(setCreativeMode); }, [projectId]);
  const changeCreativeMode = useCallback((id: string | null) => {
    setCreativeMode(id);
    saveCreativeMode(projectId, id);
  }, [projectId]);
  return { creativeMode, creativeModeRef, changeCreativeMode };
}

function useSelectedPreviewStatuses(selectedItemId?: string, selectedTransitionId?: string) {
  const [selectedPreviewStatuses, setSelectedPreviewStatuses] = useState<SelectedPreviewStatus[]>([]);
  const handleSelectedPreviewStatus = useCallback((status: SelectedPreviewStatus) => {
    const expectedTargetId = status.kind === 'effect' ? selectedItemId : selectedTransitionId;
    if (status.phase !== 'inactive' && status.targetId !== expectedTargetId) return;
    setSelectedPreviewStatuses((current) => {
      const withoutTarget = current.filter((entry) => entry.kind !== status.kind || entry.targetId !== status.targetId);
      if (status.phase === 'inactive') return withoutTarget;
      const previous = current.find((entry) => entry.kind === status.kind && entry.targetId === status.targetId);
      if (previous?.adapter === status.adapter
        && previous.phase === status.phase
        && previous.fallbackReason === status.fallbackReason) return current;
      return [...withoutTarget, status];
    });
  }, [selectedItemId, selectedTransitionId]);
  return { selectedPreviewStatuses, setSelectedPreviewStatuses, handleSelectedPreviewStatus };
}

function useAllTemplates() {
  const pluginPacks = usePluginPacks();
  const allTemplates = useMemo(
    () => (pluginPacks.length ? [...TEMPLATES, ...pluginTemplates(pluginPacks)] : TEMPLATES),
    [pluginPacks],
  );
  const allTemplatesRef = useLiveRef(allTemplates);
  return { allTemplates, allTemplatesRef };
}

function useApplyInspectorSelection(
  stateRef: MutableRefObject<TimelineState>,
  commands: EditorCommands,
  translate: EditorAgentEnvironmentOptions['translate'],
) {
  return (
    makeActions: Parameters<typeof planInspectorBatch>[2],
    supports?: Parameters<typeof planInspectorBatch>[3],
    label = 'Inspector multi-edit',
  ): boolean => {
    const snapshot = stateRef.current;
    const ids = selectedIdsOf(snapshot);
    const plan = supports
      ? planInspectorBatch(snapshot, ids, makeActions, supports)
      : planInspectorBatch(snapshot, ids, makeActions);
    if (!plan.ok) {
      showAppToast(translate('无法将此属性应用到全部选中片段。'));
      return false;
    }
    commands.batch(plan.actions, label);
    return true;
  };
}

interface AgentContextOptions {
  commands: EditorCommands;
  projectId: string;
  onRename: (name: string) => void;
  stateRef: MutableRefObject<TimelineState>;
  docRef: MutableRefObject<ProjectDoc>;
  offlineSrcsRef: MutableRefObject<ReadonlySet<string>>;
  creativeModeRef: MutableRefObject<string | null>;
  changeCreativeMode: (id: string | null) => void;
  allTemplatesRef: MutableRefObject<AgentContext['templates']>;
  flushBeforeLeaveRef: MutableRefObject<() => Promise<boolean>>;
  getUndoTarget: () => ProjectDoc | null;
  getRedoTarget: () => ProjectDoc | null;
}

function useAgentContext(options: AgentContextOptions): AgentContext {
  const {
    commands, projectId, onRename, stateRef, docRef, offlineSrcsRef,
    creativeModeRef, changeCreativeMode, allTemplatesRef, flushBeforeLeaveRef,
    getUndoTarget, getRedoTarget,
  } = options;
  return useMemo(() => ({
    commands,
    getState: () => stateRef.current,
    getDoc: () => docRef.current,
    getOfflineMediaSrcs: () => offlineSrcsRef.current,
    getCreativeMode: () => creativeModeRef.current,
    getUndoTarget,
    getRedoTarget,
    getApprovalMode: () => (loadChatAutoApply(projectId) ? 'auto' : 'manual'),
    setCreativeMode: changeCreativeMode,
    get templates() { return allTemplatesRef.current; },
    audio: AUDIO_ASSETS,
    getProjectId: () => projectId,
    openProject: async (nextProjectId: string) => {
      if (!(await flushBeforeLeaveRef.current())) return { ok: false, error: '当前工程保存失败，已阻止切换工程' };
      if (nextProjectId === projectId) return { ok: true };
      window.location.hash = `#/editor/${nextProjectId}`;
      return { ok: true };
    },
    onProjectRenamed: onRename,
  }), [
    commands, projectId, onRename, changeCreativeMode, stateRef, docRef, offlineSrcsRef,
    creativeModeRef, allTemplatesRef, flushBeforeLeaveRef, getUndoTarget, getRedoTarget,
  ]);
}

export function useEditorAgentEnvironment(options: EditorAgentEnvironmentOptions) {
  const { state, doc, commands, projectId, selectedItemId, selectedTransitionId } = options;
  const historyGesture = useMemo(
    () => ({ begin: commands.beginHistoryGesture, end: commands.endHistoryGesture }),
    [commands],
  );
  const stateRef = useLiveRef(state);
  const docRef = useLiveRef(doc);
  const flushBeforeLeaveRef = useRef<() => Promise<boolean>>(async () => true);
  const playerRef = useRef<PlayerRef | null>(null);
  const offlineMedia = useOfflineMedia(doc);
  const creative = useCreativeMode(projectId);
  const previewStatuses = useSelectedPreviewStatuses(selectedItemId, selectedTransitionId);
  const clearPreviewStatuses = previewStatuses.setSelectedPreviewStatuses;
  useEffect(
    () => clearPreviewStatuses([]),
    [projectId, selectedItemId, selectedTransitionId, clearPreviewStatuses],
  );
  const templates = useAllTemplates();
  const applyInspectorSelection = useApplyInspectorSelection(stateRef, commands, options.translate);
  const agentCtx = useAgentContext({
    ...options, stateRef, docRef, flushBeforeLeaveRef, ...offlineMedia, ...creative, ...templates,
  });
  const [previewState, setPreviewState] = useState<TimelineState | null>(null);
  return {
    historyGesture, stateRef, docRef, flushBeforeLeaveRef, playerRef,
    applyInspectorSelection, agentCtx, previewState, setPreviewState,
    ...offlineMedia, ...creative, ...previewStatuses, ...templates,
  };
}
