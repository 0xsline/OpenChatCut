import type { Dispatch, SetStateAction } from 'react';
import type { CaptionsData } from '../captions/types';
import type { TimelineItem, TimelineState } from '../editor/types';
import type { ExportQaReport } from './quality';
import type { ExportResolution } from './mediaSettings';

export type ExportTab = 'video' | 'audio' | 'mg' | 'subtitles' | 'xml';
export type ExportPhase = 'queued' | 'preparing' | 'rendering' | 'finalizing' | 'verifying' | 'downloading' | 'completed' | 'failed' | 'cancelled';
export type RenderEngine = 'idle' | 'checking' | 'browser' | 'server';
export type Translate = (zh: string, params?: Record<string, string | number>) => string;
export type StateSetter<Value> = Dispatch<SetStateAction<Value>>;

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
}

export interface UseExportWorkflowOptions {
  state: TimelineState;
  projectName: string;
  base: string;
  tab: ExportTab;
  codec: 'h264' | 'vp8';
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
  setProgress: StateSetter<ExportProgress | null>;
  setQa: StateSetter<ExportQaUiState | null>;
  setRenderEngine: StateSetter<RenderEngine>;
}

export interface WorkflowOperations {
  exportAudio: () => Promise<void>;
  exportMg: () => Promise<void>;
  exportSubtitles: () => void;
  exportVideo: () => Promise<void>;
  exportXml: () => Promise<void>;
}

export interface BrowserAbortRef {
  current: AbortController | null;
}
