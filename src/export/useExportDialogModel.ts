import { useEffect, useMemo, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { CaptionsData } from '../captions/types';
import type { IconName } from '../components/icons';
import {
  captionTrackEntries,
  type ProjectDoc,
  type TimelineItem,
  type TimelineState,
  type TrackId,
} from '../editor/types';
import { useT } from '../i18n/locale';
import { sanitizeFileName } from '../media/fileName';
import {
  DEFAULT_CUSTOM_BITRATE_MBPS,
  requestedVideoBitrateBps,
  resolveVideoBitrateBps,
  type VideoBitrateMode,
} from './bitrate';
import type { BackgroundExportJob, ExportJobStore } from './backgroundExportStore';
import type { ExportFailure } from './exportFailure';
import { browserScaledExportDimensions } from './browserExport';
import {
  EXPORT_FPS_OPTIONS,
  EXPORT_RESOLUTIONS,
  type ExportResolution,
} from './mediaSettings';
import {
  defaultBitrateModeForQuality,
  exportResolutionForCanvas,
  getQualityMode,
  setQualityMode,
  subscribeQualityMode,
  type QualityMode,
} from '../media/qualityPolicy';
import type { ExportDestination } from './exportDestination';
import type { ExportEngineInfo, ExportEngineReason } from './exportWorkflowTypes';
import {
  effectiveIncludeMg,
  useExportWorkflow,
  type ExportProgress,
  type ExportQaUiState,
  type ExportTab,
  type RenderEngine,
} from './useExportWorkflow';

export const EXPORT_TABS = [
  { key: 'video', label: '成片', summary: 'MP4 / WebM', icon: 'film' },
  { key: 'audio', label: '音轨', summary: 'MP3', icon: 'music' },
  { key: 'mg', label: '动态图层', summary: 'ProRes 4444', icon: 'sparkles' },
  { key: 'subtitles', label: '字幕稿', summary: 'SRT / TXT', icon: 'captions' },
  { key: 'xml', label: '剪辑工程', summary: 'FCPXML', icon: 'clipboard' },
  { key: 'jianying', label: '剪映草稿', summary: 'CapCut / 剪映', icon: 'video' },
] as const satisfies ReadonlyArray<{ key: ExportTab; label: string; summary: string; icon: IconName }>;

export const EXPORT_ACTION_LABELS: Record<ExportTab, string> = {
  video: '导出成片',
  audio: '提取音轨',
  mg: '导出动态图层',
  subtitles: '下载字幕',
  xml: '生成剪辑工程',
  jianying: '导出剪映草稿',
};

export const EXPORT_FPS = [...EXPORT_FPS_OPTIONS];
export const EXPORT_RESOLUTION_OPTIONS = Object.keys(EXPORT_RESOLUTIONS) as ExportResolution[];
export const DEFAULT_INCLUDE_MG = true;

export type ExportVideoCodec = 'h264' | 'vp8' | 'prores';

export interface ExportVideoSettings {
  codec: ExportVideoCodec;
  setCodec: Dispatch<SetStateAction<ExportVideoCodec>>;
  resolution: ExportResolution;
  setResolution: Dispatch<SetStateAction<ExportResolution>>;
  fps: number;
  setFps: Dispatch<SetStateAction<number>>;
  bitrateMode: VideoBitrateMode;
  setBitrateMode: Dispatch<SetStateAction<VideoBitrateMode>>;
  customBitrateMbps: number;
  setCustomBitrateMbps: Dispatch<SetStateAction<number>>;
  dimensions: { width: number; height: number };
  resolvedBitrate: number;
  requestedBitrate: number | undefined;
}

export interface ExportSubtitleSettings {
  tracks: Array<{ id: TrackId; captions: CaptionsData | null }>;
  trackId: string;
  setTrackId: Dispatch<SetStateAction<string>>;
  format: 'srt' | 'txt';
  setFormat: Dispatch<SetStateAction<'srt' | 'txt'>>;
  captions: CaptionsData | null;
}

export interface ExportWorkflowModel {
  autoQaEnabled: boolean;
  busy: string | null;
  cancelExport: () => void;
  chooseDestination: () => Promise<void>;
  choosingDestination: boolean;
  destination: ExportDestination;
  engineInfo: ExportEngineInfo | null;
  engineReason: ExportEngineReason;
  clock: number;
  error: string | null;
  failure: ExportFailure | null;
  jobs: readonly BackgroundExportJob[];
  progress: ExportProgress | null;
  qa: ExportQaUiState | null;
  renderEngine: RenderEngine;
  resetFeedback: () => void;
  selectedJobId: string | null;
  cancelJob: (jobId: string) => void;
  viewJob: (jobId: string | null) => void;
  run: () => Promise<void>;
  toggleAutoQa: (enabled: boolean) => void;
}

export interface ExportDialogModel {
  tab: ExportTab;
  setTab: Dispatch<SetStateAction<ExportTab>>;
  video: ExportVideoSettings;
  subtitles: ExportSubtitleSettings;
  nleFormat: 'fcp_xml' | 'fcp_xml_resolve';
  setNleFormat: Dispatch<SetStateAction<'fcp_xml' | 'fcp_xml_resolve'>>;
  includeMg: boolean;
  setIncludeMg: Dispatch<SetStateAction<boolean>>;
  mgItems: TimelineItem[];
  base: string;
  outputName: string;
  videoSummary: string;
  workflow: ExportWorkflowModel;
  disabled: boolean;
  qualityMode: QualityMode;
  setQualityMode: (mode: QualityMode) => void;
}

function useVideoSettings(state: TimelineState, qualityMode: QualityMode): ExportVideoSettings {
  const [codec, setCodec] = useState<ExportVideoCodec>('h264');
  const [resolution, setResolution] = useState<ExportResolution>(() => exportResolutionForCanvas(state, qualityMode));
  const initialFps = EXPORT_FPS.some((candidate) => candidate === state.fps) ? state.fps : 30;
  const [fps, setFps] = useState(initialFps);
  const [bitrateMode, setBitrateMode] = useState<VideoBitrateMode>(() => defaultBitrateModeForQuality(qualityMode));
  const [customBitrateMbps, setCustomBitrateMbps] = useState(DEFAULT_CUSTOM_BITRATE_MBPS);
  // Re-apply quality defaults when the user toggles balanced ↔ master.
  useEffect(() => {
    setResolution(exportResolutionForCanvas({ width: state.width, height: state.height }, qualityMode));
    setBitrateMode(defaultBitrateModeForQuality(qualityMode));
    // Master quality keeps ProRes available but does not force it (file size).
    setCodec((current) => (qualityMode !== 'master' && current === 'prores' ? 'h264' : current));
  }, [qualityMode, state.width, state.height]);
  const dimensions = browserScaledExportDimensions(state, resolution);
  const bitrateInput = { mode: bitrateMode, ...dimensions, fps, customMbps: customBitrateMbps };
  const resolvedBitrate = resolveVideoBitrateBps(bitrateInput);
  // ProRes is mezzanine: remotion ignores bitrate; do not send a false target.
  const requestedBitrate = codec === 'prores' ? undefined : requestedVideoBitrateBps(bitrateInput);
  return {
    codec, setCodec, resolution, setResolution, fps, setFps, bitrateMode, setBitrateMode,
    customBitrateMbps, setCustomBitrateMbps, dimensions,
    resolvedBitrate,
    requestedBitrate,
  };
}

function useSubtitleSettings(state: TimelineState): ExportSubtitleSettings {
  const tracks = useMemo(() => captionTrackEntries(state).filter((entry) => entry.captions), [state]);
  const [trackId, setTrackId] = useState(tracks[0]?.id ?? '');
  const [format, setFormat] = useState<'srt' | 'txt'>('srt');
  useEffect(() => {
    if (!tracks.some((entry) => entry.id === trackId)) setTrackId(tracks[0]?.id ?? '');
  }, [tracks, trackId]);
  return {
    tracks,
    trackId,
    setTrackId,
    format,
    setFormat,
    captions: tracks.find((entry) => entry.id === trackId)?.captions ?? null,
  };
}

function outputName(base: string, tab: ExportTab, video: ExportVideoSettings, subtitles: ExportSubtitleSettings, nleFormat: 'fcp_xml' | 'fcp_xml_resolve', mgOutput: string): string {
  if (tab === 'video') {
    if (video.codec === 'vp8') return `${base}.webm`;
    if (video.codec === 'prores') return `${base}.mov`;
    return `${base}.mp4`;
  }
  if (tab === 'audio') return `${base}.mp3`;
  if (tab === 'subtitles') return `${base}.${subtitles.format}`;
  if (tab === 'xml') return `${base}-${nleFormat === 'fcp_xml_resolve' ? 'resolve' : 'premiere'}.fcpxml`;
  if (tab === 'jianying') return `${base}-jianying`;
  return mgOutput;
}

export function useExportDialogModel({ state, project, projectId, projectName, exportJobs, onClose }: {
  state: TimelineState;
  project: ProjectDoc;
  projectId: string;
  projectName: string;
  exportJobs: ExportJobStore;
  onClose: () => void;
}): ExportDialogModel {
  const t = useT();
  const [tab, setTab] = useState<ExportTab>('video');
  const qualityMode = useSyncExternalStore(subscribeQualityMode, getQualityMode, getQualityMode);
  const video = useVideoSettings(state, qualityMode);
  const subtitles = useSubtitleSettings(state);
  const [nleFormat, setNleFormat] = useState<'fcp_xml' | 'fcp_xml_resolve'>('fcp_xml');
  const [includeMg, setIncludeMg] = useState(DEFAULT_INCLUDE_MG);
  const mgItems = useMemo(() => state.items.filter((item) => item.kind === 'motion-graphic'), [state.items]);
  const includeAvailableMg = effectiveIncludeMg(includeMg, mgItems);
  const base = sanitizeFileName(projectName, 'export');
  const workflow = useExportWorkflow({
    state, project, timelineId: project.activeTimelineId, projectId, projectName, base, tab, codec: video.codec, resolution: video.resolution,
    fps: video.fps, requestedVideoBitrate: video.requestedBitrate,
    subtitleFormat: subtitles.format, subtitleCaptions: subtitles.captions,
    nleFormat, includeMg: includeAvailableMg, mgItems, onClose,
  }, exportJobs);
  const name = outputName(base, tab, video, subtitles, nleFormat, t('{n} 个透明 MOV 文件', { n: mgItems.length }));
  const qualityTag = qualityMode === 'master' ? ` · ${t('画质优先')}` : '';
  const codecLabel = video.codec === 'prores'
    ? 'MOV · ProRes 422 HQ'
    : video.codec === 'h264' ? 'MP4 · H.264' : 'WebM · VP8';
  const rateLabel = video.codec === 'prores'
    ? t('母带')
    : `${(video.resolvedBitrate / 1_000_000).toFixed(1)} Mbps`;
  const videoSummary = `${codecLabel} · ${video.dimensions.width}×${video.dimensions.height} · ${video.fps} fps · ${rateLabel}${qualityTag}`;
  const disabled = !!workflow.busy
    || (tab === 'subtitles' && !subtitles.captions)
    || (tab === 'mg' && mgItems.length === 0);
  return {
    tab, setTab, video, subtitles, nleFormat, setNleFormat, includeMg, setIncludeMg,
    mgItems, base, outputName: name, videoSummary, workflow, disabled,
    qualityMode, setQualityMode,
  };
}
