import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import type { TimelineItem, TimelineState } from '../editor/types';
import type { CaptionsData } from '../captions/types';
import { CAPTION_STYLES } from '../captions/styles';
import {
  isLoadableFontFamily,
  searchFontCatalog,
} from '../fonts/googleFonts';

// source search_fonts + helpers for submit_export confirmFontFallback gate.

type Args = Record<string, unknown>;

export const FONT_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'search_fonts',
    description: [
      'Search the font catalog the local/headless renderer can load (Google Fonts bundled in-app',
      '+ locally bundled Chinese foundry faces, source:"bundled"). Use when export reports unsupported',
      'fonts or when picking fontFamily for motion-graphic items / captions. Returns canonical family',
      'names to use verbatim. Substring-matches family AND native-name aliases',
      '(case/punctuation-insensitive) — e.g. "inter", "playfair", "noto sc", "得意黑", "鸿蒙",',
      '"抖音美好体". loadable=false means catalogued only; prefer a loadable alternative or',
      'confirmFontFallback on export.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to match against font family names or native-name aliases.',
        },
        projectId: {
          type: 'string',
          description: 'Ignored in local clone (single active project).',
        },
      },
      required: ['query'],
    },
  },
];

export const FONT_TOOL_NAMES = new Set(FONT_TOOL_SCHEMAS.map((t) => t.name));

export async function execFontTool(name: string, args: Args, _ctx: AgentContext): Promise<unknown> {
  if (name === 'search_fonts') return execSearchFonts(args);
  return { error: `unknown tool ${name}` };
}

function execSearchFonts(args: Args): unknown {
  const query = String(args.query ?? '').trim();
  if (!query) return { error: 'query is required', results: [] };
  const results = searchFontCatalog(query, 25);
  return {
    ok: true,
    query,
    count: results.length,
    results: results.map((r) => ({
      family: r.family,
      aliases: r.aliases,
      loadable: r.loadable,
      source: r.source,
    })),
    note: results.some((r) => !r.loadable)
      ? 'Some hits are catalog aliases only (loadable=false) — export may require confirmFontFallback=true.'
      : undefined,
  };
}

// ── Export font gate (used by generate-tools submit_export) ─────────────────

const FONT_PROP_KEYS = new Set([
  'fontFamily', 'fontfamily', 'font_family', 'font', 'headingFont', 'bodyFont', 'titleFont',
]);

function pushFamily(into: Set<string>, raw: unknown): void {
  if (typeof raw !== 'string') return;
  const s = raw.trim();
  if (!s) return;
  // split stacks; keep each face
  for (const part of s.split(',')) {
    const face = part.trim().replace(/^["']|["']$/g, '');
    if (face) into.add(face);
  }
}

function scanObjectForFonts(obj: unknown, into: Set<string>, depth = 0): void {
  if (!obj || depth > 6) return;
  if (typeof obj === 'string') {
    // only when looks like a fontFamily assignment was already handled; skip free text
    return;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) scanObjectForFonts(v, into, depth + 1);
    return;
  }
  if (typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (FONT_PROP_KEYS.has(k) || /fontfamily/i.test(k)) {
      pushFamily(into, v);
    } else if (v && typeof v === 'object') {
      scanObjectForFonts(v, into, depth + 1);
    }
  }
}

function scanCodeForFonts(code: string | undefined, into: Set<string>): void {
  if (!code) return;
  const re = /font(?:Family|-family)\s*[:=]\s*['"]([^'"]+)['"]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    pushFamily(into, m[1]);
  }
}

function fontsFromItem(item: TimelineItem, into: Set<string>): void {
  if (item.kind === 'motion-graphic' || item.kind === 'text') {
    scanObjectForFonts(item.props, into);
    scanCodeForFonts(item.code, into);
  }
}

function fontsFromCaptions(captions: CaptionsData | null | undefined, into: Set<string>): void {
  if (!captions?.enabled) return;
  const style = CAPTION_STYLES.find((s) => s.id === captions.template);
  if (style?.fontFamily) pushFamily(into, style.fontFamily);
}

/**
 * Collect unique font faces burned into export:
 * - motion-graphic / text props + code
 * - enabled captions template fontFamily
 * (designStyle is generation guidance only — not gated unless already on a clip)
 */
export function collectReferencedFonts(
  state: TimelineState,
  opts?: { captions?: CaptionsData | null },
): string[] {
  const set = new Set<string>();
  for (const item of state.items) fontsFromItem(item, set);
  fontsFromCaptions(opts?.captions ?? state.captions, set);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export interface UnsupportedFontReport {
  unsupported: string[];
  referenced: string[];
}

/** Fonts that the local/headless renderer cannot load (export gate). */
export function findUnsupportedFonts(
  state: TimelineState,
  opts?: { captions?: CaptionsData | null },
): UnsupportedFontReport {
  const referenced = collectReferencedFonts(state, opts);
  const unsupported = referenced.filter((f) => !isLoadableFontFamily(f));
  return { unsupported, referenced };
}

/**
 * If unsupported fonts exist and confirmFontFallback is not true, return a
 * gate error object (source confirmFontFallback). Otherwise null (proceed).
 */
export function fontFallbackGate(
  state: TimelineState,
  confirmFontFallback: unknown,
  opts?: { captions?: CaptionsData | null },
): Record<string, unknown> | null {
  const { unsupported, referenced } = findUnsupportedFonts(state, opts);
  if (!unsupported.length) return null;
  if (confirmFontFallback === true) return null;
  return {
    ok: false,
    error: 'unsupported_fonts',
    message:
      'Timeline references fonts the renderer cannot load. Tell the user which fonts will fall back, then retry submit_export with confirmFontFallback=true only after they accept.',
    unsupportedFonts: unsupported,
    referencedFonts: referenced,
    hint: 'Use search_fonts to pick a loadable family, or pass confirmFontFallback: true after user consent.',
  };
}
