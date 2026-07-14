// Google Fonts referenced by the design-style presets (editor/design-presets.ts),
// the caption styles (captions/styles.ts) and the ~211 MG templates. We load them
// so the browser Player preview AND the headless export (remotion/Root.tsx both
// call loadProjectFonts) burn in the real faces instead of falling back to a
// default. loadFont() registers the @font-face (unicode-range keeps the actual
// glyph download lazy) + a delayRender the headless renderer waits on.
//
// Source-faithful: ChatCut loads Google Fonts + gates export on confirmFontFallback
// (search_fonts returns canonical family names). Presets also reference Chinese
// foundry faces (得意黑/OPPO Sans/鸿蒙/…) that aren't on Google Fonts — catalogued
// as non-loadable so the export gate can surface them.
//
// ponytail: eager-load the whole referenced set (~32) once. Simple + correct;
// unicode-range makes browser downloads on-demand so cost is mostly the CSS.
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

/** One catalog row — family is the canonical string for MG/caption fontFamily. */
export interface FontCatalogEntry {
  family: string;
  /** Native / alternate names (e.g. Chinese display names). */
  aliases: string[];
  /** true when a Remotion Google Font loader is registered (export-safe). */
  loadable: boolean;
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
  { family: 'Roboto', load: loadRoboto },
  { family: 'Sora', load: loadSora },
  { family: 'Space Mono', load: loadSpaceMono },
  { family: 'Special Elite', load: loadSpecialElite },
  { family: 'Unbounded', load: loadUnbounded },
  { family: 'VT323', load: loadVT323 },
  { family: 'ZCOOL QingKe HuangYou', aliases: ['站酷庆科黄油体'], load: loadZCOOLQingKeHuangYou },
];

// Design-preset Chinese foundry faces — searchable, but not export-loadable yet.
const BUNDLED_PENDING: ReadonlyArray<{ family: string; aliases: string[] }> = [
  { family: 'Smiley Sans', aliases: ['得意黑', 'SmileySans', 'Deyi Hei'] },
  { family: 'OPPO Sans', aliases: ['OPPOSans'] },
  { family: 'HarmonyOS Sans', aliases: ['HarmonyOS', '鸿蒙', '鸿蒙黑体'] },
  { family: 'Douyin Meihao Ti', aliases: ['抖音美好体', 'Douyin Beautiful'] },
  { family: 'Pangmen Zhengdao Biaoti Ti', aliases: ['庞门正道标题体', 'PangMenZhengDao'] },
  { family: 'Huxiaobo Nanshen Ti', aliases: ['胡晓波男神体', 'HuXiaobo'] },
];

/** Full search catalog for search_fonts + export font gate. */
export const FONT_CATALOG: readonly FontCatalogEntry[] = [
  ...GOOGLE_LOADABLE.map((f) => ({
    family: f.family,
    aliases: f.aliases ?? [],
    loadable: true as const,
  })),
  ...BUNDLED_PENDING.map((f) => ({
    family: f.family,
    aliases: f.aliases,
    loadable: false as const,
  })),
];

const FONT_LOADERS: ReadonlyArray<() => unknown> = GOOGLE_LOADABLE.map((f) => f.load);

/** Normalize for substring match (case + punctuation insensitive). */
export function normalizeFontKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s_\-·.,'"`]+/g, '');
}

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
}

/** Substring search on family + aliases (source search_fonts). */
export function searchFontCatalog(query: string, limit = 25): FontSearchHit[] {
  const q = normalizeFontKey(query);
  if (!q) return [];
  const hits: FontSearchHit[] = [];
  for (const entry of FONT_CATALOG) {
    const hay = [entry.family, ...entry.aliases].map(normalizeFontKey).join(' ');
    if (hay.includes(q) || normalizeFontKey(entry.family).includes(q)) {
      hits.push({ family: entry.family, aliases: entry.aliases, loadable: entry.loadable });
      if (hits.length >= limit) break;
    }
  }
  // Prefer loadable first
  hits.sort((a, b) => Number(b.loadable) - Number(a.loadable));
  return hits;
}

let loaded = false;

/** Register every referenced Google font (idempotent). Called from main.tsx
 * (preview) and remotion/Root.tsx (headless export) so both match. */
export function loadProjectFonts(): void {
  if (loaded) return;
  loaded = true;
  for (const load of FONT_LOADERS) {
    try {
      load();
    } catch {
      // one font failing to register must not block the rest (or the render)
    }
  }
}
