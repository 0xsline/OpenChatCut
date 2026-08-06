import { useRef, useState, useSyncExternalStore } from 'react';
import { useT } from '../i18n/locale';
import { loadExportAutoQaPreference, saveExportAutoQaPreference } from './autoQa';
import { createArtifactExporters } from './artifactExportOperations';
import {
  type BackgroundExportJobSetters,
  type ExportJobStore,
} from './backgroundExportStore';
import { createExportVerifier } from './exportQaOperation';
import { createExportRunner } from './exportRunOperation';
import {
  ensureExportDestinationWritable,
  exportDestinationErrorMessage,
  exportDestinationTargetPath,
} from './exportDestination';
import type { ExportDestination } from './exportDestination';
import { immutableExportSnapshot } from './exportMediaPlan';
import { materializeBlobMedia } from './materializeBlobMedia';
import { createServerExporter } from './serverExportOperation';
import { createVideoExporter } from './videoExportOperation';
import { useExportDestination } from './useExportDestination';
import type {
  BrowserAbortRef,
  ExportEngineInfo,
  ExportOperationResult,
  ExportEngineReason,
  ExportProgress,
  ExportQaUiState,
  RenderEngine,
  Translate,
  UseExportWorkflowOptions,
  WorkflowOperations,
} from './exportWorkflowTypes';

export type {
  ExportPhase,
  ExportProgress,
  ExportQaUiState,
  ExportTab,
  RenderEngine,
} from './exportWorkflowTypes';

const COMMITTED_EXPORT = Object.freeze({ targetCommitted: true }) satisfies ExportOperationResult;

export function effectiveIncludeMg(
  includeMg: boolean,
  mgItems: ReadonlyArray<unknown>,
): boolean {
  return includeMg && mgItems.length > 0;
}

function createWorkflowOperations(
  options: UseExportWorkflowOptions,
  autoQaEnabled: boolean,
  browserAbortRef: BrowserAbortRef,
  destination: ExportDestination,
  setters: BackgroundExportJobSetters,
  targetPath: string,
  t: Translate,
): WorkflowOperations {
  const verifyCompletedExport = createExportVerifier({ fps: options.fps, state: options.state, t, ...setters });
  const exportServer = createServerExporter({
    autoQaEnabled,
    destination,
    options,
    targetPath,
    t,
    verifyCompletedExport,
    ...setters,
  });
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
    exportAudio: async (signal) => { await exportServer('audio', signal); return COMMITTED_EXPORT; },
    exportMg: async (signal) => { await artifacts.exportMg(signal); return COMMITTED_EXPORT; },
    exportSubtitles: async (signal) => { await artifacts.exportSubtitles(signal); return COMMITTED_EXPORT; },
    exportVideo: async (signal) => { await exportVideo(signal); return COMMITTED_EXPORT; },
    exportXml: async (signal) => { await artifacts.exportXml(signal); return COMMITTED_EXPORT; },
  };
}

export function suggestedExportFilename(options: UseExportWorkflowOptions): string | undefined {
  if (options.tab === 'video') return `${options.base}.${options.codec === 'vp8' ? 'webm' : 'mp4'}`;
  if (options.tab === 'audio') return `${options.base}.mp3`;
  if (options.tab === 'subtitles') return `${options.base}.${options.subtitleFormat}`;
  if (options.tab === 'xml' && !effectiveIncludeMg(options.includeMg, options.mgItems)) {
    const suffix = options.nleFormat === 'fcp_xml_resolve' ? 'resolve' : 'premiere';
    return `${options.base}-${suffix}.fcpxml`;
  }
  return undefined;
}

function snapshotWorkflowOptions(options: UseExportWorkflowOptions): UseExportWorkflowOptions {
  return Object.freeze({
    ...options,
    includeMg: effectiveIncludeMg(options.includeMg, options.mgItems),
    state: immutableExportSnapshot(options.state),
    ...(options.project ? { project: immutableExportSnapshot(options.project) } : {}),
    subtitleCaptions: immutableExportSnapshot(options.subtitleCaptions),
    mgItems: immutableExportSnapshot(options.mgItems),
  });
}

const EMPTY_WORKFLOW = {
  busy: null,
  clock: 0,
  engineInfo: null,
  engineReason: null,
  error: null,
  failure: null,
  progress: null,
  qa: null,
  renderEngine: 'idle',
} satisfies {
  busy: string | null;
  clock: number;
  engineInfo: ExportEngineInfo | null;
  engineReason: ExportEngineReason;
  error: string | null;
  failure: null;
  progress: ExportProgress | null;
  qa: ExportQaUiState | null;
  renderEngine: RenderEngine;
};

export function useExportWorkflow(options: UseExportWorkflowOptions, exportJobs: ExportJobStore) {
  const t = useT();
  const initialJobs = exportJobs.getSnapshot().jobs;
  const [viewedJobId, setViewedJobId] = useState<string | null>(() => initialJobs.at(-1)?.id ?? null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const browserAbortRef = useRef<AbortController | null>(null);
  const [autoQaEnabled, setAutoQaEnabled] = useState(() => loadExportAutoQaPreference().enabled);
  const destinationState = useExportDestination(suggestedExportFilename(options));
  const jobSnapshot = useSyncExternalStore(exportJobs.subscribe, exportJobs.getSnapshot, exportJobs.getSnapshot);
  const viewedJob = viewedJobId ? jobSnapshot.jobs.find((job) => job.id === viewedJobId) : undefined;
  const state = viewedJob ?? EMPTY_WORKFLOW;

  const run = async () => {
    if (state.busy) return;
    if (state.progress?.phase === 'completed') {
      options.onClose();
      return;
    }
    const filename = suggestedExportFilename(options) ?? `${options.base}-${options.tab}`;
    let targetPath: string;
    try {
      targetPath = exportDestinationTargetPath(destinationState.destination, filename);
    } catch (error) {
      setSetupError(exportDestinationErrorMessage(error, t));
      return;
    }
    setSetupError(null);
    let capturedOptions = snapshotWorkflowOptions(options);
    // Blob placeholders (incomplete imports) are invisible to the Node renderer;
    // re-publish any still-readable blob media to the server before submitting.
    try {
      const materialized = await materializeBlobMedia(capturedOptions, {});
      capturedOptions = materialized.snapshot;
    } catch (error) {
      setSetupError(exportDestinationErrorMessage(error, t));
      return;
    }
    const capturedDestination = destinationState.destination;
    const jobId = exportJobs.start({
      label: filename,
      targetPath,
      async execute({ signal, setters }) {
        const operations = createWorkflowOperations(
          capturedOptions,
          autoQaEnabled,
          browserAbortRef,
          capturedDestination,
          setters,
          targetPath,
          t,
        );
        const execute = createExportRunner({
          busy: null,
          operations,
          options: capturedOptions,
          prepareDestination: () => ensureExportDestinationWritable(capturedDestination),
          progress: null,
          signal,
          targetPath,
          t,
          ...setters,
        });
        await execute();
      },
    });
    setViewedJobId(jobId);
  };
  const chooseDestination = async () => {
    setSetupError(null);
    try {
      await destinationState.chooseDestination();
    } catch (reason) {
      setSetupError(exportDestinationErrorMessage(reason, t));
    }
  };
  const toggleAutoQa = (enabled: boolean) => {
    setAutoQaEnabled(enabled);
    saveExportAutoQaPreference({ enabled });
  };

  return {
    autoQaEnabled,
    busy: state.busy,
    chooseDestination,
    choosingDestination: destinationState.choosingDestination,
    destination: destinationState.destination,
    engineInfo: state.engineInfo,
    engineReason: state.engineReason,
    cancelExport: () => {
      if (viewedJobId) exportJobs.cancel(viewedJobId);
      browserAbortRef.current?.abort();
    },
    cancelJob: (jobId: string) => { exportJobs.cancel(jobId); },
    clock: state.clock || Date.now(),
    error: state.error ?? setupError,
    failure: state.failure,
    jobs: jobSnapshot.jobs,
    progress: state.progress,
    qa: state.qa,
    renderEngine: state.renderEngine,
    resetFeedback: () => {
      setSetupError(null);
      setViewedJobId(null);
    },
    run,
    selectedJobId: viewedJobId,
    toggleAutoQa,
    viewJob: setViewedJobId,
  };
}
