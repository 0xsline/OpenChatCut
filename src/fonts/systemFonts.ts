import { useState, useEffect, useSyncExternalStore } from 'react';

const SYSTEM_FONTS_STORAGE_KEY = 'occ_system_fonts';
const CUSTOM_FONTS_STORAGE_KEY = 'occ_custom_fonts';

const DEFAULT_POPULAR_FONTS = [
  // User installed fonts detected on system
  'Akira Expanded',
  'JetBrainsMono Nerd Font',
  'JetBrainsMono Nerd Font Mono',
  'JetBrainsMono Nerd Font Propo',
  'Montserrat',
  'Poppins',
  'Raleway',
  'Gotham',
  'Cocogoose ProTrial',
  'Adelia Alternate',
  '3270 Nerd Font',
  'Chalkboy',
  'Nexa',
  'Permanent Marker',
  'Sofia Sans Extra Condensed',
  'Sole Sans Extended',
  'Komika Axis',
  'Golos Text',
  'Heebo',
  'Ink Free',
  'BlackSingature',
  'Fort XCond',
  'PRIMETIME',
  'Obviously',
  // Popular macOS system fonts
  'Arial',
  'Avenir',
  'Avenir Next',
  'Courier New',
  'Futura',
  'Georgia',
  'Helvetica',
  'Helvetica Neue',
  'Impact',
  'Menlo',
  'Monaco',
  'Optima',
  'Palatino',
  'PingFang SC',
  'Hiragino Sans GB',
  'Songti SC',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
];

interface StoredFontData {
  userFonts: string[];
  systemFonts: string[];
  allFonts: string[];
  timestamp: number;
}

let memoryUserFonts: string[] = [];
let memorySystemFonts: string[] = [];
let memoryCustomFonts: string[] = [];
let memoryAllFonts: string[] = [];
let listeners = new Set<() => void>();
let isFetching = false;

function loadStoredData(): void {
  if (typeof window === 'undefined') return;

  try {
    const rawCustom = window.localStorage.getItem(CUSTOM_FONTS_STORAGE_KEY);
    if (rawCustom) {
      memoryCustomFonts = JSON.parse(rawCustom) as string[];
    }
  } catch {
    memoryCustomFonts = [];
  }

  try {
    const raw = window.localStorage.getItem(SYSTEM_FONTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredFontData;
      if (Array.isArray(parsed.userFonts)) memoryUserFonts = parsed.userFonts;
      if (Array.isArray(parsed.systemFonts)) memorySystemFonts = parsed.systemFonts;
      if (Array.isArray(parsed.allFonts)) memoryAllFonts = parsed.allFonts;
    }
  } catch {
    // fallback
  }

  // Ensure default fonts are present if empty
  if (memoryUserFonts.length === 0 && memorySystemFonts.length === 0) {
    memorySystemFonts = [...DEFAULT_POPULAR_FONTS];
    memoryAllFonts = [...DEFAULT_POPULAR_FONTS];
  }
}

// Initial sync load
loadStoredData();

function notifyListeners(): void {
  listeners.forEach((l) => {
    try { l(); } catch { /* ignore */ }
  });
}

export function getAllDiscoveredFonts(): string[] {
  const set = new Set([...memoryCustomFonts, ...memoryUserFonts, ...memorySystemFonts, ...DEFAULT_POPULAR_FONTS]);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export function getUserFonts(): string[] {
  return [...memoryUserFonts];
}

export function getSystemFonts(): string[] {
  return [...memorySystemFonts];
}

export function getCustomFonts(): string[] {
  return [...memoryCustomFonts];
}

export function isSystemOrCustomFont(family: string): boolean {
  if (!family) return false;
  const clean = family.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (memoryCustomFonts.some((f) => f.toLowerCase() === clean)) return true;
  if (memoryUserFonts.some((f) => f.toLowerCase() === clean)) return true;
  if (memorySystemFonts.some((f) => f.toLowerCase() === clean)) return true;
  if (DEFAULT_POPULAR_FONTS.some((f) => f.toLowerCase() === clean)) return true;
  return false;
}

export function registerCustomFont(family: string): void {
  const clean = family.trim().replace(/^["']|["']$/g, '');
  if (!clean || memoryCustomFonts.includes(clean)) return;

  memoryCustomFonts = [clean, ...memoryCustomFonts];
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(CUSTOM_FONTS_STORAGE_KEY, JSON.stringify(memoryCustomFonts));
    } catch {
      // ignore
    }
  }
  notifyListeners();
}

export async function refreshSystemFonts(force = false): Promise<string[]> {
  if (typeof window === 'undefined') return getAllDiscoveredFonts();
  if (isFetching) return getAllDiscoveredFonts();

  isFetching = true;
  try {
    // 1. Fetch from server endpoint
    const url = force ? '/api/system-fonts?refresh=1' : '/api/system-fonts';
    const res = await fetch(url).catch(() => null);

    if (res && res.ok) {
      const data = await res.json();
      if (data && data.ok) {
        if (Array.isArray(data.userFonts)) memoryUserFonts = data.userFonts;
        if (Array.isArray(data.systemFonts)) memorySystemFonts = data.systemFonts;
        if (Array.isArray(data.allFonts)) memoryAllFonts = data.allFonts;

        try {
          window.localStorage.setItem(
            SYSTEM_FONTS_STORAGE_KEY,
            JSON.stringify({
              userFonts: memoryUserFonts,
              systemFonts: memorySystemFonts,
              allFonts: memoryAllFonts,
              timestamp: Date.now(),
            }),
          );
        } catch {
          // ignore
        }
      }
    }

    // 2. Also try window.queryLocalFonts() if available
    if ('queryLocalFonts' in window && typeof (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts === 'function') {
      try {
        const localFonts = await (window as unknown as { queryLocalFonts: () => Promise<Array<{ family: string }>> }).queryLocalFonts();
        if (Array.isArray(localFonts) && localFonts.length > 0) {
          const browserFamilies = new Set<string>();
          for (const f of localFonts) {
            if (f.family && !f.family.startsWith('.')) {
              browserFamilies.add(f.family);
            }
          }
          for (const fam of browserFamilies) {
            if (!memorySystemFonts.includes(fam) && !memoryUserFonts.includes(fam)) {
              memorySystemFonts.push(fam);
            }
          }
          memorySystemFonts.sort((a, b) => a.localeCompare(b));
        }
      } catch {
        // queryLocalFonts permission denied or cancelled, ignore
      }
    }
  } catch {
    // ignore
  } finally {
    isFetching = false;
    notifyListeners();
  }

  return getAllDiscoveredFonts();
}

// Auto-trigger on initial load and window focus
if (typeof window !== 'undefined') {
  setTimeout(() => {
    void refreshSystemFonts();
  }, 100);

  // When user switches back to OpenChatCut (e.g. after downloading a font in Finder/Browser), auto refresh!
  window.addEventListener('focus', () => {
    void refreshSystemFonts();
  });
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

let storeSnapshot = 0;
function getSnapshot(): number {
  return storeSnapshot;
}

// Hook for React components
export function useSystemFonts() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const unsub = subscribe(() => {
      storeSnapshot++;
      setTick((t) => t + 1);
    });
    return unsub;
  }, []);

  return {
    userFonts: memoryUserFonts,
    systemFonts: memorySystemFonts,
    customFonts: memoryCustomFonts,
    allDiscoveredFonts: getAllDiscoveredFonts(),
    refresh: (force = true) => refreshSystemFonts(force),
    addCustomFont: registerCustomFont,
    isSystemOrCustomFont,
  };
}
