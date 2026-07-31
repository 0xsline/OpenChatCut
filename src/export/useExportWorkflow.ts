import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/locale';
import { loadExportAutoQaPreference, saveExportAutoQaPreference } from './autoQa';
import { createArtifactExporters } from './artifactExportOperations';
import { createExportVerifier } from './exportQaOperation';
import { createExportRunner } from './exportRunOperation';
import { createServerExporter } from './serverExportOperation';
import { createVideoExporter } from './videoExportOperation';
import type {
  BrowserAbortRef,
  ExportProgress,
  ExportQaUiState,
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
  }, [busy]);
}

function useWorkflowState() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [renderEngine, setRenderEngine] = useState<RenderEngine>('idle');
  const [qa, setQa] = useState<ExportQaUiState | null>(null);
  useBusyClock(busy, setClock);
  return { busy, clock, error, progress, qa, renderEngine, setBusy, setClock, setError, setProgress, setQa, setRenderEngine };
}

function createWorkflowOperations(
  options: UseExportWorkflowOptions,
  autoQaEnabled: boolean,
  browserAbortRef: BrowserAbortRef,
  setters: WorkflowStateSetters,
  t: Translate,
): WorkflowOperations {
  const verifyCompletedExport = createExportVerifier({ fps: options.fps, state: options.state, t, ...setters });
  const exportServer = createServerExporter({ autoQaEnabled, options, t, verifyCompletedExport, ...setters });
  const artifacts = createArtifactExporters({ options, t, ...setters });
  const exportVideo = createVideoExporter({
    autoQaEnabled,
    browserAbortRef,
    exportServerVideo: () => exportServer('video'),
    options,
    t,
    ...setters,
  });
  return {
    exportAudio: () => exportServer('audio'),
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

export function useExportWorkflow(options: UseExportWorkflowOptions) {
  const t = useT();
  const state = useWorkflowState();
  const browserAbortRef = useRef<AbortController | null>(null);
  const [autoQaEnabled, setAutoQaEnabled] = useState(() => loadExportAutoQaPreference().enabled);
  const setters: WorkflowStateSetters = state;
  const operations = createWorkflowOperations(options, autoQaEnabled, browserAbortRef, setters, t);
  const run = createExportRunner({ busy: state.busy, operations, options, progress: state.progress, t, ...setters });
  return {
    autoQaEnabled,
    busy: state.busy,
    cancelBrowserExport: () => browserAbortRef.current?.abort(),
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
