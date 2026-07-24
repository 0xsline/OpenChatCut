import type { CSSProperties } from 'react';
import type { InstalledPack } from '../plugins/store';
import { theme } from '../theme';

export type CenterTab = 'discover' | 'Installed' | 'create';
export type Category = 'All' | 'MG' | 'Transition' | 'special effects' | 'LUT' | 'Zoom';

export interface RegistryEntry {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  url: string;
  sha256?: string;
  categories: Category[];
  itemCount?: number;
}

export const CENTER_TABS: CenterTab[] = ['discover', 'Installed', 'create'];
export const EXTENSION_CATEGORIES: Category[] = ['All', 'MG', 'Transition', 'special effects', 'LUT', 'Zoom'];
export const EXTENSION_TYPE_LABEL: Record<string, string> = {
  'mg-template': 'MG',
  transition: 'Transition',
  fx: 'special effects',
  lut: 'LUT',
  zoom: 'Zoom',
};

export function parseRegistry(value: unknown): RegistryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.url !== 'string') return [];
    if (!item.url.startsWith('/') && !/^https?:\/\//.test(item.url)) return [];
    const categories = Array.isArray(item.categories)
      ? item.categories.filter((entry): entry is Category => (
        EXTENSION_CATEGORIES.includes(entry as Category) && entry !== 'All'
      ))
      : [];
    return [{
      id: item.id,
      name: item.name.slice(0, 60),
      url: item.url,
      categories,
      ...(typeof item.description === 'string' ? { description: item.description.slice(0, 240) } : {}),
      ...(typeof item.author === 'string' ? { author: item.author.slice(0, 80) } : {}),
      ...(typeof item.version === 'string' ? { version: item.version.slice(0, 80) } : {}),
      ...(typeof item.itemCount === 'number' && Number.isFinite(item.itemCount)
        ? { itemCount: Math.max(0, Math.floor(item.itemCount)) }
        : {}),
      ...(typeof item.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(item.sha256)
        ? { sha256: item.sha256.toLowerCase() }
        : {}),
    }];
  });
}

export function packCounts(pack: InstalledPack): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of pack.items) {
    const label = EXTENSION_TYPE_LABEL[item.type] ?? item.type;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()];
}

export function hasExtensionUpdate(installedVersion: string, registryVersion?: string): boolean {
  if (!registryVersion) return false;
  const installed = installedVersion.split('.').map(Number);
  const registry = registryVersion.split('.').map(Number);
  if (installed.length !== 3 || registry.length !== 3) return false;
  for (let index = 0; index < 3; index += 1) {
    if (registry[index] !== installed[index]) return registry[index] > installed[index];
  }
  return false;
}

export function secondaryButton(disabled = false): CSSProperties {
  return {
    border: `0.5px solid ${theme.border}`,
    borderRadius: 4,
    background: 'transparent',
    color: theme.text,
    padding: '5px 9px',
    fontSize: 10.5,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap',
  };
}
