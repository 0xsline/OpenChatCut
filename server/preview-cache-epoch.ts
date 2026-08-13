import { basename } from 'node:path';

const epochs = new Map<string, number>();
const FINGERPRINT_MARKER = '.preview-v3-';

export interface PreviewGenerationEpoch {
  sourceName: string;
  value: number;
}

export function capturePreviewGenerationEpoch(path: string): PreviewGenerationEpoch | null {
  const name = basename(path);
  const marker = name.lastIndexOf(FINGERPRINT_MARKER);
  if (marker <= 0) return null;
  const sourceName = name.slice(0, marker);
  return { sourceName, value: epochs.get(sourceName) ?? 0 };
}

export function isPreviewGenerationCurrent(epoch: PreviewGenerationEpoch | null): boolean {
  return !epoch || (epochs.get(epoch.sourceName) ?? 0) === epoch.value;
}

export function invalidatePreviewGenerations(sourceName: string): void {
  const cacheName = sourceName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  epochs.set(cacheName, (epochs.get(cacheName) ?? 0) + 1);
}
