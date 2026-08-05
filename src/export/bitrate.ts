export type VideoBitrateMode = 'auto' | 'compact' | 'recommended' | 'high' | 'custom';

export const MIN_VIDEO_BITRATE_MBPS = 1;
export const MAX_VIDEO_BITRATE_MBPS = 80;
export const DEFAULT_CUSTOM_BITRATE_MBPS = 12;
export const MIN_VIDEO_BITRATE_BPS = MIN_VIDEO_BITRATE_MBPS * 1_000_000;
export const MAX_VIDEO_BITRATE_BPS = MAX_VIDEO_BITRATE_MBPS * 1_000_000;

interface VideoBitrateInput {
  mode: VideoBitrateMode;
  width: number;
  height: number;
  fps: number;
  customMbps: number;
}

/** Soft ceiling for auto bitrate: 4K needs headroom above the old 30 Mbps clamp. */
const AUTO_BITRATE_MAX_BPS = 60_000_000;

function automaticVideoBitrateBps(width: number, height: number, fps: number): number {
  const raw = Math.max(2, width) * Math.max(2, height) * Math.max(1, fps) * 0.16;
  return Math.ceil(Math.max(4_000_000, Math.min(AUTO_BITRATE_MAX_BPS, raw)) / 500_000) * 500_000;
}

function roundedBitrate(value: number): number {
  const clamped = Math.max(
    MIN_VIDEO_BITRATE_BPS,
    Math.min(MAX_VIDEO_BITRATE_BPS, value),
  );
  return Math.round(clamped / 500_000) * 500_000;
}

export function resolveVideoBitrateBps(input: VideoBitrateInput): number {
  const automatic = automaticVideoBitrateBps(input.width, input.height, input.fps);
  if (input.mode === 'compact') return roundedBitrate(automatic * 0.65);
  if (input.mode === 'high') return roundedBitrate(automatic * 1.5);
  if (input.mode === 'custom') return roundedBitrate(input.customMbps * 1_000_000);
  return automatic;
}

export function requestedVideoBitrateBps(input: VideoBitrateInput): number | undefined {
  return input.mode === 'auto' ? undefined : resolveVideoBitrateBps(input);
}
