// Per-frame render budget, shared by BOTH engines: the local renderer here and
// the browser fast-export path (src/export/browserExport.ts imports the
// constant). A source that takes 40s to open must not succeed on one engine and
// fail on the other.
//
// This bounds a SINGLE frame's async work — extracting a frame, loading a font,
// decoding an image — not the export as a whole. A 76k-frame export runs for as
// long as it needs; only a frame that produces nothing at all trips this.
//
// The budget exists to catch a HANG, not to police slowness. A delayRender()
// handle that is never cleared (a decoder that fails silently, a media read
// that never settles, a lost WebGL context) would otherwise freeze the export
// at N% forever with no error. Remotion's automatic one-shot frame retry is
// also triggered by this timeout, so removing it would remove the retry that
// rescues transient decode failures.
//
// Ten minutes is therefore deliberate: a frame with no data after ten minutes
// is hung, not slow, while genuinely expensive frames (8K sources, software
// HEVC, deep LUT chains, cold spinning disks) finish well inside it. The old
// 120s default was tight enough to fail exports that would have completed.
//
// Keep this module dependency-free and free of module-scope `process` access —
// it is imported into browser code.
export const DEFAULT_RENDER_TIMEOUT_MS = 600_000;
const MIN_RENDER_TIMEOUT_MS = 30_000;
// An hour is past any plausible legitimate frame, so the override stays a real
// escape hatch in both directions rather than being capped at the default.
const MAX_RENDER_TIMEOUT_MS = 3_600_000;

/** Keep slow local initialization recoverable without allowing an unbounded hang. */
export function resolveRenderTimeout(raw = process.env.CC_RENDER_TIMEOUT_MS) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RENDER_TIMEOUT_MS;
  return Math.min(MAX_RENDER_TIMEOUT_MS, Math.max(MIN_RENDER_TIMEOUT_MS, Math.round(parsed)));
}
