import { LOCAL_CJK_FONTS, normalizeFontKey } from './localFonts';

export interface FontCatalogEntry {
  family: string;
  aliases: string[];
  loadable: boolean;
  source: 'google' | 'bundled';
}

export interface GoogleFontCatalogEntry extends FontCatalogEntry {
  source: 'google';
  weighted?: boolean;
}

export const GOOGLE_FONT_CATALOG: readonly GoogleFontCatalogEntry[] = [
  { family: 'Anton', aliases: [], loadable: true, source: 'google' },
  { family: 'Archivo Black', aliases: [], loadable: true, source: 'google' },
  { family: 'Bangers', aliases: [], loadable: true, source: 'google' },
  { family: 'Barlow Condensed', aliases: [], loadable: true, source: 'google' },
  { family: 'Bowlby One', aliases: [], loadable: true, source: 'google' },
  { family: 'Caveat', aliases: [], loadable: true, source: 'google' },
  { family: 'Cormorant Garamond', aliases: [], loadable: true, source: 'google' },
  { family: 'DM Sans', aliases: [], loadable: true, source: 'google' },
  { family: 'Dancing Script', aliases: [], loadable: true, source: 'google' },
  { family: 'Fraunces', aliases: [], loadable: true, source: 'google' },
  { family: 'Fredoka', aliases: [], loadable: true, source: 'google' },
  { family: 'Inter', aliases: [], loadable: true, source: 'google' },
  { family: 'Inter Tight', aliases: [], loadable: true, source: 'google' },
  { family: 'LXGW WenKai TC', aliases: ['LXGW WenKai', '霞鹜文楷'], loadable: true, source: 'google' },
  { family: 'Libre Baskerville', aliases: [], loadable: true, source: 'google' },
  { family: 'Montserrat', aliases: [], loadable: true, source: 'google' },
  { family: 'Mulish', aliases: [], loadable: true, source: 'google' },
  { family: 'Newsreader', aliases: [], loadable: true, source: 'google' },
  { family: 'Noto Sans SC', aliases: ['Noto Sans CJK SC'], loadable: true, source: 'google', weighted: true },
  { family: 'Noto Serif SC', aliases: [], loadable: true, source: 'google' },
  { family: 'Noto Serif TC', aliases: [], loadable: true, source: 'google' },
  { family: 'Nunito', aliases: [], loadable: true, source: 'google' },
  { family: 'Oswald', aliases: [], loadable: true, source: 'google' },
  { family: 'Pinyon Script', aliases: [], loadable: true, source: 'google' },
  { family: 'Playfair Display', aliases: [], loadable: true, source: 'google' },
  { family: 'Roboto', aliases: [], loadable: true, source: 'google' },
  { family: 'Sora', aliases: [], loadable: true, source: 'google' },
  { family: 'Space Mono', aliases: [], loadable: true, source: 'google' },
  { family: 'Special Elite', aliases: [], loadable: true, source: 'google' },
  { family: 'Unbounded', aliases: [], loadable: true, source: 'google' },
  { family: 'VT323', aliases: [], loadable: true, source: 'google' },
  { family: 'ZCOOL QingKe HuangYou', aliases: ['站酷庆科黄油体'], loadable: true, source: 'google' },
];

export const FONT_CATALOG: readonly FontCatalogEntry[] = [
  ...GOOGLE_FONT_CATALOG,
  ...LOCAL_CJK_FONTS.map((font) => ({
    family: font.family,
    aliases: [...font.aliasZh, font.importName],
    loadable: true as const,
    source: 'bundled' as const,
  })),
];

const GENERIC_FAMILIES: Record<string, true> = {
  serif: true, sansserif: true, monospace: true, cursive: true, fantasy: true,
  systemui: true, uisansserif: true, uiserif: true, uimonospace: true,
  uirounded: true, applesystem: true, blinkmacsystemfont: true, segoeui: true,
  helveticaneue: true, helvetica: true, arial: true, timesnewroman: true,
  couriernew: true, georgia: true,
};


export function isGenericFontFamily(family: string): boolean {
  const key = normalizeFontKey(family.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '');
  return !key || key in GENERIC_FAMILIES;
}

export function resolveCanonicalFamily(name: string): string | null {
  const key = normalizeFontKey(name.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '');
  if (!key) return null;
  for (const entry of FONT_CATALOG) {
    if (normalizeFontKey(entry.family) === key) return entry.family;
    if (entry.aliases.some((alias) => normalizeFontKey(alias) === key)) return entry.family;
  }
  return null;
}

export function isLoadableFontFamily(family: string): boolean {
  return isGenericFontFamily(family) || resolveCanonicalFamily(family) !== null;
}

export interface FontSearchHit {
  family: string;
  aliases: string[];
  loadable: boolean;
  source: 'google' | 'bundled';
}

export function searchFontCatalog(query: string, limit = 25): FontSearchHit[] {
  const normalized = normalizeFontKey(query);
  if (!normalized) return [];
  const hits: FontSearchHit[] = [];
  for (const entry of FONT_CATALOG) {
    const haystack = [entry.family, ...entry.aliases].map(normalizeFontKey).join(' ');
    if (haystack.includes(normalized) || normalizeFontKey(entry.family).includes(normalized)) {
      hits.push({ ...entry });
      if (hits.length >= limit) break;
    }
  }
  hits.sort((a, b) => Number(b.loadable) - Number(a.loadable));
  return hits;
}
