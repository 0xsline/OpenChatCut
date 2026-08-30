// Public entry point for per-clip GL effects. The two catalogs live in
// shaderEffects.ts (builtin:fx-*) and lutEffects.ts (log→709 LUTs); this file
// keeps the combined registry, the runtime custom-fx registry and the helpers
// built on them. Everything the catalogs export is re-exported here, so every
// existing `from '.../gl/fx/effects'` import keeps working unchanged.

import lutFrag from './lut.frag?raw';
import type { FxDef, SerializableFxDef } from './uniforms';
import { FX_EFFECTS } from './shaderEffects';
import { LUT_EFFECTS } from './lutEffects';

export type { FxDef, FxProperty } from './uniforms';
export { fxUniform, fxUniforms } from './uniforms';
export { FX_EFFECTS, FX_ORDER, FX_IDS } from './shaderEffects';
export { LUT_EFFECTS, LUT_ORDER, LUT_IDS } from './lutEffects';

// every per-clip GL effect (fx + lut) — ClipFx / agent / inspector resolve here
export const ALL_FX: Record<string, FxDef> = { ...FX_EFFECTS, ...LUT_EFFECTS };

// ── Runtime custom fx (submit_shader's LLM generated product) registry ──────────────────────
// effect-tools.ts captures ALL_FX with "reference" when loading the module (`const FX_EFFECTS = ALL_FX`),
// So just write "in place" to the ALL_FX object, manage_effects' `assetId in FX_EFFECTS`
// Use describe() to instantly find custom fx - no need to change effect-tools.ts. CUSTOM_FXSave another copy
// Customized entries for easy differentiation/enumeration/testing. Built-in fx and LUTs remain unchanged.
// ponytail: The essence of the registry is to share the runtime state. This is the only place where it must be "changed in place" (the only place where it can be changed
// The way effect-tools that captures the reference sees the new fx); the rest still adheres to the immutable contract.
export const CUSTOM_FX: Record<string, FxDef> = {};

/** Generic lut.frag source code (the plugin LUT def is assembled with it + its own .cube URL). */
export const LUT_FRAG = lutFrag;

/** When applying special effects, take the serializable def of non-built-in assetId (plugin:/custom:), along with setItemEffects
 * Snapshot into state.fxDefs - refresh/headless export (no memory registry) to render. The built-in returns null. */
export function serializableDefsFor(effects: Array<{ assetId: string }>): SerializableFxDef[] {
  const out: SerializableFxDef[] = [];
  for (const { assetId } of effects) {
    if (assetId.startsWith('builtin:')) continue;
    const def = ALL_FX[assetId];
    if (!def || def.pipeline) continue;
    out.push({
      id: def.id, name: def.name, desc: def.desc, frag: def.frag, props: def.props,
      ...(def.passes ? { passes: def.passes } : {}),
      ...(def.cube ? { cube: def.cube } : {}),
    });
  }
  return out;
}

/** Register a runtime custom fx: write CUSTOM_FX and merge it into ALL_FX in place for effect-tools to find. */
export function registerCustomFx(def: FxDef): FxDef {
  CUSTOM_FX[def.id] = def;
  ALL_FX[def.id] = def;
  return def;
}

/** Uninstall custom/plugin fx (CUSTOM_FX entry only; built-in not uninstallable). */
export function unregisterCustomFx(id: string): boolean {
  if (!(id in CUSTOM_FX)) return false;
  delete CUSTOM_FX[id];
  delete ALL_FX[id];
  return true;
}
