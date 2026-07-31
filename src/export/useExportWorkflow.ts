import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/locale';
import { loadExportAutoQaPreference, saveExportAutoQaPreference } from './autoQa';
import { createArtifactExporters } from './artifactExportOperations';
import { createExportVerifier } from './exportQaOperation';
import { createExportRunner } from './exportRunOperation';
import { ensureExportDestinationWritable, exportDestinationErrorMessage } from './exportDestination';
import { createServerExporter } from './serverExportOperation';
import { createVideoExporter } from './videoExportOperation';
import { useExportDestination } from './useExportDestination';
import type {
  BrowserAbortRef,
  ExportProgress,
  ExportQaUiState,
  ExportEngineInfo,
  ExportEngineReason,
  RenderEngine,
  StateSetter,
  Translate,
  UseExportWorkflowOptions,
  WorkflowOperations,
  WorkflowStateSetters,
} from './exportWorkflowTypes';

export type {
  ExportPhase,
  ExportProgress,
  ExportQaUiState,
  ExportTab,
  RenderEngine,
} from './exportWorkflowTypes';

function useBusyClock(busy: string | null, setClock: StateSetter<number>): void {
  useEffect(() => {
    if (!busy) return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy, setClock]);
}

function useWorkflowState() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [renderEngine, setRenderEngine] = useState<RenderEngine>('idle');
  const [qa, setQa] = useState<ExportQaUiState | null>(null);
  const [engineInfo, setEngineInfo] = useState<ExportEngineInfo | null>(null);
  const [engineReason, setEngineReason] = useState<ExportEngineReason>(null);
  useBusyClock(busy, setClock);
  return {
    busy, clock, engineInfo, engineReason, error, progress, qa, renderEngine,
    setBusy, setClock, setEngineInfo, setEngineReason, setError, setProgress, setQa, setRenderEngine,
  };
}

function createWorkflowOperations(
  options: UseExportWorkflowOptions,
  autoQaEnabled: boolean,
  browserAbortRef: BrowserAbortRef,
  destination: ReturnType<typeof useExportDestination>['destination'],
  setters: WorkflowStateSetters,
  t: Translate,
): WorkflowOperations {
  const verifyCompletedExport = createExportVerifier({ fps: options.fps, state: options.state, t, ...setters });
  const exportServer = createServerExporter({ autoQaEnabled, destination, options, t, verifyCompletedExport, ...setters });
  const artifacts = createArtifactExporters({ destination, options, t, ...setters });
  const exportVideo = createVideoExporter({
    autoQaEnabled,
    browserAbortRef,
    destination,
    exportServerVideo: (signal) => exportServer('video', signal),
    options,
    verifyCompletedExport,
    t,
    ...setters,
  });
  return {
    exportAudio: async () => { await exportServer('audio'); },
    exportMg: artifacts.exportMg,
    exportSubtitles: artifacts.exportSubtitles,
    exportVideo,
    exportXml: artifacts.exportXml,
  };
}

function createAutoQaToggle(
  setAutoQaEnabled: StateSetter<boolean>,
  setQa: StateSetter<ExportQaUiState | null>,
) {
  return (enabled: boolean) => {
    setAutoQaEnabled(enabled);
    saveExportAutoQaPreference({ enabled });
    if (!enabled) setQa(null);
  };
}

function createResetFeedback(setters: WorkflowStateSetters) {
  return () => {
    setters.setError(null);
    setters.setProgress(null);
    setters.setQa(null);
  };
}

function suggestedExportFilename(options: UseExportWorkflowOptions): string | undefined {
  if (options.tab === 'video') return `${options.base}.${options.codec === 'vp8' ? 'webm' : 'mp4'}`;
  if (options.tab === 'audio') return `${options.base}.mp3`;
  if (options.tab === 'subtitles') return `${options.base}.${options.subtitleFormat}`;
  if (options.tab === 'xml' && !options.includeMg) {
    const suffix = options.nleFormat === 'fcp_xml_resolve' ? 'resolve' : 'premiere';
    return `${options.base}-${suffix}.fcpxml`;
  }
  return undefined;
}

export function useExportWorkflow(options: UseExportWorkflowOptions) {
  const t = useT();
  const state = useWorkflowState();
  const browserAbortRef = useRef<AbortController | null>(null);
  const [autoQaEnabled, setAutoQaEnabled] = useState(() => loadExportAutoQaPreference().enabled);
  const destinationState = useExportDestination(suggestedExportFilename(options));
  const setters: WorkflowStateSetters = state;
  const operations = createWorkflowOperations(options, autoQaEnabled, browserAbortRef, destinationState.destination, setters, t);
  const run = createExportRunner({
    busy: state.busy,
    operations,
    options,
    prepareDestination: () => ensureExportDestinationWritable(destinationState.destination),
    progress: state.progress,
    t,
    ...setters,
  });
  const chooseDestination = async () => {
    state.setError(null);
    try {
      await destinationState.chooseDestination();
    } catch (reason) {
      state.setError(exportDestinationErrorMessage(reason, t));
    }
  };
  return {
    autoQaEnabled,
    busy: state.busy,
    chooseDestination,
    choosingDestination: destinationState.choosingDestination,
    destination: destinationState.destination,
    engineInfo: state.engineInfo,
    engineReason: state.engineReason,
    cancelExport: () => browserAbortRef.current?.abort(),
    clock: state.clock,
    error: state.error,
    progress: state.progress,
    qa: state.qa,
    renderEngine: state.renderEngine,
    resetFeedback: createResetFeedback(setters),
    run,
    toggleAutoQa: createAutoQaToggle(setAutoQaEnabled, state.setQa),
  };
}
