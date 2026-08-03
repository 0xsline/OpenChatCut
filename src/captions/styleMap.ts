import type { CaptionPacing } from './types';
import type { CaptionStyleOverride } from './styles';

// Map an edit_captions `style` JSON payload onto the serializable caption
// model. Typography, paint and box fields are consumed by the same shared
// render helpers in the Player preview and Remotion export. Fields with no
// representable target are reported through `ignored`, never silently dropped.
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
const UNSUPPORTED: Record<string, true> = {
  opacity: true, variant: true, maxLines: true, maxCharactersPerLine: true, maxCharsPerLine: true,
  direction: true, highlightUnit: true, hidePunctuation: true,
};

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
  const font = str(json.fontFamily) ?? str(json.font);
  if (font) o.fontFamily = font;
  const sizePx = num(json.sizePx);
  const fontSizeRatio = num(json.fontSizeRatio) ?? num(json.fontSize);
  if (sizePx !== undefined && canvasHeight > 0) o.fontSize = Math.max(0.001, sizePx / canvasHeight);
  else if (fontSizeRatio !== undefined) o.fontSize = Math.max(0.001, fontSizeRatio);
  const weight = num(json.weight) ?? num(json.fontWeight);
  if (weight !== undefined) o.fontWeight = Math.max(1, Math.min(1000, weight));
  const fontStyle = str(json.fontStyle);
  if (fontStyle === 'normal' || fontStyle === 'italic' || fontStyle === 'oblique') o.fontStyle = fontStyle;
  const textAlign = str(json.textAlign) ?? str(json.align);
  if (textAlign === 'left' || textAlign === 'center' || textAlign === 'right') o.textAlign = textAlign;
  if (typeof json.underline === 'boolean') o.underline = json.underline;
  if (typeof json.strike === 'boolean') o.strike = json.strike;
  const letterSpacing = num(json.letterSpacing);
  if (letterSpacing !== undefined) o.letterSpacing = letterSpacing;
  const lineHeight = num(json.lineHeight);
  if (lineHeight !== undefined && lineHeight > 0) o.lineHeight = lineHeight;
  const color = str(json.color);
  if (color) o.color = color;

  // stroke
  const strokeColor = str(json.strokeColor);
  if (strokeColor) o.strokeColor = strokeColor;
  if (json.strokeOff === true) o.strokeWidth = 0;
  else { const sw = num(json.strokeWidth); if (sw !== undefined) o.strokeWidth = Math.max(0, sw); }
  const strokeOpacity = num(json.strokeOpacity);
  if (strokeOpacity !== undefined) o.strokeOpacity = Math.max(0, Math.min(1, strokeOpacity));

  // current-word highlight
  const highlightColor = str(json.highlightColor);
  if (highlightColor) o.highlightColor = highlightColor;
  const hb = json.highlightBackground;
  if (hb && typeof hb === 'object') { const c = str((hb as { color?: unknown }).color); if (c) o.highlightBackground = c; }
  else { const hbs = str(hb); if (hbs) o.highlightBackground = hbs; }
  if (json.highlightOff === true) o.highlightBackground = 'transparent';

  // shadow: raw CSS wins; else strength 0–100 → a soft drop shadow; else off
  const shadow = str(json.shadow);
  const shadowStrength = num(json.shadowStrength);
  if (json.shadowOff === true) o.textShadow = 'none';
  else if (shadow) o.textShadow = shadow;
  else if (shadowStrength !== undefined) {
    const a = Math.max(0, Math.min(100, shadowStrength)) / 100;
    o.textShadow = a === 0 ? 'none' : `0 2px 8px rgba(0,0,0,${a.toFixed(2)})`;
  }
  const textShadowSize = num(json.textShadowSize);
  if (textShadowSize !== undefined) o.textShadowSize = Math.max(0, textShadowSize);

  const background = str(json.background) ?? str(json.backgroundColor);
  if (json.backgroundOff === true) o.background = 'transparent';
  else if (background) o.background = background;
  const backgroundOpacity = num(json.backgroundOpacity);
  if (backgroundOpacity !== undefined) o.backgroundOpacity = Math.max(0, Math.min(1, backgroundOpacity));

  const boxBorderColor = str(json.boxBorderColor);
  if (boxBorderColor) o.boxBorderColor = boxBorderColor;
  const boxBorderWidth = num(json.boxBorderWidth);
  if (boxBorderWidth !== undefined) o.boxBorderWidth = Math.max(0, boxBorderWidth);
  const boxBorderOpacity = num(json.boxBorderOpacity);
  if (boxBorderOpacity !== undefined) o.boxBorderOpacity = Math.max(0, Math.min(1, boxBorderOpacity));
  const boxBorderRadius = num(json.boxBorderRadius) ?? num(json.borderRadius) ?? num(json.backgroundRadius);
  if (boxBorderRadius !== undefined) o.boxBorderRadius = Math.max(0, boxBorderRadius);
  const boxShadow = str(json.boxShadow);
  if (boxShadow) o.boxShadow = boxShadow;
  const boxShadowSize = num(json.boxShadowSize);
  if (boxShadowSize !== undefined) o.boxShadowSize = Math.max(0, boxShadowSize);

  // typography / display
  const tt = str(json.textTransform);
  if (tt === 'uppercase' || tt === 'none') o.textTransform = tt;
  const dm = str(json.displayMode);
  if (dm === 'stacked') o.displayMode = 'stacked';
  else if (dm === 'single') o.displayMode = 'inline';
  const wpp = num(json.wordsPerPage);
  if (wpp !== undefined) o.wordsPerPage = Math.max(1, Math.round(wpp));

  const pacing = mapPacing(json.pacing);

  // Report any input fields this build cannot represent.
  const applied: Record<string, true> = {
    font: true, fontFamily: true, sizePx: true, fontSizeRatio: true, fontSize: true, weight: true, fontWeight: true,
    fontStyle: true, textAlign: true, align: true, underline: true, strike: true, letterSpacing: true, lineHeight: true, color: true,
    strokeColor: true, strokeWidth: true, strokeOff: true, strokeOpacity: true,
    highlightColor: true, highlightBackground: true, highlightOff: true,
    shadow: true, shadowStrength: true, shadowOff: true, textShadowSize: true,
    background: true, backgroundColor: true, backgroundOpacity: true, backgroundRadius: true, backgroundOff: true, borderRadius: true,
    boxBorderColor: true, boxBorderWidth: true, boxBorderOpacity: true, boxBorderRadius: true, boxShadow: true, boxShadowSize: true,
    textTransform: true, displayMode: true, wordsPerPage: true, pacing: true,
  };
  for (const k of Object.keys(json)) if (!applied[k]) ignored.push(k + (UNSUPPORTED[k] ? '' : '?'));

  return { styleOverride: o, pacing, ignored };
}
