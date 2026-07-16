// 厂商图标:圆角方块 + 品牌底色 + 居中 monogram,完全自包含,不引任何外部资源。
// 品牌色近似,本地复刻用(非官方精确色值)。
import type { CSSProperties } from 'react';

export type VendorId =
  | 'anthropic' | 'openai' | 'gemini' | 'minimax' | 'elevenlabs' | 'doubao'
  | 'seedance' | 'kling' | 'mureka' | 'pexels' | 'pixabay'
  | 'assemblyai' | 'e2b' | 'firecrawl';

interface VendorBrand {
  /** 品牌底色 */
  readonly bg: string;
  /** 居中 monogram(1-2 字符) */
  readonly mono: string;
  /** 文字色:亮底用深字保证对比度,缺省白字 */
  readonly fg?: string;
  /** 底色与面板近同色时的描边(如 ElevenLabs 黑底) */
  readonly border?: string;
}

const WHITE = '#fff';

const BRANDS: Record<VendorId, VendorBrand> = {
  anthropic: { bg: '#D97757', mono: 'A' },
  openai: { bg: '#10A37F', mono: 'O' },
  gemini: { bg: '#4E86F7', mono: 'G' },
  minimax: { bg: '#E4593B', mono: 'M' },
  elevenlabs: { bg: '#1A1A1A', mono: '11', border: '#444' },
  doubao: { bg: '#325AB4', mono: '豆' },
  seedance: { bg: '#1664FF', mono: 'S' },
  kling: { bg: '#0ACF83', mono: 'K', fg: '#093a24' },
  mureka: { bg: '#7C5CFF', mono: 'μ' },
  pexels: { bg: '#05A081', mono: 'P' },
  pixabay: { bg: '#48A947', mono: 'Px' },
  assemblyai: { bg: '#5A50E6', mono: 'Aa' },
  e2b: { bg: '#FF8800', mono: 'E2', fg: '#40230a' },
  firecrawl: { bg: '#FF6633', mono: 'F' },
};

interface VendorIconProps {
  vendor: VendorId;
  size?: number;
}

export function VendorIcon({ vendor, size = 18 }: VendorIconProps) {
  const brand = BRANDS[vendor];
  const style: CSSProperties = {
    width: size, height: size, borderRadius: Math.round(size * 0.28),
    background: brand.bg, color: brand.fg ?? WHITE,
    border: brand.border ? `1px solid ${brand.border}` : 'none', boxSizing: 'border-box',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
    fontSize: Math.round(size * (brand.mono.length > 1 ? 0.44 : 0.58)),
    fontWeight: 700, lineHeight: 1, userSelect: 'none',
    fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
  };
  return <span aria-hidden style={style}>{brand.mono}</span>;
}
