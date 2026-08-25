import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { PlayerRef } from '@remotion/player';
import type { AgentReference } from '../agent/context';
import { refreshVisualAnalysis } from '../agent/progress/visual-analysis-jobs';
import {
  createExportJobStore,
  type ExportJobStore,
} from '../export/backgroundExportStore';
import { subscribeAgentExportJobs } from '../export/agentExportTracking';
import { resumePersistedServerExports } from '../export/serverExportOperation';
import { useEditorPanelLayout, type EditorPanelLayout } from '../hooks/useEditorPanelLayout';
import { usePersistedState } from '../hooks/usePersistedState';
import type { t as translate } from '../i18n/locale';
import { useAutomaticVersions } from '../persist/useAutomaticVersions';
import { useEditorActions } from '../shortcuts/useEditorActions';
import type { TimelineShortcutApi } from '../shortcuts/timelineApi';
import type { Tpl } from '../types';
import type { EditorCommands } from './store';
import { revisionAfterRelink } from './mediaSourceRevision';
import type { MediaAsset, MediaAssetRelinkPatch, ProjectDoc } from './types';

export interface EditorChatSeed {
  text: string;
  nonce: number;
  references?: AgentReference[];
}

export interface EditorWorkspaceDialogs {
  chatSeed: EditorChatSeed | null;
  setChatSeed: Dispatch<SetStateAction<EditorChatSeed | null>>;
  showDesign: boolean;
  setShowDesign: Dispatch<SetStateAction<boolean>>;
  showVersions: boolean;
  setShowVersions: Dispatch<SetStateAction<boolean>>;
  showShortcuts: boolean;
  setShowShortcuts: Dispatch<SetStateAction<boolean>>;
  showSettings: boolean;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  shortcutApiRef: RefObject<TimelineShortcutApi | null>;
  getPlayhead: () => number;
}

interface EditorWorkspaceDialogsInput {
  projectId: string;
  doc: ProjectDoc;
  playerRef: RefObject<PlayerRef | null>;
}

export function useEditorWorkspaceDialogs({
  projectId,
  doc,
  playerRef,
}: EditorWorkspaceDialogsInput): EditorWorkspaceDialogs {
  const [chatSeed, setChatSeed] = useState<EditorChatSeed | null>(null);
  const [showDesign, setShowDesign] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showVersions, setShowVersions] = useState(false);

  const [showShortcuts, setShowShortcuts] = useState(false);
  const shortcutApiRef = useRef<TimelineShortcutApi | null>(null);
  const getPlayhead = useCallback(() => playerRef.current?.getCurrentFrame() ?? 0, [playerRef]);

  useAutomaticVersions(projectId, doc);

  return {
    chatSeed,
    setChatSeed,
    showDesign,
    setShowDesign,
    showSettings,
    setShowSettings,
    showVersions,
    setShowVersions,
    showShortcuts,
    setShowShortcuts,
    shortcutApiRef,
    getPlayhead,
  };
}

export interface EditorWorkspacePanels {
  chatCollapsed: boolean;
  setChatCollapsed: Dispatch<SetStateAction<boolean>>;
  panelLayout: EditorPanelLayout;
  inspectorCollapsed: boolean;
  setInspectorCollapsed: Dispatch<SetStateAction<boolean>>;
  addTemplate: (template: Tpl) => void;
}

interface EditorWorkspacePanelsInput {
  commands: Pick<EditorCommands, 'addMotionGraphic'>;
}

export function useEditorWorkspacePanels({
  commands,
}: EditorWorkspacePanelsInput): EditorWorkspacePanels {
  const [chatCollapsed, setChatCollapsed] = usePersistedState('cc.chatCollapsed', false);
  const panelLayout = useEditorPanelLayout(chatCollapsed);
  const [inspectorCollapsed, setInspectorCollapsed] = usePersistedState('cc.inspectorCollapsed', false);
  const addTemplate = useCallback((template: Tpl) => commands.addMotionGraphic(template), [commands]);

  return {
    chatCollapsed,
    setChatCollapsed,
    panelLayout,
    inspectorCollapsed,
    setInspectorCollapsed,
    addTemplate,
  };
}

export interface EditorWorkspaceExportActions {
  exportJobs: ExportJobStore;
  activeExportJobs: number;
  exportOpen: boolean;
  setExportOpen: Dispatch<SetStateAction<boolean>>;
  onExport: () => void;
  relinkMediaAsset: (id: string, next: MediaAssetRelinkPatch) => void;
}

interface EditorWorkspaceExportActionsInput {
  commands: EditorCommands;
  docRef: RefObject<ProjectDoc>;
  fps: number;
  projectId: string;
  t: typeof translate;
  shortcutApiRef: RefObject<TimelineShortcutApi | null>;
  setShowDesign: Dispatch<SetStateAction<boolean>>;
  setShowVersions: Dispatch<SetStateAction<boolean>>;
  setShowShortcuts: Dispatch<SetStateAction<boolean>>;
  setChatCollapsed: Dispatch<SetStateAction<boolean>>;
  selectAllTimelineContent: () => void;
}

function useExportJobs(
  projectId: string,
  t: typeof translate,
  commands: EditorCommands,
  docRef: RefObject<ProjectDoc>,
): [ExportJobStore, number] {
  const exportJobs = useMemo(() => createExportJobStore(), []);
  const activeExportJobs = useSyncExternalStore(
    exportJobs.subscribeActive,
    exportJobs.getActiveCount,
    exportJobs.getActiveCount,
  );
  useEffect(() => {
    void resumePersistedServerExports({ exportJobs, projectId, t }).catch((error) => {
      console.warn('[export] failed to restore interrupted server exports', error);
    });
  }, [exportJobs, projectId, t]);
  useEffect(
    () => subscribeAgentExportJobs(projectId, exportJobs, t, {
      commands,
      getDoc: () => docRef.current,
    }),
    [commands, docRef, exportJobs, projectId, t],
  );
  return [exportJobs, activeExportJobs];
}

function relinkedAsset(current: MediaAsset, next: MediaAssetRelinkPatch): MediaAsset {
  const replacement: MediaAsset = {
    ...current,
    src: next.src,
    name: next.name ?? current.name,
    durationInFrames: next.durationInFrames ?? current.durationInFrames,
    width: next.width ?? current.width,
    height: next.height ?? current.height,
    kind: next.kind ?? current.kind,
    sourceRevision: next.sourceRevision,
    sourceContentHash: 'sourceContentHash' in next ? next.sourceContentHash : current.sourceContentHash,
    sourceSize: next.sourceSize,
    sourceModifiedAt: next.sourceModifiedAt,
    sourceFilename: 'sourceFilename' in next ? next.sourceFilename : current.sourceFilename,
    originalFilePath: 'originalFilePath' in next ? next.originalFilePath : current.originalFilePath,
    sourceTimecode: undefined,
    captureClock: undefined,
  };
  return { ...replacement, sourceRevision: revisionAfterRelink(current, replacement) };
}

export function useEditorWorkspaceExportActions(
  input: EditorWorkspaceExportActionsInput,
): EditorWorkspaceExportActions {
  const [exportJobs, activeExportJobs] = useExportJobs(
    input.projectId,
    input.t,
    input.commands,
    input.docRef,
  );
  const [exportOpen, setExportOpen] = useState(false);
  const onExport = useCallback(() => setExportOpen(true), []);
  useEditorActions({
    commands: input.commands,
    docRef: input.docRef,
    fps: input.fps,
    projectId: input.projectId,
    timelineRef: input.shortcutApiRef,
    openExport: onExport,
    openDesign: () => input.setShowDesign(true),
    openHistory: () => input.setShowVersions(true),
    openShortcuts: () => input.setShowShortcuts(true),
    toggleLayout: () => input.setChatCollapsed((value) => !value),
    focusAgent: () => {
      input.setChatCollapsed(false);
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>('[data-cc-chat-composer]')?.focus();
      });
    },
    selectAll: input.selectAllTimelineContent,
  });
  const relinkMediaAsset = useCallback((id: string, next: MediaAssetRelinkPatch) => {
    const current = input.docRef.current.assets.find((asset) => asset.id === id);
    input.commands.relinkMediaAsset(id, next);
    if (!current) return;
    const replacement = relinkedAsset(current, next);
    if (replacement.kind !== 'audio') refreshVisualAnalysis(replacement);
  }, [input.commands, input.docRef]);
  return { exportJobs, activeExportJobs, exportOpen, setExportOpen, onExport, relinkMediaAsset };
}
