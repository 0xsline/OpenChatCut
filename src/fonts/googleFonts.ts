// Google font loader boundary. Catalog/search metadata lives in
// googleFontCatalog.ts so editor controls never evaluate this module.
import {
  GOOGLE_FONT_CATALOG,
  isGenericFontFamily,
  resolveCanonicalFamily,
} from './googleFontCatalog';
export {
  FONT_CATALOG,
  isLoadableFontFamily,
  searchFontCatalog,
} from './googleFontCatalog';
import {
  ensureLocalFont,
  findLocalFont,
  registerLocalFonts,
} from './localFonts';

interface FontLoadResult {
  waitUntilDone: () => Promise<void>;
}

type NotoSansSCWeight =
  | '100' | '200' | '300' | '400' | '500'
  | '600' | '700' | '800' | '900';

// Runtime-selected, finite imports are intentional: Vite emits one discoverable
// chunk per family instead of bundling every @remotion/google-fonts loader.
async function loadGoogleFace(family: string, fontWeight = 400): Promise<FontLoadResult> {
  switch (family) {
    case 'Anton': return (await import('@remotion/google-fonts/Anton')).loadFont();
    case 'Archivo Black': return (await import('@remotion/google-fonts/ArchivoBlack')).loadFont();
    case 'Bangers': return (await import('@remotion/google-fonts/Bangers')).loadFont();
    case 'Barlow Condensed': return (await import('@remotion/google-fonts/BarlowCondensed')).loadFont();
    case 'Bowlby One': return (await import('@remotion/google-fonts/BowlbyOne')).loadFont();
    case 'Caveat': return (await import('@remotion/google-fonts/Caveat')).loadFont();
    case 'Cormorant Garamond': return (await import('@remotion/google-fonts/CormorantGaramond')).loadFont();
    case 'DM Sans': return (await import('@remotion/google-fonts/DMSans')).loadFont();
    case 'Dancing Script': return (await import('@remotion/google-fonts/DancingScript')).loadFont();
    case 'Fraunces': return (await import('@remotion/google-fonts/Fraunces')).loadFont();
    case 'Fredoka': return (await import('@remotion/google-fonts/Fredoka')).loadFont();
    case 'Inter': return (await import('@remotion/google-fonts/Inter')).loadFont();
    case 'Inter Tight': return (await import('@remotion/google-fonts/InterTight')).loadFont();
    case 'LXGW WenKai TC': return (await import('@remotion/google-fonts/LXGWWenKaiTC')).loadFont();
    case 'Libre Baskerville': return (await import('@remotion/google-fonts/LibreBaskerville')).loadFont();
    case 'Montserrat': return (await import('@remotion/google-fonts/Montserrat')).loadFont();
    case 'Mulish': return (await import('@remotion/google-fonts/Mulish')).loadFont();
    case 'Newsreader': return (await import('@remotion/google-fonts/Newsreader')).loadFont();
    case 'Noto Serif SC': return (await import('@remotion/google-fonts/NotoSerifSC')).loadFont();
    case 'Noto Serif TC': return (await import('@remotion/google-fonts/NotoSerifTC')).loadFont();
    case 'Nunito': return (await import('@remotion/google-fonts/Nunito')).loadFont();
    case 'Oswald': return (await import('@remotion/google-fonts/Oswald')).loadFont();
    case 'Pinyon Script': return (await import('@remotion/google-fonts/PinyonScript')).loadFont();
    case 'Playfair Display': return (await import('@remotion/google-fonts/PlayfairDisplay')).loadFont();
    case 'Roboto': return (await import('@remotion/google-fonts/Roboto')).loadFont(undefined, { ignoreTooManyRequestsWarning: true });
    case 'Sora': return (await import('@remotion/google-fonts/Sora')).loadFont();
    case 'Space Mono': return (await import('@remotion/google-fonts/SpaceMono')).loadFont();
    case 'Special Elite': return (await import('@remotion/google-fonts/SpecialElite')).loadFont();
    case 'Unbounded': return (await import('@remotion/google-fonts/Unbounded')).loadFont();
    case 'VT323': return (await import('@remotion/google-fonts/VT323')).loadFont();
    case 'ZCOOL QingKe HuangYou': return (await import('@remotion/google-fonts/ZCOOLQingKeHuangYou')).loadFont();
    case 'Noto Sans SC': {
      const rounded = Math.min(900, Math.max(100, Math.round(fontWeight / 100) * 100));
      const weight = String(rounded) as NotoSansSCWeight;
      return (await import('@remotion/google-fonts/NotoSansSC')).loadFont('normal', {
        weights: [weight],
        subsets: ['chinese-simplified', 'latin'],
        ignoreTooManyRequestsWarning: true,
      });
    }
    default:
      throw new Error(`font loader unavailable: ${family}`);
  }
}

const fontPromises = new Map<string, Promise<void>>();

/** Load one referenced face and resolve only after browser/headless readiness. */
export function ensureFont(family: string, fontWeight = 400): Promise<void> {
  if (isGenericFontFamily(family)) return Promise.resolve();
  const canonical = resolveCanonicalFamily(family);
  if (!canonical) return Promise.resolve();
  if (findLocalFont(canonical)) return ensureLocalFont(canonical);
  const metadata = GOOGLE_FONT_CATALOG.find((entry) => entry.family === canonical);
  if (!metadata) return Promise.resolve();

  const faceKey = metadata.weighted ? `${canonical}:${fontWeight}` : canonical;
  const cached = fontPromises.get(faceKey);
  if (cached) return cached;
  const promise = loadGoogleFace(canonical, fontWeight)
    .then((font) => font.waitUntilDone())
    .catch((error: unknown) => {
      fontPromises.delete(faceKey);
      throw error;
    });
  fontPromises.set(faceKey, promise);
  return promise;
}

let runtimeReady = false;

/** Register bundled CJK FontFaces without downloading their bytes. */
export function loadProjectFonts(): void {
  if (runtimeReady) return;
  runtimeReady = true;
  try {
    registerLocalFonts();
  } catch {
    // Registration is opportunistic; explicit ensureFont() remains fail-closed.
  }
}
