// Google Fonts referenced by the design-style presets (editor/design-presets.ts),
// the caption styles (captions/styles.ts) and the ~211 MG templates. We load them
// so the browser Player preview AND the headless export (remotion/Root.tsx both
// call loadProjectFonts) burn in the real faces instead of falling back to a
// default. loadFont() registers the @font-face (unicode-range keeps the actual
// glyph download lazy) + a delayRender the headless renderer waits on.
//
// Source-faithful: ChatCut loads Google Fonts + gates export on a font-fallback
// check (复刻规格 §10 confirmFontFallback / search_fonts — the check/tool itself
// is still TODO). Presets also reference 7 Chinese foundry faces (得意黑/OPPO Sans/
// 鸿蒙/抖音美好体/庞门正道/胡晓波…) that aren't on Google Fonts — those still fall
// back until self-hosted.
//
// ponytail: eager-load the whole referenced set (~32) once. Simple + correct;
// unicode-range makes browser downloads on-demand so cost is mostly the CSS. If
// startup/render time ever bites, upgrade to per-project loading keyed off the
// applied design style + caption style + placed items' fontFamily.
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

// One loader per referenced Google family (importName → loadFont).
const FONT_LOADERS: ReadonlyArray<() => unknown> = [
  loadAnton, loadArchivoBlack, loadBangers, loadBarlowCondensed, loadBowlbyOne,
  loadCaveat, loadCormorantGaramond, loadDMSans, loadDancingScript, loadFraunces,
  loadFredoka, loadInter, loadInterTight, loadLXGWWenKaiTC, loadLibreBaskerville,
  loadMontserrat, loadMulish, loadNewsreader, loadNotoSansSC, loadNotoSerifSC,
  loadNotoSerifTC, loadNunito, loadOswald, loadPinyonScript, loadPlayfairDisplay,
  loadRoboto, loadSora, loadSpaceMono, loadSpecialElite, loadUnbounded,
  loadVT323, loadZCOOLQingKeHuangYou,
];

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
