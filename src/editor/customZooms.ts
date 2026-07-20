// 运行时自定义缩放曲线注册表(插件 zoom 条目):安装/启动水合时注册,
// edit_item 按 plugin: assetId 解析,envelope 快照进 item.zoom(自包含,同
// customTransitions 思路)。PURE — tsx 可跑。
import type { ZoomEffect } from './types';

export interface CustomZoomDef {
  /** plugin:<pack>/<item> */
  id: string;
  label: string;
  /** 0..1(可到 1.5 过冲)包络,整段 clip 线性采样 */
  envelope: number[];
  magnification?: number;
}

const registry = new Map<string, CustomZoomDef>();

export function registerCustomZoom(def: CustomZoomDef): CustomZoomDef {
  registry.set(def.id, def);
  return def;
}

/** 卸载插件缩放曲线。 */
export function unregisterCustomZoom(id: string): boolean {
  return registry.delete(id);
}

export function getCustomZoom(id: string): CustomZoomDef | undefined {
  return registry.get(id);
}

export function listCustomZooms(): CustomZoomDef[] {
  return [...registry.values()];
}

/** def → item.zoom 快照(magnification 可被调用方覆盖) */
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
