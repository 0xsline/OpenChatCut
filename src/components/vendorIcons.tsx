// 厂商官方图标,vendored 自 @lobehub/icons-static-svg v1.93(MIT)与 simple-icons(CC0,
// 仅 Pexels/Pixabay 两个非 AI 厂牌)。SVG 是本仓静态资产(非用户输入),inline 渲染以便
// 尺寸/mono 着色继承;color 版 path 自带官方品牌色。Mureka/E2B 无官方收录 → monogram 兜底。
import type { CSSProperties } from 'react';
import claudeSvg from './vendor-icons/claude-color.svg?raw';
import openaiSvg from './vendor-icons/openai.svg?raw';
import geminiSvg from './vendor-icons/gemini-color.svg?raw';
import minimaxSvg from './vendor-icons/minimax-color.svg?raw';
import hailuoSvg from './vendor-icons/hailuo-color.svg?raw';
import elevenlabsSvg from './vendor-icons/elevenlabs.svg?raw';
import doubaoSvg from './vendor-icons/doubao-color.svg?raw';
import volcengineSvg from './vendor-icons/volcengine-color.svg?raw';
import klingSvg from './vendor-icons/kling-color.svg?raw';
import assemblyaiSvg from './vendor-icons/assemblyai-color.svg?raw';
import firecrawlSvg from './vendor-icons/firecrawl-color.svg?raw';
import pexelsSvg from './vendor-icons/pexels.svg?raw';
import pixabaySvg from './vendor-icons/pixabay.svg?raw';

export type VendorId =
  | 'anthropic' | 'openai' | 'gemini' | 'minimax' | 'hailuo' | 'elevenlabs' | 'doubao'
  | 'seedance' | 'kling' | 'mureka' | 'pexels' | 'pixabay'
  | 'assemblyai' | 'e2b' | 'firecrawl';

interface SvgIcon {
  readonly svg: string;
  /** mono 官方标(currentColor / 无 fill)着这个色;color 版留空用自带品牌色 */
  readonly tint?: string;
}

const SVG_ICONS: Partial<Record<VendorId, SvgIcon>> = {
  anthropic: { svg: claudeSvg },                    // Agent 大脑用 Claude 星芒(官方橙)
  openai: { svg: openaiSvg, tint: '#e8e8e8' },      // 官方结环即单色,暗底走白
  gemini: { svg: geminiSvg },
  minimax: { svg: minimaxSvg },
  hailuo: { svg: hailuoSvg },                       // MiniMax 海螺视频专属标
  elevenlabs: { svg: elevenlabsSvg, tint: '#e8e8e8' },
  doubao: { svg: doubaoSvg },
  seedance: { svg: volcengineSvg },                 // Seedance = 火山引擎旗下,用火山官方标
  kling: { svg: klingSvg },
  assemblyai: { svg: assemblyaiSvg },
  firecrawl: { svg: firecrawlSvg },
  pexels: { svg: pexelsSvg, tint: '#05A081' },      // simple-icons 单色 + 官方绿
  pixabay: { svg: pixabaySvg, tint: '#48A947' },
};

// 官方无收录的两家兜底 monogram(品牌色近似)
const MONOGRAMS: Partial<Record<VendorId, { bg: string; mono: string; fg?: string }>> = {
  mureka: { bg: '#7C5CFF', mono: 'μ' },
  e2b: { bg: '#FF8800', mono: 'E2', fg: '#40230a' },
};

interface VendorIconProps {
  vendor: VendorId;
  size?: number;
}

export function VendorIcon({ vendor, size = 18 }: VendorIconProps) {
  const icon = SVG_ICONS[vendor];
  if (icon) {
    const style: CSSProperties = {
      // lobe SVG 是 1em×1em → fontSize 即尺寸;simple-icons 由 .cc-vendor-icon CSS 归一
      fontSize: size, width: size, height: size, color: icon.tint,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
    };
    // 静态本仓资产,非用户输入 —— inline 以继承尺寸与 currentColor
    return <span aria-hidden className="cc-vendor-icon" style={style} dangerouslySetInnerHTML={{ __html: icon.svg }} />;
  }
  const brand = MONOGRAMS[vendor] ?? { bg: '#555', mono: '?' };
  const style: CSSProperties = {
    width: size, height: size, borderRadius: Math.round(size * 0.28),
    background: brand.bg, color: brand.fg ?? '#fff',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
    fontSize: Math.round(size * (brand.mono.length > 1 ? 0.44 : 0.58)),
    fontWeight: 700, lineHeight: 1, userSelect: 'none',
    fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
  };
  return <span aria-hidden style={style}>{brand.mono}</span>;
}
