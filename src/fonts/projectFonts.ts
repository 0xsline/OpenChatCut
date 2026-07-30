import { effectivePreset } from '../captions/renderStyles';
import type { CaptionsData } from '../captions/types';
import { captionTrackEntries, type TimelineItem, type TimelineState } from '../editor/types';
import { ensureFont } from './googleFonts';

const FONT_PROP_KEYS = new Set([
  'fontFamily', 'fontfamily', 'font_family', 'font', 'headingFont', 'bodyFont', 'titleFont',
]);

function pushFamily(into: Set<string>, raw: unknown): void {
  if (typeof raw !== 'string') return;
  for (const part of raw.split(',')) {
    const face = part.trim().replace(/^["']|["']$/g, '');
    if (face) into.add(face);
  }
}

function scanObjectForFonts(obj: unknown, into: Set<string>, depth = 0): void {
  if (!obj || depth > 6 || typeof obj === 'string') return;
  if (Array.isArray(obj)) {
    for (const value of obj) scanObjectForFonts(value, into, depth + 1);
    return;
  }
  if (typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (FONT_PROP_KEYS.has(key) || /fontfamily/i.test(key)) pushFamily(into, value);
    else if (value && typeof value === 'object') scanObjectForFonts(value, into, depth + 1);
  }
}

function scanCodeForFonts(code: string | undefined, into: Set<string>): void {
  if (!code) return;
  const re = /font(?:Family|-family)\s*[:=]\s*['"]([^'"]+)['"]/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) pushFamily(into, match[1]);
}

function fontsFromItem(item: TimelineItem, into: Set<string>): void {
  if (item.kind !== 'motion-graphic' && item.kind !== 'text') return;
  scanObjectForFonts(item.props, into);
  scanCodeForFonts(item.code, into);
}

function fontsFromCaptions(captions: CaptionsData | null | undefined, into: Set<string>): void {
  if (!captions?.enabled) return;
  const style = effectivePreset(captions);
  pushFamily(into, style.fontFamily);
  for (const entry of captions.sourceEntries ?? []) {
    if (entry.style?.fontFamily) pushFamily(into, entry.style.fontFamily);
  }
}

export function collectReferencedFonts(
  state: TimelineState,
  opts?: { captions?: CaptionsData | null },
): string[] {
  const families = new Set<string>();
  for (const item of state.items) fontsFromItem(item, families);
  if (opts && 'captions' in opts) fontsFromCaptions(opts.captions, families);
  else {
    const tracks = captionTrackEntries(state);
    if (tracks.length) tracks.forEach((entry) => fontsFromCaptions(entry.captions, families));
    else fontsFromCaptions(state.captions, families);
  }
  return [...families].sort((a, b) => a.localeCompare(b));
}

/** Register only fonts used by the active composition. Remotion waits on each loader. */
export function loadTimelineFonts(state: TimelineState): void {
  const weights = new Map<string, Set<number>>();
  const configs = captionTrackEntries(state).map((entry) => entry.captions).filter(Boolean) as CaptionsData[];
  if (!configs.length && state.captions) configs.push(state.captions);
  for (const captions of configs) {
    if (!captions.enabled) continue;
    const base = effectivePreset(captions);
    const faces = [{ family: base.fontFamily, weight: base.fontWeight }, ...(captions.sourceEntries ?? []).map((entry) => ({
      family: entry.style?.fontFamily ?? base.fontFamily,
      weight: entry.style?.fontWeight ?? base.fontWeight,
    }))];
    for (const face of faces) {
      const set = weights.get(face.family) ?? new Set<number>();
      set.add(face.weight);
      weights.set(face.family, set);
    }
  }
  for (const family of collectReferencedFonts(state)) {
    const fontWeights = weights.get(family);
    if (fontWeights?.size) fontWeights.forEach((weight) => ensureFont(family, weight));
    else ensureFont(family);
  }
}
