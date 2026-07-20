import type { CaptionPacing } from './types';
import type { CaptionStyleOverride } from './styles';

// Map an edit_captions `style` JSON payload onto OpenChatCut's caption style
// surface. The payload supports a rich style vocabulary; captions use
// preset fields (font/size/color/stroke/highlight/shadow/case/displayMode/
// wordsPerPage) plus pacing. We translate what maps and REPORT what we dropped
// (`ignored`) so the agent gets honest feedback instead of a silent no-op.
//
// Pure + synchronous: (json, canvasHeight) → { styleOverride, pacing?, ignored }.

export interface StyleMapResult {
  styleOverride: CaptionStyleOverride;
  pacing?: CaptionPacing;
  ignored: string[];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Style fields with no representable target → reported, not applied. */
const UNSUPPORTED = new Set([
  'opacity', 'align', 'variant', 'strokeOpacity', 'maxLines', 'maxCharactersPerLine', 'maxCharsPerLine',
  'lineHeight', 'letterSpacing', 'direction', 'highlightUnit', 'hidePunctuation',
  'backgroundColor', 'backgroundOpacity', 'backgroundRadius', 'backgroundOff',
]);

/** Pacing vocabulary → OpenChatCut's two modes (auto/phrase/sentence → phrase). */
function mapPacing(v: unknown): CaptionPacing | undefined {
  const p = str(v);
  if (!p) return undefined;
  if (p === 'word') return 'word';
  if (p === 'phrase' || p === 'auto' || p === 'sentence') return 'phrase';
  return undefined;
}

export function mapCaptionStyle(json: Record<string, unknown>, canvasHeight: number): StyleMapResult {
  const o: CaptionStyleOverride = {};
  const ignored: string[] = [];

  // text
  const font = str(json.font);
  if (font) o.fontFamily = font;
  const sizePx = num(json.sizePx);
  const fontSizeRatio = num(json.fontSizeRatio);
  if (sizePx !== undefined && canvasHeight > 0) o.fontSize = sizePx / canvasHeight;
  else if (fontSizeRatio !== undefined) o.fontSize = fontSizeRatio;
  const weight = num(json.weight) ?? num(json.fontWeight);
  if (weight !== undefined) o.fontWeight = weight;
  const color = str(json.color);
  if (color) o.color = color;

  // stroke
  const strokeColor = str(json.strokeColor);
  if (strokeColor) o.strokeColor = strokeColor;
  if (json.strokeOff === true) o.strokeWidth = 0;
  else { const sw = num(json.strokeWidth); if (sw !== undefined) o.strokeWidth = sw; }

  // current-word highlight
  const highlightColor = str(json.highlightColor);
  if (highlightColor) o.highlightColor = highlightColor;
  const hb = json.highlightBackground;
  if (hb && typeof hb === 'object') { const c = str((hb as { color?: unknown }).color); if (c) o.highlightBackground = c; }
  else { const hbs = str(hb); if (hbs) o.highlightBackground = hbs; }
  if (json.highlightOff === true) o.highlightBackground = undefined;

  // shadow: raw CSS wins; else strength 0–100 → a soft drop shadow; else off
  const shadow = str(json.shadow);
  const shadowStrength = num(json.shadowStrength);
  if (json.shadowOff === true) o.textShadow = 'none';
  else if (shadow) o.textShadow = shadow;
  else if (shadowStrength !== undefined) {
    const a = Math.max(0, Math.min(100, shadowStrength)) / 100;
    o.textShadow = a === 0 ? 'none' : `0 2px 8px rgba(0,0,0,${a.toFixed(2)})`;
  }

  // typography / display
  const tt = str(json.textTransform);
  if (tt === 'uppercase' || tt === 'none') o.textTransform = tt;
  const dm = str(json.displayMode);
  if (dm === 'stacked') o.displayMode = 'stacked';
  else if (dm === 'single') o.displayMode = undefined;
  const wpp = num(json.wordsPerPage);
  if (wpp !== undefined) o.wordsPerPage = Math.max(1, Math.round(wpp));

  const pacing = mapPacing(json.pacing);

  // Report any input fields this build cannot represent.
  const applied = new Set(['font', 'sizePx', 'fontSizeRatio', 'weight', 'fontWeight', 'color', 'strokeColor', 'strokeWidth', 'strokeOff', 'highlightColor', 'highlightBackground', 'highlightOff', 'shadow', 'shadowStrength', 'shadowOff', 'textTransform', 'displayMode', 'wordsPerPage', 'pacing']);
  for (const k of Object.keys(json)) if (!applied.has(k)) ignored.push(k + (UNSUPPORTED.has(k) ? '' : '?'));

  return { styleOverride: o, pacing, ignored };
}
