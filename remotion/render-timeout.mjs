const DEFAULT_RENDER_TIMEOUT_MS = 120_000;
const MIN_RENDER_TIMEOUT_MS = 30_000;
const MAX_RENDER_TIMEOUT_MS = 600_000;

/** Keep slow local initialization recoverable without allowing an unbounded hang. */
export function resolveRenderTimeout(raw = process.env.CC_RENDER_TIMEOUT_MS) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RENDER_TIMEOUT_MS;
  return Math.min(MAX_RENDER_TIMEOUT_MS, Math.max(MIN_RENDER_TIMEOUT_MS, Math.round(parsed)));
}
