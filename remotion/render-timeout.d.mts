// render-timeout.mjs stays plain ESM because bare `node` runs it (its verify,
// and the render pipeline imported by the server). This declaration lets the
// browser bundle import the shared per-frame budget from src/export/
// browserExport.ts, so the two render engines cannot drift apart.

/** Per-frame render budget both engines use when nothing overrides it. */
export const DEFAULT_RENDER_TIMEOUT_MS: number;

/**
 * Clamp `raw` (default: `CC_RENDER_TIMEOUT_MS`) into the supported range,
 * falling back to {@link DEFAULT_RENDER_TIMEOUT_MS} when it is not a positive
 * finite number. Node-side only — it reads `process.env`.
 */
export function resolveRenderTimeout(raw?: string | number): number;
