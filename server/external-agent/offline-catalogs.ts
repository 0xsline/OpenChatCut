// Editor catalogs for headless sessions (offline MCP and the occ CLI).
//
// The browser agent context carries the bundled template registry plus whatever
// plugin packs the user installed. A headless host has no renderer, so it reads
// the same two sources itself: the bundled templates (src/editor/initial.ts) and
// the on-disk pack store, mapped through the very same pluginTemplates() the
// renderer uses — no second mapping, no silently different catalog.
//
// Packs carry user-authored code, so the boundary is validated here: only packs
// whose envelope is well-formed and whose mg-template items have the fields
// pluginTemplates() reads are kept; anything else is dropped rather than mapped
// into a half-built template.
import { TEMPLATES } from '../../src/editor/initial.ts';
import { AUDIO_ASSETS, type AudioAsset } from '../../src/audio/library.ts';
import { pluginTemplates } from '../../src/library/pluginTemplateCatalog.ts';
import { PLUGIN_FORMAT, type PluginMgTemplateItem } from '../../src/plugins/types.ts';
import type { InstalledPack } from '../../src/plugins/store.ts';
import { readInstalledPacks } from '../plugins/extension-store.ts';
import type { Tpl } from '../../src/types.ts';

export interface OfflineEditorCatalogs {
  readonly templates: Tpl[];
  readonly audio: AudioAsset[];
}

/** Built-in music / SFX library; project audio assets come from the project doc. */
export const OFFLINE_AUDIO: AudioAsset[] = [...AUDIO_ASSETS];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  // Structural view of an already-shape-checked value: every field read below is
  // typeof-guarded before it is used.
  return value as Record<string, unknown>;
}

function mgTemplateItem(value: unknown): PluginMgTemplateItem | null {
  const item = asRecord(value);
  if (!item) return null;
  if (item.type !== 'mg-template') return null;
  if (typeof item.id !== 'string' || typeof item.name !== 'string') return null;
  if (typeof item.code !== 'string' || !item.code.trim()) return null;
  return item as unknown as PluginMgTemplateItem;
}

/** Packs that carry at least one usable motion-graphic template. */
function templatePacks(stored: readonly unknown[]): InstalledPack[] {
  const packs: InstalledPack[] = [];
  for (const value of stored) {
    const pack = asRecord(value);
    if (!pack || typeof pack.id !== 'string' || typeof pack.name !== 'string') continue;
    const items = Array.isArray(pack.items)
      ? pack.items.map(mgTemplateItem).filter((item): item is PluginMgTemplateItem => item !== null)
      : [];
    if (items.length === 0) continue;
    packs.push({
      format: PLUGIN_FORMAT,
      id: pack.id,
      name: pack.name,
      version: typeof pack.version === 'string' ? pack.version : '0',
      installedAt: typeof pack.installedAt === 'number' ? pack.installedAt : 0,
      enabled: pack.enabled !== false,
      items,
    });
  }
  return packs;
}

/** Bundled templates plus the installed packs' templates, exactly as the renderer builds it. */
export async function offlineEditorCatalogs(): Promise<OfflineEditorCatalogs> {
  const packs = templatePacks(await readInstalledPacks().catch(() => []));
  const templates = packs.length > 0 ? [...TEMPLATES, ...pluginTemplates(packs)] : [...TEMPLATES];
  return { templates, audio: OFFLINE_AUDIO };
}
