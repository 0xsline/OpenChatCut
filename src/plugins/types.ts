// Content plugin (openchatcut-plugin@1) field type and upper limit. Design:docs/plugin-system-design.md.
// Package and distribution format for community DIY content (MG/transition/special effects/LUT/zoom).
// Pure types and constants, keeping Node validation scripts directly executable.
//
// format compatibility policy: only recognize the exact string of PLUGIN_FORMAT; unknown formats will be refused to install
// (see validatePack). In the future, @2 needs to change PLUGIN_FORMAT + migration instructions simultaneously, which is not silently compatible.

export const PLUGIN_FORMAT = 'openchatcut-plugin@1';

/** Installation verification upper limit (third-party content is regarded as untrusted input) */
export const PLUGIN_LIMITS = {
  maxItems: 64,
  maxFragBytes: 64 * 1024,
  maxCodeBytes: 256 * 1024,
  maxCubeBytes: 2 * 1024 * 1024,
  maxProps: 12,
  minEnvelopePoints: 2,
  maxEnvelopePoints: 120,
  /** Upper limit of envelope value range (>1 allows overshoot bounce curve) */
  maxEnvelopeValue: 1.5,
  maxNameLen: 60,
  maxDescLen: 500,
  /** Upper limit of preview image (data URL inline, keep package file self-contained) */
  maxThumbBytes: 128 * 1024,
} as const;

export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const PROP_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/;

/** Adjustable numeric property (identical to CustomTransitionProp / FxNumberProperty) */
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
  /** Preview image: data:image/* Inline (≤128KB) or same-origin/https URL; use the resource library card directly */
  thumb?: string;
}

/** MG template: When applying, the code snapshot is entered into item.code (existing mechanism), and the sandbox is always used during runtime */
export interface PluginMgTemplateItem extends PluginItemBase {
  type: 'mg-template';
  code: string;
  width?: number;
  height?: number;
  durationInFrames?: number;
  props?: Record<string, unknown>;
  /**
   * Optional: Checker field schema (isomorphic to Tpl.propSchema).
   * When omitted, it is automatically inferred from the props value type (string→text, #hex→color, number→number, boolean→boolean).
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

/** Transition: dual input GLSL (u_outgoing/u_incoming/u_progress), snapshot into TransitionItem.customFrag when applied */
export interface PluginTransitionItem extends PluginItemBase {
  type: 'transition';
  frag: string;
  props?: PluginNumberProp[];
  defaultDurationFrames?: number;
}

/** Special effect: single-input GLSL(u_input); when applied, def is written to state.fxDefs self-contained */
export interface PluginFxItem extends PluginItemBase {
  type: 'fx';
  frag: string;
  props?: PluginNumberProp[];
  /** Linear multi-pass (each segment reads the output of the previous segment); DAG pipeline is not supported */
  passes?: string[];
}

/** LUT: .cube file or the same formula color shader in the resource library. */
export interface PluginLutItem extends PluginItemBase {
  type: 'lut';
  cube?: string;
  frag?: string;
  props?: PluginNumberProp[];
}

export type PluginZoomShape =
  | 'hold' | 'punch' | 'slow-push' | 'instant' | 'zoom-out' | 'ease-in' | 'bounce'
  | 'snap' | 'pulse' | 'whip-in';

/** Zoom can reuse the built-in shape, or provide a custom envelope for linear sampling of the entire clip. */
export interface PluginZoomItem extends PluginItemBase {
  type: 'zoom';
  envelope?: number[];
  shape?: PluginZoomShape;
  magnification?: number;
  focalPointX?: number;
  focalPointY?: number;
  easeInFrames?: number;
  easeOutFrames?: number;
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

/** Runtime asset id: is parallel to builtin: / custom: prefix and never conflicts */
export function pluginAssetId(packId: string, itemId: string): string {
  return `plugin:${packId}/${itemId}`;
}

export function isPluginAssetId(id: string): boolean {
  return id.startsWith('plugin:');
}
