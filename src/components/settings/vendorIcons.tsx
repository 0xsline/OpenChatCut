// Official icon of the manufacturer, vendored from @lobehub/icons-static-svg v1.93.0 (MIT), simple-icons (CC0:
// Pexels/Pixabay/Unsplash/Cloudflare) and Freesound site safari-pinned-tab branding.
// SVG is a static asset of this warehouse (not user input), inline rendering for size/mono coloring inheritance; color version path
// Comes with official brand colors. Mureka/E2B/local disk is still a monogram.
import type { CSSProperties } from 'react';
import { theme } from '../../theme';
import claudeSvg from '../../../assets/vendor-icons/claude-color.svg?raw';
import openaiSvg from '../../../assets/vendor-icons/openai.svg?raw';
import geminiSvg from '../../../assets/vendor-icons/gemini-color.svg?raw';
import kimiSvg from '../../../assets/vendor-icons/kimi-color.svg?raw';
import qwenSvg from '../../../assets/vendor-icons/qwen-color.svg?raw';
import zhipuSvg from '../../../assets/vendor-icons/zhipu-color.svg?raw';
import deepseekSvg from '../../../assets/vendor-icons/deepseek-color.svg?raw';
import mistralSvg from '../../../assets/vendor-icons/mistral-color.svg?raw';
import minimaxSvg from '../../../assets/vendor-icons/minimax-color.svg?raw';
import hailuoSvg from '../../../assets/vendor-icons/hailuo-color.svg?raw';
import elevenlabsSvg from '../../../assets/vendor-icons/elevenlabs.svg?raw';
import doubaoSvg from '../../../assets/vendor-icons/doubao-color.svg?raw';
import volcengineSvg from '../../../assets/vendor-icons/volcengine-color.svg?raw';
import klingSvg from '../../../assets/vendor-icons/kling-color.svg?raw';
import assemblyaiSvg from '../../../assets/vendor-icons/assemblyai-color.svg?raw';
import firecrawlSvg from '../../../assets/vendor-icons/firecrawl-color.svg?raw';
import pexelsSvg from '../../../assets/vendor-icons/pexels.svg?raw';
import pixabaySvg from '../../../assets/vendor-icons/pixabay.svg?raw';
import unsplashSvg from '../../../assets/vendor-icons/unsplash.svg?raw';
import freesoundSvg from '../../../assets/vendor-icons/freesound.svg?raw';
import cloudflareSvg from '../../../assets/vendor-icons/cloudflare.svg?raw';

export type VendorId =
  | 'llm' | 'anthropic' | 'openai' | 'gemini' | 'kimi' | 'qwen' | 'glm' | 'deepseek' | 'mistral' | 'openrouter'
  | 'minimax' | 'hailuo' | 'elevenlabs' | 'doubao'
  | 'seedance' | 'kling' | 'mureka' | 'pexels' | 'pixabay' | 'unsplash' | 'freesound'
  | 'assemblyai' | 'e2b' | 'firecrawl' | 'r2' | 'localdisk';

interface SvgIcon {
  readonly svg: string;
  /** mono official mark(currentColor / None fill)Wear this color;color Leave the page blank and use your own brand color */
  readonly tint?: string;
}

const SVG_ICONS: Partial<Record<VendorId, SvgIcon>> = {
  anthropic: { svg: claudeSvg },                    // Claude Starburst for Agent Brain (Official Orange)
  openai: { svg: openaiSvg, tint: theme.text },     // The official knot is a single color, which will match the skin color (dark skin is almost white/light skin is almost black)
  gemini: { svg: geminiSvg },
  kimi: { svg: kimiSvg },
  qwen: { svg: qwenSvg },
  glm: { svg: zhipuSvg },
  deepseek: { svg: deepseekSvg },
  mistral: { svg: mistralSvg },
  minimax: { svg: minimaxSvg },
  hailuo: { svg: hailuoSvg },                       // MiniMax conch video exclusive logo
  elevenlabs: { svg: elevenlabsSvg, tint: theme.text },
  doubao: { svg: doubaoSvg },
  seedance: { svg: volcengineSvg },                 // Seedance = owned by Volcano Engine, using the official logo of Volcano
  kling: { svg: klingSvg },
  assemblyai: { svg: assemblyaiSvg },
  firecrawl: { svg: firecrawlSvg },
  pexels: { svg: pexelsSvg, tint: '#05A081' },      // simple-icons single color + official green
  pixabay: { svg: pixabaySvg, tint: '#48A947' },
  unsplash: { svg: unsplashSvg, tint: theme.text }, // simple-icons single color, ink color according to skin
  freesound: { svg: freesoundSvg, tint: '#E85D4C' }, // Site pin + brand red orange
  r2: { svg: cloudflareSvg, tint: '#F6821F' },      // R2 = Cloudflare product, using Cloudflare official logo
};

// Official SVG not included / non-manufacturer brand → monogram
const MONOGRAMS: Partial<Record<VendorId, { bg: string; mono: string; fg?: string }>> = {
  llm: { bg: '#34363c', mono: 'AI', fg: '#f7f7f8' },
  openrouter: { bg: '#5B5BD6', mono: 'OR' },
  mureka: { bg: '#7C5CFF', mono: 'μ' },
  e2b: { bg: '#FF8800', mono: 'E2', fg: '#40230a' },
  localdisk: { bg: '#5f6b7a', mono: 'HD', fg: '#eef2f7' }, // Local disk (non-manufacturer, neutral gray)
};

interface VendorIconProps {
  vendor: VendorId;
  size?: number;
}

export function VendorIcon({ vendor, size = 18 }: VendorIconProps) {
  const icon = SVG_ICONS[vendor];
  if (icon) {
    const style: CSSProperties = {
      // lobe SVG is 1em×1em → fontSize is the size; simple-icons are normalized by .cc-vendor-icon CSS
      fontSize: size, width: size, height: size, color: icon.tint,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
    };
    // Static warehouse assets, non-user input - inline to inherit size and currentColor
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
