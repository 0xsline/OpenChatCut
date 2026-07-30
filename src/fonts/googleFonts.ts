// Google Fonts referenced by design presets, captions and MG templates.
// projectFonts.ts discovers the faces used by the active timeline and calls
// ensureFont(); loadFont() then registers only those faces and lets Remotion
// wait for them during headless export.
//
// Google Fonts loading; export gated on confirmFontFallback
// (search_fonts returns canonical family names). Chinese foundry faces
// (得意黑/鸿蒙/…) aren't on Google Fonts — they ship as bundled woff2
// under assets/fonts and register via localFonts.ts (source:'bundled', loadable).
//
import { loadFont as loadAnton } from '@remotion/google-fonts/Anton';
import { loadFont as loadArchivoBlack } from '@remotion/google-fonts/ArchivoBlack';
import { loadFont as loadBangers } from '@remotion/google-fonts/Bangers';
import { loadFont as loadBarlowCondensed } from '@remotion/google-fonts/BarlowCondensed';
import { loadFont as loadBowlbyOne } from '@remotion/google-fonts/BowlbyOne';
import { loadFont as loadCaveat } from '@remotion/google-fonts/Caveat';
import { loadFont as loadCormorantGaramond } from '@remotion/google-fonts/CormorantGaramond';
import { loadFont as loadDMSans } from '@remotion/google-fonts/DMSans';
import { loadFont as loadDancingScript } from '@remotion/google-fonts/DancingScript';
import { loadFont as loadFraunces } from '@remotion/google-fonts/Fraunces';
import { loadFont as loadFredoka } from '@remotion/google-fonts/Fredoka';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadInterTight } from '@remotion/google-fonts/InterTight';
import { loadFont as loadLXGWWenKaiTC } from '@remotion/google-fonts/LXGWWenKaiTC';
import { loadFont as loadLibreBaskerville } from '@remotion/google-fonts/LibreBaskerville';
import { loadFont as loadMontserrat } from '@remotion/google-fonts/Montserrat';
import { loadFont as loadMulish } from '@remotion/google-fonts/Mulish';
import { loadFont as loadNewsreader } from '@remotion/google-fonts/Newsreader';
import { loadFont as loadNotoSansSC } from '@remotion/google-fonts/NotoSansSC';
import { loadFont as loadNotoSerifSC } from '@remotion/google-fonts/NotoSerifSC';
import { loadFont as loadNotoSerifTC } from '@remotion/google-fonts/NotoSerifTC';
import { loadFont as loadNunito } from '@remotion/google-fonts/Nunito';
import { loadFont as loadOswald } from '@remotion/google-fonts/Oswald';
import { loadFont as loadPinyonScript } from '@remotion/google-fonts/PinyonScript';
import { loadFont as loadPlayfairDisplay } from '@remotion/google-fonts/PlayfairDisplay';
import { loadFont as loadRoboto } from '@remotion/google-fonts/Roboto';
import { loadFont as loadSora } from '@remotion/google-fonts/Sora';
import { loadFont as loadSpaceMono } from '@remotion/google-fonts/SpaceMono';
import { loadFont as loadSpecialElite } from '@remotion/google-fonts/SpecialElite';
import { loadFont as loadUnbounded } from '@remotion/google-fonts/Unbounded';
import { loadFont as loadVT323 } from '@remotion/google-fonts/VT323';
import { loadFont as loadZCOOLQingKeHuangYou } from '@remotion/google-fonts/ZCOOLQingKeHuangYou';
import { LOCAL_CJK_FONTS, normalizeFontKey, registerLocalFonts } from './localFonts';

export { ensureLocalFont, LOCAL_CJK_FONTS, normalizeFontKey } from './localFonts';

/** One catalog row — family is the canonical string for MG/caption fontFamily. */
export interface FontCatalogEntry {
  family: string;
  /** Native / alternate names (e.g. Chinese display names). */
  aliases: string[];
  /** true when the renderer can load it (google-fonts loader or bundled woff2). */
  loadable: boolean;
  /** google = @remotion/google-fonts; bundled = local woff2 in assets/fonts. */
  source: 'google' | 'bundled';
}

// CSS family names for every remotion google-fonts package we ship.
const GOOGLE_LOADABLE: ReadonlyArray<{ family: string; aliases?: string[]; load: () => unknown }> = [
  { family: 'Anton', load: loadAnton },
  { family: 'Archivo Black', load: loadArchivoBlack },
  { family: 'Bangers', load: loadBangers },
  { family: 'Barlow Condensed', load: loadBarlowCondensed },
  { family: 'Bowlby One', load: loadBowlbyOne },
  { family: 'Caveat', load: loadCaveat },
  { family: 'Cormorant Garamond', load: loadCormorantGaramond },
  { family: 'DM Sans', load: loadDMSans },
  { family: 'Dancing Script', load: loadDancingScript },
  { family: 'Fraunces', load: loadFraunces },
  { family: 'Fredoka', load: loadFredoka },
  { family: 'Inter', load: loadInter },
  { family: 'Inter Tight', load: loadInterTight },
  { family: 'LXGW WenKai TC', aliases: ['LXGW WenKai', '霞鹜文楷'], load: loadLXGWWenKaiTC },
  { family: 'Libre Baskerville', load: loadLibreBaskerville },
  { family: 'Montserrat', load: loadMontserrat },
  { family: 'Mulish', load: loadMulish },
  { family: 'Newsreader', load: loadNewsreader },
  { family: 'Noto Sans SC', aliases: ['Noto Sans CJK SC'], load: loadNotoSansSC },
  { family: 'Noto Serif SC', load: loadNotoSerifSC },
  { family: 'Noto Serif TC', load: loadNotoSerifTC },
  { family: 'Nunito', load: loadNunito },
  { family: 'Oswald', load: loadOswald },
  { family: 'Pinyon Script', load: loadPinyonScript },
  { family: 'Playfair Display', load: loadPlayfairDisplay },
  {
    family: 'Roboto',
    load: () => loadRoboto(undefined, { ignoreTooManyRequestsWarning: true }),
  },
  { family: 'Sora', load: loadSora },
  { family: 'Space Mono', load: loadSpaceMono },
  { family: 'Special Elite', load: loadSpecialElite },
  { family: 'Unbounded', load: loadUnbounded },
  { family: 'VT323', load: loadVT323 },
  { family: 'ZCOOL QingKe HuangYou', aliases: ['站酷庆科黄油体'], load: loadZCOOLQingKeHuangYou },
];

/** Full search catalog for search_fonts + export font gate + Inspector font picker.
 * Bundled CJK rows derive from localFonts.LOCAL_CJK_FONTS (全部中文
 * alias 可搜) and are loadable: loadProjectFonts() registers their FontFaces. */
export const FONT_CATALOG: readonly FontCatalogEntry[] = [
  ...GOOGLE_LOADABLE.map((f) => ({
    family: f.family,
    aliases: f.aliases ?? [],
    loadable: true as const,
    source: 'google' as const,
  })),
  ...LOCAL_CJK_FONTS.map((f) => ({
    family: f.family,
    aliases: [...f.aliasZh, f.importName],
    loadable: true as const,
    source: 'bundled' as const,
  })),
];

const GENERIC_FAMILIES = new Set(
  [
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
    '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'helvetica neue',
    'helvetica', 'arial', 'times new roman', 'courier new', 'georgia',
  ].map(normalizeFontKey),
);

/** True when the local/headless renderer can load this family (or it is a CSS generic). */
export function isLoadableFontFamily(family: string): boolean {
  const raw = family.trim();
  if (!raw) return true;
  // font stacks: first face decides; if any loadable face is first token, ok
  const first = raw.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? raw;
  const key = normalizeFontKey(first);
  if (GENERIC_FAMILIES.has(key)) return true;
  for (const entry of FONT_CATALOG) {
    if (!entry.loadable) continue;
    if (normalizeFontKey(entry.family) === key) return true;
    if (entry.aliases.some((a) => normalizeFontKey(a) === key)) return true;
  }
  return false;
}

/** Resolve a query hit's canonical family name (or null). */
export function resolveCanonicalFamily(name: string): string | null {
  const key = normalizeFontKey(name);
  if (!key) return null;
  for (const entry of FONT_CATALOG) {
    if (normalizeFontKey(entry.family) === key) return entry.family;
    if (entry.aliases.some((a) => normalizeFontKey(a) === key)) return entry.family;
  }
  return null;
}

export interface FontSearchHit {
  family: string;
  aliases: string[];
  loadable: boolean;
  source: 'google' | 'bundled';
}

/** Substring search over font families and aliases. */
export function searchFontCatalog(query: string, limit = 25): FontSearchHit[] {
  const q = normalizeFontKey(query);
  if (!q) return [];
  const hits: FontSearchHit[] = [];
  for (const entry of FONT_CATALOG) {
    const hay = [entry.family, ...entry.aliases].map(normalizeFontKey).join(' ');
    if (hay.includes(q) || normalizeFontKey(entry.family).includes(q)) {
      hits.push({
        family: entry.family,
        aliases: entry.aliases,
        loadable: entry.loadable,
        source: entry.source,
      });
      if (hits.length >= limit) break;
    }
  }
  // Prefer loadable first
  hits.sort((a, b) => Number(b.loadable) - Number(a.loadable));
  return hits;
}

const loadedGoogleFamilies = new Set<string>();

/** Register one Google face. Unknown/generic/local families are no-ops. */
export function ensureFont(family: string): void {
  const first = family.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '';
  const key = normalizeFontKey(first);
  if (!key || GENERIC_FAMILIES.has(key)) return;
  const font = GOOGLE_LOADABLE.find((candidate) =>
    normalizeFontKey(candidate.family) === key
    || candidate.aliases?.some((alias) => normalizeFontKey(alias) === key),
  );
  if (!font || loadedGoogleFamilies.has(font.family)) return;
  try {
    font.load();
    loadedGoogleFamilies.add(font.family);
  } catch {
    loadedGoogleFamilies.delete(font.family);
  }
}

let runtimeReady = false;

/** Register bundled CJK FontFaces without downloading their bytes. */
export function loadProjectFonts(): void {
  if (runtimeReady) return;
  runtimeReady = true;
  try {
    registerLocalFonts();
  } catch {
    // one local face must not block the editor or renderer
  }
}
