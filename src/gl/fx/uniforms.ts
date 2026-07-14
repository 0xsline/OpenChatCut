// Pure uniform helpers for per-clip effects — no shader imports, so this is
// runnable under `npx tsx` (the .frag?raw imports live in effects.ts). Mirrors
// the source's gn(name, default, min, max) = clamp(properties[name] ?? default).

export interface FxProperty {
  key: string;   // source property name (properties[key])
  label: string; // zh UI label
  default: number;
  min: number;
  max: number;
  step?: number;
  /** shader uniform name; defaults to `u_<key>`. Set when the source maps a
   * property to a differently-named uniform (e.g. rect-mask width→u_rect_width). */
  uniform?: string;
}

export interface FxDef {
  id: string;    // source assetId (builtin:fx-…)
  name: string;  // source display name
  desc: string;  // source description (zh)
  frag: string;
  props: FxProperty[];
}

// source gn(): clamp(properties[name] ?? default, min, max)
export function fxUniform(p: FxProperty, overrides?: Record<string, number>): number {
  const v = overrides?.[p.key];
  const raw = typeof v === 'number' && Number.isFinite(v) ? v : p.default;
  return Math.min(p.max, Math.max(p.min, raw));
}

/** the uniform map for an effect instance (u_<key> → clamped value) */
export function fxUniforms(def: FxDef, overrides?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.props) out[p.uniform ?? `u_${p.key}`] = fxUniform(p, overrides);
  return out;
}
