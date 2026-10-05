import { useEffect, useSyncExternalStore } from 'react';

const CUSTOM_FONTS_STORAGE_KEY = 'occ_custom_fonts';
let userFonts: string[] = [];
let systemFonts: string[] = [];
let customFonts: string[] = [];
let pending: Promise<string[]> | undefined;
let pendingForce = false;
let snapshot = 0;
const listeners = new Set<() => void>();

function fontNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string =>
    typeof name === 'string' && name.trim().length > 0 && name.length <= 160,
  ).map((name) => name.trim()))].slice(0, 10000);
}

if (typeof window !== 'undefined') {
  try {
    customFonts = fontNames(JSON.parse(window.localStorage.getItem(CUSTOM_FONTS_STORAGE_KEY) ?? '[]'));
  } catch { /* storage is optional */ }
}

function notify(): void {
  snapshot++;
  listeners.forEach((listener) => listener());
}

export function getUserFonts(): string[] { return [...userFonts]; }
export function getSystemFonts(): string[] { return [...systemFonts]; }
export function getCustomFonts(): string[] { return [...customFonts]; }
export function getAllDiscoveredFonts(): string[] {
  return [...new Set([...userFonts, ...systemFonts, ...customFonts])].sort((a, b) => a.localeCompare(b));
}

/** Only the rendering host's installed fonts satisfy export availability. */
export function isInstalledFont(family: string): boolean {
  const clean = family.split(',')[0]!.trim().replace(/^["']|["']$/g, '').toLowerCase();
  return [...userFonts, ...systemFonts].some((name) => name.toLowerCase() === clean);
}

export function registerCustomFont(family: string): void {
  const clean = family.trim().replace(/^["']|["']$/g, '');
  if (!clean || clean.length > 160 || customFonts.some((name) => name.toLowerCase() === clean.toLowerCase())) return;
  customFonts = [clean, ...customFonts].slice(0, 100);
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(CUSTOM_FONTS_STORAGE_KEY, JSON.stringify(customFonts)); }
    catch { /* storage is optional */ }
  }
  notify();
}

/** Deduplicate callers; discovery never requests browser font permissions. */
export function refreshSystemFonts(force = false): Promise<string[]> {
  if (typeof window === 'undefined') return Promise.resolve(getAllDiscoveredFonts());
  if (pending) return force && !pendingForce ? pending.then(() => refreshSystemFonts(true)) : pending;
  pendingForce = force;
  pending = (async () => {
    try {
      const response = await fetch(force ? '/api/system-fonts?refresh=1' : '/api/system-fonts', {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const data = await response.json() as { ok?: boolean; userFonts?: unknown; systemFonts?: unknown };
        if (data.ok && Array.isArray(data.userFonts) && Array.isArray(data.systemFonts)) {
          userFonts = fontNames(data.userFonts);
          systemFonts = fontNames(data.systemFonts);
          notify();
        }
      }
    } catch { /* discovery is optional; unknown names still require fallback consent */ }
    return getAllDiscoveredFonts();
  })().finally(() => { pending = undefined; pendingForce = false; });
  return pending;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function getSnapshot(): number { return snapshot; }

export function useSystemFonts() {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    const refresh = () => { void refreshSystemFonts(); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('focus', refresh); };
  }, []);
  return {
    userFonts, systemFonts, customFonts,
    allDiscoveredFonts: getAllDiscoveredFonts(),
    refresh: (force = true) => refreshSystemFonts(force),
    addCustomFont: registerCustomFont,
  };
}
