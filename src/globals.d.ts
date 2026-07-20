// Build-time global injected by Vite `define` in vite.config.ts (computed from
// .env.local key presence — BOOLEANS ONLY, no key value ever reaches the browser).
// Declared here as a GLOBAL ambient (not a module-local `declare const`) so esbuild
// treats it as a free identifier and applies the define replacement; a module-local
// declaration would make esbuild skip it. Undefined outside Vite (tsx checks) — always
// read behind a `typeof … !== 'undefined'` guard. See src/agent/capabilities.ts.
declare const __CONFIGURED_CAPS__: Record<string, boolean> | undefined;
