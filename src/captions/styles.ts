import type { CaptionTemplate } from './types';

export interface CaptionStyle {
  id: CaptionTemplate;
  /** English preset name. */
  label: string;
  /** 中文说明（控件展示用） */
  labelZh: string;
  /** 一句话告诉用户这是什么观感 */
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
  /** 整句连续渲染:一页拼成一条文本(无词间隙、无逐词高亮),背景包住整行 */
  wholeLine?: boolean;
  /** wholeLine 的整行背景色(如经典黑底字幕条) */
  background?: string;
}

// The first 9 presets follow PRD §4.17 (bundle only evidences "Bubble Pop" —
// preset values are server-side); the other 12 presets are custom extensions.
// labelZh/hint are local UX.
export const CAPTION_STYLES: CaptionStyle[] = [
  { id: 'plain', label: 'Plain', labelZh: '简洁白字', hint: '白字无底，适合口播', fontFamily: 'Inter', fontSize: .042, fontWeight: 400, color: '#fff', highlightColor: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'black-bar', label: 'Subtitle Bar', labelZh: '黑底白字', hint: '整句黑底条，经典字幕（默认）', fontFamily: 'Noto Sans SC', fontSize: .04, fontWeight: 700, color: '#fff', highlightColor: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: 'none', wholeLine: true, background: '#000000c9' },
  { id: 'netflix', label: 'Netflix', labelZh: '影院白字', hint: '轻阴影，像正片字幕', fontFamily: 'Roboto', fontSize: .039, fontWeight: 400, color: '#fff', highlightColor: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: '2px 2px 3px #000b' },
  { id: 'bili', label: 'Bili Clean', labelZh: '清爽高亮', hint: '青底高亮当前词，中文友好', fontFamily: 'Noto Sans SC', fontSize: .04, fontWeight: 800, color: '#F8FAFC', highlightColor: '#07121F', highlightBackground: '#6EE7F9', strokeColor: '#000c', strokeWidth: 1, textShadow: 'none' },
  { id: 'tiktok', label: 'TikTok Pop', labelZh: '短视频撞色', hint: '粉红高亮，适合竖屏', fontFamily: 'Noto Sans SC', fontSize: .043, fontWeight: 900, color: '#FFFDF7', highlightColor: '#fff', highlightBackground: '#FF2E63', strokeColor: '#2B2118', strokeWidth: 2.5, textShadow: '0 3px 7px #000b' },
  { id: 'story', label: 'Story Yellow', labelZh: '故事黄高亮', hint: '白字 + 黄高亮', fontFamily: 'DM Sans', fontSize: .037, fontWeight: 800, color: '#fff', highlightColor: '#FFD84A', strokeColor: '#1E1600', strokeWidth: 1, textShadow: '0 2px 6px #000d' },
  { id: 'bold-outline', label: 'Bold Outline', labelZh: '粗描边', hint: '强描边，远看也清晰', fontFamily: 'Inter Tight', fontSize: .042, fontWeight: 800, color: '#fff', highlightColor: '#fff', strokeColor: '#040404', strokeWidth: 11.5, textShadow: '0 3px 11px #000b', wordsPerPage: 3 },
  { id: 'studio', label: 'Studio Clean', labelZh: '工作室白底', hint: '深字浅底，干净', fontFamily: 'Inter Tight', fontSize: .038, fontWeight: 800, color: '#F8F7F2', highlightColor: '#111', highlightBackground: '#fffffff0', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'white-card', label: 'White Card', labelZh: '白卡片', hint: '灰字白底卡片', fontFamily: 'Inter Tight', fontSize: .042, fontWeight: 800, color: '#ABABAB', highlightColor: '#040404', strokeColor: '#040404', strokeWidth: 0, textShadow: 'none' },
  { id: 'the-french-dispatch', label: 'The French Dispatch', labelZh: '杂志黄标', hint: '黑字黄高亮，文艺', fontFamily: 'Newsreader', fontSize: .05, fontWeight: 500, color: '#0F0F0F', highlightColor: '#0F0F0F', highlightBackground: '#F6C239', strokeColor: '#000', strokeWidth: 0, textShadow: 'none', wordsPerPage: 3 },
  { id: 'bubble-pop', label: 'Bubble Pop', labelZh: '气泡大字', hint: '大号撞色，强调词', fontFamily: 'Bangers', fontSize: .1, fontWeight: 400, color: '#fff', highlightColor: '#FFEC1A', strokeColor: '#0A0A0A', strokeWidth: 5, textShadow: 'none', textTransform: 'uppercase', wordsPerPage: 2 },
  { id: 'submagic', label: 'Submagic', labelZh: '绿底堆叠', hint: '绿色高亮、可堆叠', fontFamily: 'Mulish', fontSize: .07, fontWeight: 800, color: '#fff', highlightColor: '#0A0A0A', highlightBackground: '#00E83C', strokeColor: '#000', strokeWidth: 0, textShadow: 'none', displayMode: 'stacked' },
  { id: 'off-the-wall', label: 'Off the Wall', labelZh: '黑白堆叠', hint: '黑字白底，堆叠两行', fontFamily: 'Bangers', fontSize: .063, fontWeight: 400, color: '#000', highlightColor: '#000', highlightBackground: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: 'none', displayMode: 'stacked' },
  { id: 'boyz-n-the-hood', label: 'Boyz n the Hood', labelZh: '黄字大标题', hint: '超大字 + 黄高亮', fontFamily: 'Bowlby One', fontSize: .095, fontWeight: 400, color: '#fff', highlightColor: '#FFF200', strokeColor: '#000', strokeWidth: 5, textShadow: '0 0 6px #000b', textTransform: 'uppercase' },
  { id: 'dogme', label: 'Dogme', labelZh: '霓虹大写', hint: '全大写 + 彩边光', fontFamily: 'Archivo Black', fontSize: .042, fontWeight: 900, color: '#FCFCFA', highlightColor: '#FCFCFA', strokeColor: '#000', strokeWidth: 0, textShadow: '1px 0 0 #ff384033,-1px 0 0 #38b4ff33,0 1px 2px #000a,0 0 14px #0005', textTransform: 'uppercase' },
  { id: 'persona', label: 'Persona', labelZh: '灰调衬线', hint: '灰字，偏设计感', fontFamily: 'Mulish', fontSize: .06, fontWeight: 900, color: '#9C928A', highlightColor: '#1F1B17', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'luxe', label: 'Luxe Serif', labelZh: '奢华金', hint: '金色字，典雅', fontFamily: 'Playfair Display', fontSize: .039, fontWeight: 800, color: '#F8E8C6', highlightColor: '#17110A', highlightBackground: '#F8E8C6eb', strokeColor: '#000a', strokeWidth: .5, textShadow: 'none' },
  { id: 'noir', label: 'Noir Glass', labelZh: '暗夜红', hint: '暗调 + 红高亮', fontFamily: 'Cormorant Garamond', fontSize: .041, fontWeight: 700, color: '#F5EFE3', highlightColor: '#FFF8EA', highlightBackground: '#8E263B', strokeColor: '#0009', strokeWidth: .5, textShadow: '0 3px 12px #000b' },
  { id: 'atelier', label: 'Atelier Cut', labelZh: '工坊红底', hint: '深字红底高亮', fontFamily: 'Fraunces', fontSize: .038, fontWeight: 800, color: '#24120A', highlightColor: '#FFF1DA', highlightBackground: '#B64A3B', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'product', label: 'Product Beam', labelZh: '产品绿标', hint: '青白字 + 荧光绿', fontFamily: 'Sora', fontSize: .038, fontWeight: 800, color: '#F7FFF9', highlightColor: '#071007', highlightBackground: '#A3FF12', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
  { id: 'signal', label: 'Signal Flux', labelZh: '信号青', hint: '科技风青绿高亮', fontFamily: 'Unbounded', fontSize: .034, fontWeight: 800, color: '#EAFBFF', highlightColor: '#061016', highlightBackground: '#4DFFDF', strokeColor: '#000', strokeWidth: 0, textShadow: '0 0 6px #4dffdf2e,0 3px 10px #000b', textTransform: 'uppercase' },
  { id: 'deyi-card', label: 'Deyi Card', labelZh: '得意黑', hint: '中文展示字体', fontFamily: 'Smiley Sans', fontSize: .042, fontWeight: 400, color: '#fff', highlightColor: '#fff', strokeColor: '#000', strokeWidth: 0, textShadow: 'none' },
];

export const CAPTION_STYLE_BY_ID = Object.fromEntries(CAPTION_STYLES.map((style) => [style.id, style])) as Record<CaptionTemplate, CaptionStyle>;

// Custom per-caption style patch layered OVER the chosen template preset
// (edit_captions action=style). Only the visual fields — id/label/hint stay the
// preset's. Rendered by CaptionsLayer as { ...preset, ...styleOverride }.
export type CaptionStyleOverride = Partial<Omit<CaptionStyle, 'id' | 'label' | 'labelZh' | 'hint'>>;
