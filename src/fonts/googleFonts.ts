import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadRoboto } from '@remotion/google-fonts/Roboto';
import { loadFont as loadOswald } from '@remotion/google-fonts/Oswald';
import { loadFont as loadNunito } from '@remotion/google-fonts/Nunito';

// Google Fonts the ~211 MG templates + the captions overlay reference
// (Inter ×23, Roboto ×6, Oswald ×2, Nunito ×1 — the rest are system fonts:
// Georgia / Arial / serif, which need no loading). Loading these makes the
// headless export render match the Player preview instead of falling back to a
// default face. Source-faithful: ChatCut loads Google Fonts + gates export on a
// font-fallback check (复刻规格 §10 confirmFontFallback / search_fonts).
//
// loadFont() registers the @font-face for the browser preview and a delayRender
// in the headless renderer, so both preview and export wait for the real font.
let loaded = false;

export function loadProjectFonts(): void {
  if (loaded) return;
  loaded = true;
  loadInter();
  loadRoboto();
  loadOswald();
  loadNunito();
}
