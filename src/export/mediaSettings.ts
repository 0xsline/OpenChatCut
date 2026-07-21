export const EXPORT_RESOLUTIONS = { '480p': 480, '720p': 720, '1080p': 1080 } as const;
export type ExportResolution = keyof typeof EXPORT_RESOLUTIONS;

export const EXPORT_FPS_OPTIONS = [24, 25, 30, 50, 60] as const;

/** Resolution preset -> render scale, based on the shorter canvas side. */
export function exportScale(
  state: { width?: unknown; height?: unknown },
  resolution?: ExportResolution,
): number {
  if (!resolution) return 1;
  const width = Number(state.width) || 1920;
  const height = Number(state.height) || 1080;
  const minSide = Math.max(1, Math.min(width, height));
  return Math.min(4, Math.max(0.1, EXPORT_RESOLUTIONS[resolution] / minSide));
}

export function scaledExportDimensions(
  state: { width?: unknown; height?: unknown },
  resolution?: ExportResolution,
): { width: number; height: number; scale: number } {
  const width = Number(state.width) || 1920;
  const height = Number(state.height) || 1080;
  const scale = exportScale({ width, height }, resolution);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}
