// Runtime custom zoom curve registry (plugin zoom entry): Registered when installing/starting hydration,
// edit_item is parsed by plugin: assetId, envelope snapshot is entered into item.zoom (self-contained, same as
// customTransitions idea). PURE — tsx is runnable.
import type { ZoomEffect, ZoomShape } from './types';

export interface CustomZoomDef {
  /** plugin:<pack>/<item> */
  id: string;
  label: string;
  /** 0..1 (can reach 1.5 overshoot) envelope, linear sampling of the entire clip */
  envelope?: number[];
  shape?: ZoomShape;
  magnification?: number;
  focalPointX?: number;
  focalPointY?: number;
  easeInFrames?: number;
  easeOutFrames?: number;
}

const registry = new Map<string, CustomZoomDef>();

export function registerCustomZoom(def: CustomZoomDef): CustomZoomDef {
  registry.set(def.id, def);
  return def;
}

/** Uninstall the plugin scaling curve. */
export function unregisterCustomZoom(id: string): boolean {
  return registry.delete(id);
}

export function getCustomZoom(id: string): CustomZoomDef | undefined {
  return registry.get(id);
}

export function listCustomZooms(): CustomZoomDef[] {
  return [...registry.values()];
}

/** def → item.zoom snapshot (magnification can be overridden by the caller) */
export function zoomFromCustomDef(def: CustomZoomDef, magnification?: number): ZoomEffect {
  return {
    ...(def.envelope ? { envelope: [...def.envelope] } : {}),
    ...(def.shape ? { shape: def.shape } : {}),
    magnification: magnification ?? def.magnification ?? 1.5,
    ...(def.focalPointX !== undefined ? { focalPointX: def.focalPointX } : {}),
    ...(def.focalPointY !== undefined ? { focalPointY: def.focalPointY } : {}),
    ...(def.easeInFrames !== undefined ? { easeInFrames: def.easeInFrames } : {}),
    ...(def.easeOutFrames !== undefined ? { easeOutFrames: def.easeOutFrames } : {}),
    label: def.label,
  };
}

/** Test seam. */
export function __resetCustomZooms(): void {
  registry.clear();
}
