// Provider marks are vendored from official brand assets where available, plus
// @lobehub/icons-static-svg v1.93.0 (MIT) and simple-icons (CC0). Static SVGs
// render inline for consistent sizing; monochrome marks inherit the active skin.
// Mureka/E2B/local disk remain monograms because they have no suitable provider mark here.
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
import stepfunSvg from '../../../assets/vendor-icons/stepfun-color.svg?raw';
import fishaudioSvg from '../../../assets/vendor-icons/fishaudio.svg?raw';
import xiaomimimoSvg from '../../../assets/vendor-icons/xiaomimimo.svg?raw';
import murekaSvg from '../../../assets/vendor-icons/mureka-color.svg?raw';
import hailuoSvg from '../../../assets/vendor-icons/hailuo-color.svg?raw';
import elevenlabsSvg from '../../../assets/vendor-icons/elevenlabs.svg?raw';
import doubaoSvg from '../../../assets/vendor-icons/doubao-color.svg?raw';
import volcengineSvg from '../../../assets/vendor-icons/volcengine-color.svg?raw';
import klingSvg from '../../../assets/vendor-icons/kling-color.svg?raw';
import assemblyaiSvg from '../../../assets/vendor-icons/assemblyai-color.svg?raw';
import deepgramSvg from '../../../assets/vendor-icons/deepgram.svg?raw';
import groqSvg from '../../../assets/vendor-icons/groq.svg?raw';
import cartesiaSvg from '../../../assets/vendor-icons/cartesia-color.svg?raw';
import firecrawlSvg from '../../../assets/vendor-icons/firecrawl-color.svg?raw';
import pexelsSvg from '../../../assets/vendor-icons/pexels.svg?raw';
import pixabaySvg from '../../../assets/vendor-icons/pixabay.svg?raw';
import unsplashSvg from '../../../assets/vendor-icons/unsplash.svg?raw';
import freesoundSvg from '../../../assets/vendor-icons/freesound.svg?raw';
import cloudflareSvg from '../../../assets/vendor-icons/cloudflare.svg?raw';
import openrouterSvg from '../../../assets/vendor-icons/openrouter.svg?raw';
import ollamaSvg from '../../../assets/vendor-icons/ollama.svg?raw';
import lmstudioSvg from '../../../assets/vendor-icons/lmstudio-color.svg?raw';
import visionSvg from '../../../assets/vendor-icons/vision.svg?raw';

export type VendorId =
  | 'llm' | 'anthropic' | 'openai' | 'gemini' | 'kimi' | 'qwen' | 'glm' | 'deepseek' | 'mistral' | 'openrouter'
  | 'ollama' | 'lmstudio' | 'xiaomi' | 'minimax' | 'hailuo' | 'elevenlabs' | 'doubao'
  | 'seedance' | 'kling' | 'mureka' | 'sonilo' | 'pexels' | 'pixabay' | 'unsplash' | 'freesound'
  | 'assemblyai' | 'deepgram' | 'groq' | 'cartesia' | 'e2b' | 'firecrawl' | 'r2' | 'localdisk' | 'localasr'
  | 'stepfun' | 'byteplus' | 'inworld' | 'fishaudio' | 'speechify' | 'wavespeed'
  | 'vision' | 'proxy';

interface SvgIcon {
  readonly svg: string;
  /** Mono official label (currentColor / no fill) uses this color; leave the color version blank and use your own brand color */
  readonly tint?: string;
}

const PROXY_ICON = '<svg viewBox="0 0 24 24"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm-9-9h18M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z"/></svg>';

const SVG_ICONS: Partial<Record<VendorId, SvgIcon>> = {
  anthropic: { svg: claudeSvg },                    // Agent brain uses Claude starburst (official orange)
  openai: { svg: openaiSvg, tint: theme.text },     // The official ring is a single color, which will match the skin color (dark skin is nearly white/light skin is nearly black)
  gemini: { svg: geminiSvg },
  kimi: { svg: kimiSvg },
  qwen: { svg: qwenSvg },
  glm: { svg: zhipuSvg },
  deepseek: { svg: deepseekSvg },
  mistral: { svg: mistralSvg },
  minimax: { svg: minimaxSvg },
  stepfun: { svg: stepfunSvg },                         // Official StepFun (阶跃星辰) color mark
  fishaudio: { svg: fishaudioSvg, tint: '#0F9D8B' },    // Official single-color mark + brand teal
  xiaomi: { svg: xiaomimimoSvg, tint: '#FF6900' },      // Official Xiaomi MiMo mark + brand orange
  mureka: { svg: murekaSvg },                           // Official Mureka gradient mark
  hailuo: { svg: hailuoSvg },                       // MiniMax Conch Video exclusive logo
  elevenlabs: { svg: elevenlabsSvg, tint: theme.text },
  doubao: { svg: doubaoSvg },
  seedance: { svg: volcengineSvg },                 // Seedance = owned by Volcano Engine, using the official logo of Volcano
  kling: { svg: klingSvg },
  assemblyai: { svg: assemblyaiSvg },
  deepgram: { svg: deepgramSvg },
  groq: { svg: groqSvg, tint: '#F55036' },
  cartesia: { svg: cartesiaSvg },
  firecrawl: { svg: firecrawlSvg },
  pexels: { svg: pexelsSvg, tint: '#05A081' },      // simple-icons single color + official green
  pixabay: { svg: pixabaySvg, tint: '#48A947' },
  unsplash: { svg: unsplashSvg, tint: theme.text }, // simple-icons single color, ink color according to skin
  freesound: { svg: freesoundSvg, tint: '#E85D4C' }, // Site pin + brand red and orange
  r2: { svg: cloudflareSvg, tint: '#F6821F' },      // R2 = Cloudflare product, use Cloudflare official logo
  openrouter: { svg: openrouterSvg, tint: '#7624F4' }, // Official OpenRouter mark + primary purple
  ollama: { svg: ollamaSvg, tint: theme.text },        // Official llama mark, adapted for skin contrast
  lmstudio: { svg: lmstudioSvg },                      // Official LM Studio color app icon
  proxy: { svg: PROXY_ICON }, // network proxy
  vision: { svg: visionSvg },                          // Vision bypass feature mark (generated)
};

// Official SVG not included / Non-provider brand → monogram
const MONOGRAMS: Partial<Record<VendorId, { bg: string; mono: string; fg?: string }>> = {
  llm: { bg: '#34363c', mono: 'AI', fg: '#f7f7f8' },
  e2b: { bg: '#FF8800', mono: 'E2', fg: '#40230a' },
  localdisk: { bg: '#5f6b7a', mono: 'HD', fg: '#eef2f7' }, // Local disk (non-vendor, neutral gray)
  localasr: { bg: '#3a7d44', mono: 'ASR', fg: '#eaf5ec' }, // On-device ASR (whisper, non-vendor)
  byteplus: { bg: '#0055FF', mono: 'BP' }, // BytePlus ModelArk, no official SVG vendored yet
  inworld: { bg: '#7A5CFF', mono: 'IW' }, // Inworld TTS, no official SVG vendored yet
  speechify: { bg: '#FF6A3D', mono: 'SP' }, // Speechify, no official SVG vendored yet
  wavespeed: { bg: '#00B8D9', mono: 'WS' }, // WaveSpeed AI, no official SVG vendored yet
  sonilo: { bg: '#101828', mono: 'SO', fg: '#e8f6f2' }, // Sonilo, no official SVG vendored yet
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
    // Static codebase assets, non-user input - inline to inherit size and currentColor
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
