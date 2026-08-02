import type { TimelineState } from '../editor/types';

/**
 * Remotion requires this value to stay immutable for the mounted Player.
 * Keep a fixed ceiling so moving overlapping clips cannot exhaust the pool or
 * force the Player to remount.
 */
export const PREVIEW_SHARED_AUDIO_TAGS = 32;

/** Peak demand remains useful for diagnostics and non-Player consumers. */
export function previewAudioTagCount(state: TimelineState): number {
  const events: Array<{ frame: number; delta: 1 | -1 }> = [];
  for (const item of state.items) {
    if ((item.kind !== 'audio' && item.kind !== 'video') || !item.src || item.volume === 0) continue;
    const track = state.tracks?.[item.track];
    if (track?.hidden || track?.muted) continue;
    events.push({ frame: item.startFrame, delta: 1 });
    events.push({ frame: item.startFrame + item.durationInFrames, delta: -1 });
  }
  events.sort((a, b) => a.frame - b.frame || a.delta - b.delta);
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.delta;
    peak = Math.max(peak, active);
  }
  return Math.min(PREVIEW_SHARED_AUDIO_TAGS, Math.max(4, peak + 2));
}
