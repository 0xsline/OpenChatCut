// Runtime registry for submit_shader-generated custom TRANSITION shaders
// (submit_shader type=transition). PURE — no `.frag?raw` imports — so it loads under tsx.
//
// It is only a BRIDGE: submit_shader registers the generated two-input GLSL + props here and
// returns an id; edit_item adds:[{type:'transition',assetId:'custom:tr-*'}] looks it up and
// COPIES the frag onto the TransitionItem (which the project persists). Rendering reads the
// frag from the ITEM, never from this registry — so a custom transition survives reload
// without any re-registration. (Contrast custom fx, whose registry IS the render source.)

/** One adjustable numeric uniform of a custom transition (becomes u_<key> float). */
export interface CustomTransitionProp {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step?: number; // matches buildProps' FxNumberProperty (optional); only stored, not render-critical
}

export interface CustomTransitionDef {
  /** custom:tr-<slug>-<short> */
  id: string;
  label: string;
  /** two-input transition fragment shader (u_outgoing / u_incoming / u_progress) */
  frag: string;
  props: CustomTransitionProp[];
}

const registry = new Map<string, CustomTransitionDef>();

/** Register a generated custom transition (submit_shader). Overwrites same id. */
export function registerCustomTransition(def: CustomTransitionDef): CustomTransitionDef {
  registry.set(def.id, def);
  return def;
}

/** 卸载自定义/插件转场。 */
export function unregisterCustomTransition(id: string): boolean {
  return registry.delete(id);
}

/** Look one up by id (edit_item transition add resolves the assetId here). */
export function getCustomTransition(id: string): CustomTransitionDef | undefined {
  return registry.get(id);
}

/** 枚举全部已注册自定义/插件转场(browse_library 目录 + 导出为插件用)。 */
export function listCustomTransitions(): CustomTransitionDef[] {
  return [...registry.values()];
}

/** Default uniform map {u_<key>: default} — copied onto the TransitionItem at add time. */
export function customTransitionUniforms(def: CustomTransitionDef): Record<string, number> {
  const u: Record<string, number> = {};
  for (const p of def.props) u[`u_${p.key}`] = p.default;
  return u;
}

/** Test seam. */
export function __resetCustomTransitions(): void {
  registry.clear();
}
