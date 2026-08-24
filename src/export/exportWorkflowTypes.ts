import type { Dispatch, SetStateAction } from 'react';
import type { CaptionsData } from '../captions/types';
import type { ProjectDoc, TimelineItem, TimelineState } from '../editor/types';
import type { ExportQaReport } from './quality';
import type { ExportResolution } from './mediaSettings';
import type { ExportFailure } from './exportFailure';

export type ExportTab = 'video' | 'audio' | 'mg' | 'subtitles' | 'xml' | 'jianying';
export type ExportPhase = 'queued' | 'preparing' | 'rendering' | 'finalizing' | 'verifying' | 'downloading' | 'completed' | 'failed' | 'cancelled';
export type RenderEngine = 'idle' | 'checking' | 'browser' | 'server';
export type Translate = (zh: string, params?: Record<string, string | number>) => string;
export type StateSetter<Value> = Dispatch<SetStateAction<Value>>;
export interface ExportEngineInfo {
  id: string;
  label: string;
  hardware: boolean;
  transport: 'browser' | 'server';
}
export type ExportEngineReason = string | null;


export interface ExportProgress {
  phase: ExportPhase;
  percent: number;
  startedAt: number;
  finishedAt?: number;
  processedFrames?: number;
  totalFrames?: number;
  detail?: string;
  outputSize?: number;
}

export interface ExportQaUiState {
  status: 'running' | 'passed' | 'issues' | 'error';
  attempts: number;
  report?: ExportQaReport;
  evidenceUrl?: string;
  message?: string;
}

export interface ExportJobSnapshot {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  phase?: string;
  processedFrames?: number;
  totalFrames?: number;
  result?: ExportJobResult;
  error?: string;
  failure?: ExportFailure;
}

export interface ExportJobResult {
  path?: string;
  name?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  sourceStartSeconds?: number;
  encoder?: ExportEngineInfo;
  encoderFallbackReason?: string;
}

export interface UseExportWorkflowOptions {
  state: TimelineState;
  /** Full project graph is present for nested-sequence preview/export; legacy callers may omit it. */
  project?: ProjectDoc;
  timelineId?: string;
  projectId: string;
  projectName: string;
  base: string;
  tab: ExportTab;
  codec: 'h264' | 'vp8' | 'prores';
  resolution: ExportResolution;
  fps: number;
  requestedVideoBitrate?: number;
  subtitleFormat: 'srt' | 'txt';
  subtitleCaptions: CaptionsData | null;
  nleFormat: 'fcp_xml' | 'fcp_xml_resolve';
  includeMg: boolean;
  mgItems: TimelineItem[];
  onClose: () => void;
}

export interface WorkflowStateSetters {
  setBusy: StateSetter<string | null>;
  setClock: StateSetter<number>;
  setError: StateSetter<string | null>;
  setFailure: StateSetter<ExportFailure | null>;
  setProgress: StateSetter<ExportProgress | null>;
  setQa: StateSetter<ExportQaUiState | null>;
  setRenderEngine: StateSetter<RenderEngine>;
  setEngineInfo: StateSetter<ExportEngineInfo | null>;
  setEngineReason: StateSetter<ExportEngineReason>;
}

export interface ExportOperationResult {
  targetCommitted: true;
}

export interface WorkflowOperations {
  exportAudio: (signal?: AbortSignal) => Promise<ExportOperationResult | void>;
  exportMg: (signal?: AbortSignal) => Promise<ExportOperationResult | void>;
  exportSubtitles: (signal?: AbortSignal) => Promise<ExportOperationResult | void>;
  exportVideo: (signal?: AbortSignal) => Promise<ExportOperationResult | void>;
  exportXml: (signal?: AbortSignal) => Promise<ExportOperationResult | void>;
}

export interface BrowserAbortRef {
  current: AbortController | null;
}
