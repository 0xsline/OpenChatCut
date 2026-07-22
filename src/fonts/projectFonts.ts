import { CAPTION_STYLES } from '../captions/styles';
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
  const style = CAPTION_STYLES.find((candidate) => candidate.id === captions.template);
  if (style?.fontFamily) pushFamily(into, style.fontFamily);
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
  for (const family of collectReferencedFonts(state)) ensureFont(family);
}
