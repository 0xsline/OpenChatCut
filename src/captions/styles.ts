import type { CaptionTemplate } from './types';

export interface CaptionStyle {
  id: CaptionTemplate;
  label: string;
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
}

// Source preset order and rendering values from the captured editor bundle.
export const CAPTION_STYLES: CaptionStyle[] = [
  { id: 'plain', label: 'Plain', fontFamily: 'Inter', fontSize: .042, fontWeight: 400, color: '#fff', highlightColor: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'persona', label: 'Persona', fontFamily: 'Mulish', fontSize: .06, fontWeight: 900, color: '#9C928A', highlightColor: '#1F1B17', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'off-the-wall', label: 'Off the Wall', fontFamily: 'Bangers', fontSize: .063, fontWeight: 400, color: '#000', highlightColor: '#000', highlightBackground: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: 'none', displayMode: 'stacked' },
  { id: 'the-french-dispatch', label: 'The French Dispatch', fontFamily: 'Newsreader', fontSize: .05, fontWeight: 500, color: '#0F0F0F', highlightColor: '#0F0F0F', highlightBackground: '#F6C239', strokeColor: '#000', strokeWidth: 0, textShadow: 'none', wordsPerPage: 3 },
  { id: 'dogme', label: 'Dogme', fontFamily: 'Archivo Black', fontSize: .042, fontWeight: 900, color: '#FCFCFA', highlightColor: '#FCFCFA', strokeColor: '#000', strokeWidth: 0, textShadow: '1px 0 0 #ff384033,-1px 0 0 #38b4ff33,0 1px 2px #000a,0 0 14px #0005', textTransform: 'uppercase' },
  { id: 'boyz-n-the-hood', label: 'Boyz n the Hood', fontFamily: 'Bowlby One', fontSize: .095, fontWeight: 400, color: '#fff', highlightColor: '#FFF200', strokeColor: '#000', strokeWidth: 5, textShadow: '0 0 6px #000b', textTransform: 'uppercase' },
  { id: 'bubble-pop', label: 'Bubble Pop', fontFamily: 'Bangers', fontSize: .1, fontWeight: 400, color: '#fff', highlightColor: '#FFEC1A', strokeColor: '#0A0A0A', strokeWidth: 5, textShadow: 'none', textTransform: 'uppercase', wordsPerPage: 2 },
  { id: 'submagic', label: 'Submagic', fontFamily: 'Mulish', fontSize: .07, fontWeight: 800, color: '#fff', highlightColor: '#0A0A0A', highlightBackground: '#00E83C', strokeColor: '#000', strokeWidth: 0, textShadow: 'none', displayMode: 'stacked' },
  { id: 'story', label: 'Story Yellow', fontFamily: 'DM Sans', fontSize: .037, fontWeight: 800, color: '#fff', highlightColor: '#FFD84A', strokeColor: '#1E1600', strokeWidth: 1, textShadow: '0 2px 6px #000d' },
  { id: 'bili', label: 'Bili Clean', fontFamily: 'Noto Sans SC', fontSize: .04, fontWeight: 800, color: '#F8FAFC', highlightColor: '#07121F', highlightBackground: '#6EE7F9', strokeColor: '#000c', strokeWidth: 1, textShadow: 'none' },
  { id: 'luxe', label: 'Luxe Serif', fontFamily: 'Playfair Display', fontSize: .039, fontWeight: 800, color: '#F8E8C6', highlightColor: '#17110A', highlightBackground: '#F8E8C6eb', strokeColor: '#000a', strokeWidth: .5, textShadow: 'none' },
  { id: 'noir', label: 'Noir Glass', fontFamily: 'Cormorant Garamond', fontSize: .041, fontWeight: 700, color: '#F5EFE3', highlightColor: '#FFF8EA', highlightBackground: '#8E263B', strokeColor: '#0009', strokeWidth: .5, textShadow: '0 3px 12px #000b' },
  { id: 'atelier', label: 'Atelier Cut', fontFamily: 'Fraunces', fontSize: .038, fontWeight: 800, color: '#24120A', highlightColor: '#FFF1DA', highlightBackground: '#B64A3B', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'product', label: 'Product Beam', fontFamily: 'Sora', fontSize: .038, fontWeight: 800, color: '#F7FFF9', highlightColor: '#071007', highlightBackground: '#A3FF12', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'signal', label: 'Signal Flux', fontFamily: 'Unbounded', fontSize: .034, fontWeight: 800, color: '#EAFBFF', highlightColor: '#061016', highlightBackground: '#4DFFDF', strokeColor: '#000', strokeWidth: 0, textShadow: '0 0 6px #4dffdf2e,0 3px 10px #000b', textTransform: 'uppercase' },
  { id: 'studio', label: 'Studio Clean', fontFamily: 'Inter Tight', fontSize: .038, fontWeight: 800, color: '#F8F7F2', highlightColor: '#111', highlightBackground: '#fffffff0', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'white-card', label: 'White Card', fontFamily: 'Inter Tight', fontSize: .042, fontWeight: 800, color: '#ABABAB', highlightColor: '#040404', strokeColor: '#040404', strokeWidth: 0, textShadow: 'none' },
  { id: 'bold-outline', label: 'Bold Outline', fontFamily: 'Inter Tight', fontSize: .042, fontWeight: 800, color: '#fff', highlightColor: '#fff', strokeColor: '#040404', strokeWidth: 11.5, textShadow: '0 3px 11px #000b', wordsPerPage: 3 },
  { id: 'deyi-card', label: 'Deyi Card', fontFamily: 'Smiley Sans', fontSize: .042, fontWeight: 400, color: '#fff', highlightColor: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'tiktok', label: 'TikTok Pop', fontFamily: 'Noto Sans SC', fontSize: .043, fontWeight: 900, color: '#FFFDF7', highlightColor: '#fff', highlightBackground: '#FF2E63', strokeColor: '#2B2118', strokeWidth: 2.5, textShadow: '0 3px 7px #000b' },
  { id: 'netflix', label: 'Netflix', fontFamily: 'Roboto', fontSize: .039, fontWeight: 400, color: '#fff', highlightColor: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: '2px 2px 3px #000b' },
];

export const CAPTION_STYLE_BY_ID = Object.fromEntries(CAPTION_STYLES.map((style) => [style.id, style])) as Record<CaptionTemplate, CaptionStyle>;
