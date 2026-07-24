import { useEffect, useState } from 'react';
import type { ZoomEffect } from '../editor/types';
import { listPacks, subscribePlugins, type InstalledPack } from '../plugins/store';
import { pluginAssetId } from '../plugins/types';
import type { PropSpec, Tpl } from '../types';
import type { ResourceItem } from './ResourceBrowser';

/** Live list of installed extensions(Installation/Uninstall automatic refresh) */
export function usePluginPacks(): InstalledPack[] {
  const [packs, setPacks] = useState<InstalledPack[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { void listPacks().then((next) => { if (alive) setPacks(next); }); };
    load();
    const unsubscribe = subscribePlugins(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return packs;
}

/** extended items → Resource card list(Transition/special effects/LUT/Zoom tab For merging) */
export function pluginResourceItems(
  packs: InstalledPack[],
  type: 'fx' | 'lut' | 'transition' | 'zoom',
): ResourceItem[] {
  const out: ResourceItem[] = [];
  for (const pack of packs) {
    if (!pack.enabled) continue;
    for (const item of pack.items) {
      if (item.type !== type) continue;
      out.push({
        id: pluginAssetId(pack.id, item.id),
        name: item.name,
        badge: 'Expand',
        ...(item.thumb ? { thumb: item.thumb } : {}),
        ...(item.type === 'zoom'
          ? { data: { envelope: item.envelope, magnification: item.magnification ?? 1.5, label: item.name } }
          : {}),
      });
    }
  }
  return out;
}

/** from props Default value inference checker schema(None propSchema fall back in time) */
function inferPropSchema(props: Record<string, unknown>): PropSpec[] {
  const out: PropSpec[] = [];
  for (const [key, val] of Object.entries(props)) {
    if (typeof val === 'number' && Number.isFinite(val)) {
      out.push({ key, type: 'number', defaultValue: val, label: key });
    } else if (typeof val === 'boolean') {
      out.push({ key, type: 'boolean', defaultValue: val, label: key });
    } else if (typeof val === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(val)) {
      out.push({ key, type: 'color', defaultValue: val, label: key });
    } else {
      out.push({ key, type: 'text', defaultValue: val ?? '', label: key });
    }
  }
  return out;
}

function schemaFromMgItem(item: {
  props?: Record<string, unknown>;
  propSchema?: Array<{
    key: string;
    type: string;
    defaultValue?: unknown;
    label?: string;
    min?: number;
    max?: number;
    step?: number;
  }>;
}): PropSpec[] {
  const props = item.props ?? {};
  if (!item.propSchema?.length) return inferPropSchema(props);
  return item.propSchema.map((schema) => ({
    key: schema.key,
    type: schema.type,
    defaultValue: schema.defaultValue ?? props[schema.key] ?? '',
    ...(schema.label ? { label: schema.label } : {}),
    ...(schema.min !== undefined ? { min: schema.min } : {}),
    ...(schema.max !== undefined ? { max: schema.max } : {}),
    ...(schema.step !== undefined ? { step: schema.step } : {}),
  }));
}

/** Expand MG Template → Tpl(Merge into template browser;code Compile using existing sandbox/snapshot mechanism) */
export function pluginTemplates(packs: InstalledPack[]): Tpl[] {
  const out: Tpl[] = [];
  for (const pack of packs) {
    if (!pack.enabled) continue;
    for (const item of pack.items) {
      if (item.type !== 'mg-template') continue;
      const props = item.props ?? {};
      out.push({
        id: pluginAssetId(pack.id, item.id),
        name: item.name,
        category: 'Expand',
        description: item.desc ?? `${pack.name} extended template`,
        width: item.width ?? 1920,
        height: item.height ?? 1080,
        fps: 30,
        durationInFrames: 150,
        props,
        propSchema: schemaFromMgItem(item),
        thumb: item.thumb ?? null,
        code: item.code,
      });
    }
  }
  return out;
}

/** Template drag and drop data shape check(drag JSON Not trustworthy)→ Can be directly addMotionGraphic of Tpl */
export function asPluginTpl(data: unknown): Tpl | null {
  if (!data || typeof data !== 'object') return null;
  const template = data as Partial<Tpl>;
  if (
    typeof template.id !== 'string'
    || typeof template.name !== 'string'
    || typeof template.code !== 'string'
    || !template.code.trim()
  ) return null;
  const num = (value: unknown, fallback: number) => (
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  );
  const props = template.props && typeof template.props === 'object' && !Array.isArray(template.props)
    ? template.props as Record<string, unknown>
    : {};
  const propSchema = Array.isArray(template.propSchema) && template.propSchema.length
    ? template.propSchema as PropSpec[]
    : inferPropSchema(props);
  const thumb = typeof template.thumb === 'string' && template.thumb.trim() ? template.thumb : null;
  return {
    id: template.id,
    name: template.name,
    category: 'Expand',
    description: typeof template.description === 'string' ? template.description : undefined,
    width: num(template.width, 1920),
    height: num(template.height, 1080),
    fps: num(template.fps, 30),
    durationInFrames: num(template.durationInFrames, 150),
    props,
    propSchema,
    thumb,
    code: template.code,
  };
}

/** Zoom card data shape check(drag JSON Not trustworthy) */
export function asPluginZoom(data: unknown): ZoomEffect | null {
  if (!data || typeof data !== 'object') return null;
  const zoom = data as { envelope?: unknown; magnification?: unknown; label?: unknown };
  if (
    !Array.isArray(zoom.envelope)
    || zoom.envelope.length < 2
    || !zoom.envelope.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) return null;
  const magnification = typeof zoom.magnification === 'number' && Number.isFinite(zoom.magnification)
    ? Math.min(16, Math.max(1, zoom.magnification))
    : 1.5;
  return {
    envelope: zoom.envelope,
    magnification,
    shape: undefined,
    ...(typeof zoom.label === 'string' ? { label: zoom.label } : {}),
  };
}
