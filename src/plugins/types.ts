// Content plug-in (openchatcut-plugin@1) field type and upper limit. Design:docs/plugin-system-design.md.
// Packaged distribution format for community DIY content (MG/transitions/special effects/LUTs/scaling).
// Pure types and constants keep Node validation scripts directly executable.
//
// format compatibility policy: only recognize the exact string PLUGIN_FORMAT; unknown formats will be refused to install
// (See validatePack). In the future, @2 needs to change PLUGIN_FORMAT + migration instructions simultaneously, which is not silently compatible.

export const PLUGIN_FORMAT = 'openchatcut-plugin@1';

/** Installation verification cap(Third-party content is considered untrusted input) */
export const PLUGIN_LIMITS = {
  maxItems: 64,
  maxFragBytes: 64 * 1024,
  maxCodeBytes: 256 * 1024,
  maxCubeBytes: 2 * 1024 * 1024,
  maxProps: 12,
  minEnvelopePoints: 2,
  maxEnvelopePoints: 120,
  /** Envelope value range upper limit(>1 Allow overshoot bounce curve) */
  maxEnvelopeValue: 1.5,
  maxNameLen: 60,
  maxDescLen: 500,
  /** Maximum preview image(data URL inline,Keep package files self-contained) */
  maxThumbBytes: 128 * 1024,
} as const;

export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const PROP_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/;

/** Adjustable numeric properties(with CustomTransitionProp / FxNumberProperty isomorphism) */
export interface PluginNumberProp {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step?: number;
}

interface PluginItemBase {
  id: string;
  name: string;
  desc?: string;
  /** Preview:data:image/* inline(≤128KB)or homologous/https URL;Use the resource library card directly */
  thumb?: string;
}

/** MG Template:When applying code Snapshot into item.code(Existing mechanism),Always run in the sandbox */
export interface PluginMgTemplateItem extends PluginItemBase {
  type: 'mg-template';
  code: string;
  width?: number;
  height?: number;
  props?: Record<string, unknown>;
  /**
   * Optional:Inspector field schema(with Tpl.propSchema isomorphism)。
   * Reason for omitting props Value type automatic inference(string→text, #hex→color, number→number, boolean→boolean)。
   */
  propSchema?: Array<{
    key: string;
    type: string;
    defaultValue?: unknown;
    label?: string;
    min?: number;
    max?: number;
    step?: number;
  }>;
}

/** Transition:Dual input GLSL(u_outgoing/u_incoming/u_progress),Snapshot when applying TransitionItem.customFrag */
export interface PluginTransitionItem extends PluginItemBase {
  type: 'transition';
  frag: string;
  props?: PluginNumberProp[];
  defaultDurationFrames?: number;
}

/** special effects:single input GLSL(u_input);When applying def write state.fxDefs self contained */
export interface PluginFxItem extends PluginItemBase {
  type: 'fx';
  frag: string;
  props?: PluginNumberProp[];
  /** More linear pass(Read the output of the previous paragraph in each paragraph);Not supported DAG pipeline */
  passes?: string[];
}

/** LUT:.cube text;Uploaded during installation /media/uploads File,def.cube remember URL */
export interface PluginLutItem extends PluginItemBase {
  type: 'lut';
  cube: string;
}

/** scaling curve:0..1 normalized envelope,whole paragraph clip linear sampling(ZoomEffect.envelope) */
export interface PluginZoomItem extends PluginItemBase {
  type: 'zoom';
  envelope: number[];
  magnification?: number;
}

export type PluginItem =
  | PluginMgTemplateItem
  | PluginTransitionItem
  | PluginFxItem
  | PluginLutItem
  | PluginZoomItem;

export interface PluginPack {
  format: typeof PLUGIN_FORMAT;
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  items: PluginItem[];
}

/** runtime assets id:with builtin: / custom: Parallel prefixes,Never conflict */
export function pluginAssetId(packId: string, itemId: string): string {
  return `plugin:${packId}/${itemId}`;
}

export function isPluginAssetId(id: string): boolean {
  return id.startsWith('plugin:');
}
