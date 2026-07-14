// Pure uniform helpers for per-clip effects — no shader imports, so this is
// runnable under `npx tsx` (the .frag?raw imports live in effects.ts). Mirrors
// the source's gn(name, default, min, max) = clamp(properties[name] ?? default).
import type { FxPass, UniformValue } from '../runtime';

interface FxNumberProperty {
  key: string;   // source property name (properties[key])
  label: string; // zh UI label
  kind?: 'number';
  default: number;
  min: number;
  max: number;
  step?: number;
  /** shader uniform name; defaults to `u_<key>`. Set when the source maps a
   * property to a differently-named uniform (e.g. rect-mask width→u_rect_width). */
  uniform?: string;
}

interface FxColorProperty {
  key: string;
  label: string;
  kind: 'color';
  default: number[];
  uniform?: string;
}

export type FxProperty = FxNumberProperty | FxColorProperty;

export interface FxDef {
  id: string;    // source assetId (builtin:fx-…)
  name: string;  // source display name
  desc: string;  // source description (zh)
  frag: string;
  props: FxProperty[];
  /** linear multi-pass effects (tilt-shift): fragment shaders run in
   * order, each reading the previous pass's output. When set, `frag` is the
   * first pass (kept for single-pass callers/back-compat). */
  passes?: string[];
  /** source renderPass graph for effects that reuse an earlier output. */
  pipeline?: (uniforms: Record<string, UniformValue>) => FxPass[];
}

// source gn(): clamp(properties[name] ?? default, min, max)
export function fxUniform(p: FxProperty, overrides?: Record<string, UniformValue>): UniformValue {
  const v = overrides?.[p.key];
  if (p.kind === 'color') {
    return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
      ? v.map((n) => Math.min(1, Math.max(0, n)))
      : [...p.default];
  }
  const raw = typeof v === 'number' && Number.isFinite(v) ? v : p.default;
  return Math.min(p.max, Math.max(p.min, raw));
}

/** the uniform map for an effect instance (u_<key> → clamped value) */
export function fxUniforms(def: FxDef, overrides?: Record<string, UniformValue>): Record<string, UniformValue> {
  const out: Record<string, UniformValue> = {};
  for (const p of def.props) out[p.uniform ?? `u_${p.key}`] = fxUniform(p, overrides);
  return out;
}

/** Flatten effect-local pass graphs into one clip-local chain, rebasing every
 * explicit pass reference so effect N consumes effect N-1's output. */
export function fxPasses(
  effects: Array<{ def: FxDef; overrides?: Record<string, UniformValue> }>,
  time: number,
): FxPass[] {
  const out: FxPass[] = [];
  for (const { def, overrides } of effects) {
    const uniforms = { ...fxUniforms(def, overrides), u_time: time };
    const local: FxPass[] = def.pipeline?.(uniforms)
      ?? def.passes?.map((frag) => ({ frag, uniforms }))
      ?? [{ frag: def.frag, uniforms }];
    const offset = out.length;
    for (const pass of local) {
      out.push({
        ...pass,
        inputFrom: pass.inputFrom == null ? undefined : pass.inputFrom + offset,
        samplers: pass.samplers
          ? Object.fromEntries(Object.entries(pass.samplers).map(([name, index]) => [name, index + offset]))
          : undefined,
      });
    }
  }
  return out;
}
