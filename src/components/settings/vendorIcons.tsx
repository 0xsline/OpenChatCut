// 厂商官方图标,vendored 自 @lobehub/icons-static-svg v1.93.0(MIT)、simple-icons(CC0:
// Pexels/Pixabay/Unsplash/Cloudflare)与 Freesound 站点 safari-pinned-tab 品牌标。
// SVG 是本仓静态资产(非用户输入),inline 渲染以便尺寸/mono 着色继承;color 版 path
// 自带官方品牌色。Mureka/E2B/本地磁盘仍 monogram 兜底。
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
  /** mono 官方标(currentColor / 无 fill)着这个色;color 版留空用自带品牌色 */
  readonly tint?: string;
}

const SVG_ICONS: Partial<Record<VendorId, SvgIcon>> = {
  anthropic: { svg: claudeSvg },                    // Agent 大脑用 Claude 星芒(官方橙)
  openai: { svg: openaiSvg, tint: theme.text },     // 官方结环即单色,随皮肤墨色(深肤近白/浅肤近黑)
  gemini: { svg: geminiSvg },
  kimi: { svg: kimiSvg },
  qwen: { svg: qwenSvg },
  glm: { svg: zhipuSvg },
  deepseek: { svg: deepseekSvg },
  mistral: { svg: mistralSvg },
  minimax: { svg: minimaxSvg },
  hailuo: { svg: hailuoSvg },                       // MiniMax 海螺视频专属标
  elevenlabs: { svg: elevenlabsSvg, tint: theme.text },
  doubao: { svg: doubaoSvg },
  seedance: { svg: volcengineSvg },                 // Seedance = 火山引擎旗下,用火山官方标
  kling: { svg: klingSvg },
  assemblyai: { svg: assemblyaiSvg },
  firecrawl: { svg: firecrawlSvg },
  pexels: { svg: pexelsSvg, tint: '#05A081' },      // simple-icons 单色 + 官方绿
  pixabay: { svg: pixabaySvg, tint: '#48A947' },
  unsplash: { svg: unsplashSvg, tint: theme.text }, // simple-icons 单色,随皮肤墨色
  freesound: { svg: freesoundSvg, tint: '#E85D4C' }, // 站点 pin 标 + 品牌红橙
  r2: { svg: cloudflareSvg, tint: '#F6821F' },      // R2 = Cloudflare 产品,用 Cloudflare 官方标
};

// 官方 SVG 未收录 / 非厂商品牌 → monogram 兜底
const MONOGRAMS: Partial<Record<VendorId, { bg: string; mono: string; fg?: string }>> = {
  llm: { bg: '#34363c', mono: 'AI', fg: '#f7f7f8' },
  openrouter: { bg: '#5B5BD6', mono: 'OR' },
  mureka: { bg: '#7C5CFF', mono: 'μ' },
  e2b: { bg: '#FF8800', mono: 'E2', fg: '#40230a' },
  localdisk: { bg: '#5f6b7a', mono: 'HD', fg: '#eef2f7' }, // 本地磁盘(非厂商,中性灰)
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
