// Runtime custom zoom curve registry (plugin zoom entry): registered when installing/starting hydration,
// edit_item is parsed by plugin: assetId, envelope snapshot is entered into item.zoom (self-contained, same as
// customTransitions idea). PURE — tsx is runnable.
import type { ZoomEffect } from './types';

export interface CustomZoomDef {
  /** plugin:<pack>/<item> */
  id: string;
  label: string;
  /** 0..1(Available 1.5 overshoot)envelope,whole paragraph clip linear sampling */
  envelope: number[];
  magnification?: number;
}

const registry = new Map<string, CustomZoomDef>();

export function registerCustomZoom(def: CustomZoomDef): CustomZoomDef {
  registry.set(def.id, def);
  return def;
}

/** Uninstall the plug-in scaling curve. */
export function unregisterCustomZoom(id: string): boolean {
  return registry.delete(id);
}

export function getCustomZoom(id: string): CustomZoomDef | undefined {
  return registry.get(id);
}

export function listCustomZooms(): CustomZoomDef[] {
  return [...registry.values()];
}

/** def → item.zoom Snapshot(magnification Can be overridden by the caller) */
export function zoomFromCustomDef(def: CustomZoomDef, magnification?: number): ZoomEffect {
  return {
    envelope: [...def.envelope],
    magnification: magnification ?? def.magnification ?? 1.5,
    label: def.label,
  };
}

/** Test seam. */
export function __resetCustomZooms(): void {
  registry.clear();
}
