// Master-quality policy: prefer original media on ingest/preview and higher
// fidelity defaults on export. Not bit-exact lossless — master files are not
// overwritten; finished MP4/WebM still re-encodes with a higher quality target.

import type { ExportResolution } from '../export/mediaSettings';
import type { VideoBitrateMode } from '../export/bitrate';

export type QualityMode = 'balanced' | 'master';

export interface QualityPolicy {
  readonly mode: QualityMode;
  /** Never send optimize:true on ingest when master; balanced may later opt in. */
  readonly allowOptimizeOnIngest: boolean;
  /** Compatibility-only normalize (VFR / bad codecs) remains allowed. */
  readonly normalizeOnlyForCompatibility: boolean;
  /** Prefer master src for timeline preview; skip eager proxy fetch. */
  readonly previewPreferMaster: boolean;
  /** Still allow proxy when playback of master fails. */
  readonly allowPreviewProxyFallback: boolean;
  readonly defaultExportResolution: ExportResolution | 'source';
  readonly defaultBitrateMode: VideoBitrateMode;
}

const STORAGE_KEY = 'cc.qualityMode.v1';
const listeners = new Set<() => void>();

let current: QualityMode = readInitial();

function readInitial(): QualityMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'master' || raw === 'balanced') return raw;
  } catch { /* private mode */ }
  return 'balanced';
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function getQualityMode(): QualityMode {
  return current;
}

export function setQualityMode(mode: QualityMode): void {
  if (mode === current) return;
  current = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch { /* ignore */ }
  emit();
}

export function subscribeQualityMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function qualityPolicy(mode: QualityMode = current): QualityPolicy {
  if (mode === 'master') {
    return {
      mode: 'master',
      allowOptimizeOnIngest: false,
      normalizeOnlyForCompatibility: true,
      previewPreferMaster: true,
      allowPreviewProxyFallback: true,
      defaultExportResolution: 'source',
      defaultBitrateMode: 'high',
    };
  }
  return {
    mode: 'balanced',
    allowOptimizeOnIngest: false,
    normalizeOnlyForCompatibility: true,
    previewPreferMaster: false,
    allowPreviewProxyFallback: true,
    defaultExportResolution: 'source',
    defaultBitrateMode: 'auto',
  };
}

/** Map canvas short edge to an export preset; master mode never picks below 1080p for HD+ canvases. */
export function exportResolutionForCanvas(
  state: { width?: number; height?: number },
  mode: QualityMode = current,
): ExportResolution {
  const width = Number(state.width) || 1920;
  const height = Number(state.height) || 1080;
  const minSide = Math.min(width, height);
  if (minSide >= 2160) return '4k';
  if (mode === 'master') {
    if (minSide >= 1080) return '1080p';
    if (minSide >= 720) return '720p';
    return '480p';
  }
  if (minSide <= 480) return '480p';
  if (minSide <= 720) return '720p';
  return '1080p';
}

export function defaultBitrateModeForQuality(mode: QualityMode = current): VideoBitrateMode {
  return qualityPolicy(mode).defaultBitrateMode;
}

/** Master mode: do not eagerly create preview proxies. */
export function shouldAutoRequestPreviewProxy(mode: QualityMode = current): boolean {
  return !qualityPolicy(mode).previewPreferMaster;
}
