import type { CaptionTemplate } from './types';

export interface CaptionStyle {
  id: CaptionTemplate;
  /** English preset name. */
  label: string;
  /** Chinese description (for control display) */
  labelZh: string;
  /** Tell the user in one sentence what the impression is */
  hint: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  highlightColor: string;
  highlightBackground?: string;
  strokeColor: string;
  strokeWidth: number;
  textShadow: string;
  textTransform?: 'none' | 'uppercase';
  displayMode?: 'stacked';
  wordsPerPage?: number;
  /** Continuous rendering of the entire sentence:A page of text spelled out(No word gaps, no word-by-word highlighting),The background wraps the entire row */
  wholeLine?: boolean;
  /** wholeLine The background color of the entire row(Such as the classic black background subtitle strip) */
  background?: string;
}

// The first 9 presets follow PRD §4.17 (bundle only evidences "Bubble Pop" —
// preset values are server-side); the other 12 presets are custom extensions.
// labelZh/hint are local UX.
export const CAPTION_STYLES: CaptionStyle[] = [
  { id: 'plain', label: 'Plain', labelZh: 'Simple white text', hint: 'The white text has no bottom, suitable for oral broadcasting', fontFamily: 'Inter', fontSize: .042, fontWeight: 400, color: '#fff', highlightColor: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'black-bar', label: 'Subtitle Bar', labelZh: 'White text on black background', hint: 'Black background for the entire sentence, classic subtitles (default)', fontFamily: 'Noto Sans SC', fontSize: .04, fontWeight: 700, color: '#fff', highlightColor: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: 'none', wholeLine: true, background: '#000000c9' },
  { id: 'netflix', label: 'Netflix', labelZh: 'Cinema white text', hint: 'Light shadow, like subtitles in the main film', fontFamily: 'Roboto', fontSize: .039, fontWeight: 400, color: '#fff', highlightColor: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: '2px 2px 3px #000b' },
  { id: 'bili', label: 'Bili Clean', labelZh: 'Refreshing and bright', hint: 'Green background highlights the current word, Chinese friendly', fontFamily: 'Noto Sans SC', fontSize: .04, fontWeight: 800, color: '#F8FAFC', highlightColor: '#07121F', highlightBackground: '#6EE7F9', strokeColor: '#000c', strokeWidth: 1, textShadow: 'none' },
  { id: 'tiktok', label: 'TikTok Pop', labelZh: 'Short video color contrast', hint: 'Pink highlight, suitable for vertical screen', fontFamily: 'Noto Sans SC', fontSize: .043, fontWeight: 900, color: '#FFFDF7', highlightColor: '#fff', highlightBackground: '#FF2E63', strokeColor: '#2B2118', strokeWidth: 2.5, textShadow: '0 3px 7px #000b' },
  { id: 'story', label: 'Story Yellow', labelZh: 'Story Huang Gaoliang', hint: 'White letters + Huang Gaoliang', fontFamily: 'DM Sans', fontSize: .037, fontWeight: 800, color: '#fff', highlightColor: '#FFD84A', strokeColor: '#1E1600', strokeWidth: 1, textShadow: '0 2px 6px #000d' },
  { id: 'bold-outline', label: 'Bold Outline', labelZh: 'thick stroke', hint: 'Strong strokes, clear even from a distance', fontFamily: 'Inter Tight', fontSize: .042, fontWeight: 800, color: '#fff', highlightColor: '#fff', strokeColor: '#040404', strokeWidth: 11.5, textShadow: '0 3px 11px #000b', wordsPerPage: 3 },
  { id: 'studio', label: 'Studio Clean', labelZh: 'Studio white background', hint: 'Deep characters and shallow background, clean', fontFamily: 'Inter Tight', fontSize: .038, fontWeight: 800, color: '#F8F7F2', highlightColor: '#111', highlightBackground: '#fffffff0', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'white-card', label: 'White Card', labelZh: 'white card', hint: 'Gray text on white background card', fontFamily: 'Inter Tight', fontSize: .042, fontWeight: 800, color: '#ABABAB', highlightColor: '#040404', strokeColor: '#040404', strokeWidth: 0, textShadow: 'none' },
  { id: 'the-french-dispatch', label: 'The French Dispatch', labelZh: 'Magazine yellow label', hint: 'Black text with yellow highlight, literature and art', fontFamily: 'Newsreader', fontSize: .05, fontWeight: 500, color: '#0F0F0F', highlightColor: '#0F0F0F', highlightBackground: '#F6C239', strokeColor: '#000', strokeWidth: 0, textShadow: 'none', wordsPerPage: 3 },
  { id: 'bubble-pop', label: 'Bubble Pop', labelZh: 'Bubble characters', hint: 'Large contrasting colors, emphasis words', fontFamily: 'Bangers', fontSize: .1, fontWeight: 400, color: '#fff', highlightColor: '#FFEC1A', strokeColor: '#0A0A0A', strokeWidth: 5, textShadow: 'none', textTransform: 'uppercase', wordsPerPage: 2 },
  { id: 'submagic', label: 'Submagic', labelZh: 'green bottom stack', hint: 'Green highlight, stackable', fontFamily: 'Mulish', fontSize: .07, fontWeight: 800, color: '#fff', highlightColor: '#0A0A0A', highlightBackground: '#00E83C', strokeColor: '#000', strokeWidth: 0, textShadow: 'none', displayMode: 'stacked' },
  { id: 'off-the-wall', label: 'Off the Wall', labelZh: 'black and white stack', hint: 'Black text on white background, two stacked lines', fontFamily: 'Bangers', fontSize: .063, fontWeight: 400, color: '#000', highlightColor: '#000', highlightBackground: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: 'none', displayMode: 'stacked' },
  { id: 'boyz-n-the-hood', label: 'Boyz n the Hood', labelZh: 'Yellow headline', hint: 'Extra large characters + Huang Gaoliang', fontFamily: 'Bowlby One', fontSize: .095, fontWeight: 400, color: '#fff', highlightColor: '#FFF200', strokeColor: '#000', strokeWidth: 5, textShadow: '0 0 6px #000b', textTransform: 'uppercase' },
  { id: 'dogme', label: 'Dogme', labelZh: 'neon capitals', hint: 'ALL CAPS + Color edge light', fontFamily: 'Archivo Black', fontSize: .042, fontWeight: 900, color: '#FCFCFA', highlightColor: '#FCFCFA', strokeColor: '#000', strokeWidth: 0, textShadow: '1px 0 0 #ff384033,-1px 0 0 #38b4ff33,0 1px 2px #000a,0 0 14px #0005', textTransform: 'uppercase' },
  { id: 'persona', label: 'Persona', labelZh: 'Gray tone serif', hint: 'Gray characters, more design sense', fontFamily: 'Mulish', fontSize: .06, fontWeight: 900, color: '#9C928A', highlightColor: '#1F1B17', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'luxe', label: 'Luxe Serif', labelZh: 'luxury gold', hint: 'Golden words, elegant', fontFamily: 'Playfair Display', fontSize: .039, fontWeight: 800, color: '#F8E8C6', highlightColor: '#17110A', highlightBackground: '#F8E8C6eb', strokeColor: '#000a', strokeWidth: .5, textShadow: 'none' },
  { id: 'noir', label: 'Noir Glass', labelZh: 'dark night red', hint: 'dark tone + red highlight', fontFamily: 'Cormorant Garamond', fontSize: .041, fontWeight: 700, color: '#F5EFE3', highlightColor: '#FFF8EA', highlightBackground: '#8E263B', strokeColor: '#0009', strokeWidth: .5, textShadow: '0 3px 12px #000b' },
  { id: 'atelier', label: 'Atelier Cut', labelZh: 'Workshop red bottom', hint: 'Dark letters with red background and highlights', fontFamily: 'Fraunces', fontSize: .038, fontWeight: 800, color: '#24120A', highlightColor: '#FFF1DA', highlightBackground: '#B64A3B', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'product', label: 'Product Beam', labelZh: 'Product green label', hint: 'blue and white characters + fluorescent green', fontFamily: 'Sora', fontSize: .038, fontWeight: 800, color: '#F7FFF9', highlightColor: '#071007', highlightBackground: '#A3FF12', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'signal', label: 'Signal Flux', labelZh: 'Signal green', hint: 'Technology style green and bright', fontFamily: 'Unbounded', fontSize: .034, fontWeight: 800, color: '#EAFBFF', highlightColor: '#061016', highlightBackground: '#4DFFDF', strokeColor: '#000', strokeWidth: 0, textShadow: '0 0 6px #4dffdf2e,0 3px 10px #000b', textTransform: 'uppercase' },
  { id: 'deyi-card', label: 'Deyi Card', labelZh: 'proudly black', hint: 'Chinese display font', fontFamily: 'Smiley Sans', fontSize: .042, fontWeight: 400, color: '#fff', highlightColor: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
];

export const CAPTION_STYLE_BY_ID = Object.fromEntries(CAPTION_STYLES.map((style) => [style.id, style])) as Record<CaptionTemplate, CaptionStyle>;

// Custom per-caption style patch layered OVER the chosen template preset
// (edit_captions action=style). Only the visual fields — id/label/hint stay the
// preset's. Rendered by CaptionsLayer as { ...preset, ...styleOverride }.
export type CaptionStyleOverride = Partial<Omit<CaptionStyle, 'id' | 'label' | 'labelZh' | 'hint'>>;
