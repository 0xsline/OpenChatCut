import type { CSSProperties } from 'react';
import type { CaptionLayout, CaptionsData, CaptionTemplate } from './types';
import { CAPTION_STYLE_BY_ID, type CaptionStyle, type CaptionStyleOverride } from './styles';

/** Template preset merged with the caption's explicit style override. */
export function effectivePreset(captions: CaptionsData): CaptionStyle {
  const preset = CAPTION_STYLE_BY_ID[captions.template];
  return captions.styleOverride ? { ...preset, ...captions.styleOverride } : preset;
}

/** Color currently painted by the direct-edit preview. */
export function captionPreviewTextColor(preset: CaptionStyle): string {
  return preset.wholeLine ? preset.color : preset.highlightColor;
}

/** Keep active and inactive karaoke words consistent after a color edit. */
export function captionPreviewTextColorPatch(
  preset: CaptionStyle,
  color: string,
): CaptionStyleOverride {
  return preset.wholeLine ? { color } : { color, highlightColor: color };
}

const clampedOpacity = (value: number | undefined): number => Math.max(0, Math.min(1, value ?? 1));

function colorWithOpacity(color: string, opacity: number | undefined): string {
  const amount = clampedOpacity(opacity);
  if (amount === 1) return color;
  const hex = /^#([\da-f]{3,8})$/i.exec(color.trim())?.[1];
  if (hex) {
    const expanded = hex.length === 3 || hex.length === 4
      ? [...hex].map((part) => `${part}${part}`).join('')
      : hex;
    if (expanded.length === 6 || expanded.length === 8) {
      const red = Number.parseInt(expanded.slice(0, 2), 16);
      const green = Number.parseInt(expanded.slice(2, 4), 16);
      const blue = Number.parseInt(expanded.slice(4, 6), 16);
      const sourceAlpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;
      return `rgba(${red}, ${green}, ${blue}, ${Number((sourceAlpha * amount).toFixed(3))})`;
    }
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(color.trim());
  if (rgb) {
    const sourceAlpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    return `rgba(${Number(rgb[1])}, ${Number(rgb[2])}, ${Number(rgb[3])}, ${Number((sourceAlpha * amount).toFixed(3))})`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(amount * 1000) / 10}%, transparent)`;
}

const SHADOW_BLUR_RE = /^(\s*(?:inset\s+)?-?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?\s+-?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?\s+)(-?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?)/i;

function splitShadowLayers(shadow: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < shadow.length; index += 1) {
    const character = shadow[index];
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) {
      layers.push(shadow.slice(start, index).trim());
      start = index + 1;
    }
  }
  layers.push(shadow.slice(start).trim());
  return layers.filter(Boolean);
}

export function shadowBlurSize(shadow: string | undefined): number {
  if (!shadow || shadow.trim().toLowerCase() === 'none') return 0;
  return splitShadowLayers(shadow).reduce((largest, layer) => {
    const match = SHADOW_BLUR_RE.exec(layer);
    return match ? Math.max(largest, Math.max(0, Number.parseFloat(match[2]!))) : largest;
  }, 0);
}

function shadowWithBlurSize(shadow: string | undefined, size: number | undefined, fallback: string): string {
  if (size === undefined) return shadow ?? 'none';
  const blur = Math.max(0, size);
  if (blur === 0) return 'none';
  const layers = splitShadowLayers(!shadow || shadow.trim().toLowerCase() === 'none' ? fallback : shadow);
  let targetIndex = -1;
  let largest = -1;
  layers.forEach((layer, index) => {
    const match = SHADOW_BLUR_RE.exec(layer);
    if (!match) return;
    const current = Math.max(0, Number.parseFloat(match[2]!));
    if (current >= largest) {
      largest = current;
      targetIndex = index;
    }
  });
  if (targetIndex < 0) return shadowWithBlurSize(fallback, blur, fallback);
  layers[targetIndex] = layers[targetIndex]!.replace(SHADOW_BLUR_RE, `$1${blur}px`);
  return layers.join(', ');
}

/** Per-word look; active marks the word currently being spoken. */
export function wordStyle(preset: CaptionStyle, active: boolean): CSSProperties {
  return {
    color: active ? preset.highlightColor : preset.color,
    textShadow: shadowWithBlurSize(preset.textShadow, preset.textShadowSize, '0 3px 8px #000000aa'),
    paintOrder: 'stroke fill',
    WebkitTextStroke: preset.strokeWidth
      ? `${preset.strokeWidth}px ${colorWithOpacity(preset.strokeColor, preset.strokeOpacity)}`
      : undefined,
  };
}

export function captionBoxStyle(preset: CaptionStyle, active: boolean, wholeLine = false): CSSProperties {
  const visible = wholeLine || active;
  const background = wholeLine ? preset.background : (active ? preset.highlightBackground : undefined);
  const borderWidth = preset.boxBorderWidth ?? 0;
  const boxShadow = shadowWithBlurSize(preset.boxShadow, preset.boxShadowSize, '0 4px 12px #00000088');
  const hasConfiguredBox = wholeLine
    ? Boolean(preset.background || borderWidth || boxShadow !== 'none')
    : Boolean(preset.highlightBackground || borderWidth || boxShadow !== 'none');
  return {
    background: background ?? 'transparent',
    border: visible && borderWidth > 0
      ? `${borderWidth}px solid ${colorWithOpacity(preset.boxBorderColor ?? preset.strokeColor, preset.boxBorderOpacity)}`
      : undefined,
    borderRadius: hasConfiguredBox ? (preset.boxBorderRadius ?? 6) : 0,
    boxShadow: visible && boxShadow !== 'none' ? boxShadow : undefined,
    boxSizing: 'border-box',
    padding: wholeLine ? (hasConfiguredBox ? '0.1em 0.42em' : 0) : (hasConfiguredBox ? '0 .14em' : 0),
  };
}

function hasLayout(layout: CaptionLayout | undefined): layout is CaptionLayout {
  return !!layout && (
    layout.anchor !== undefined
    || layout.offsetXRatio !== undefined
    || layout.offsetYRatio !== undefined
    || layout.scale !== undefined
    || layout.rotation !== undefined
    || layout.opacity !== undefined
  );
}

export function containerStyle(
  preset: CaptionStyle,
  template: CaptionTemplate,
  width: number,
  height: number,
  layout: CaptionLayout | undefined,
): CSSProperties {
  const base: CSSProperties = {
    position: 'absolute',
    left: 0,
    right: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.1em',
    padding: '0 10%',
    lineHeight: 1.25,
    fontFamily: `${preset.fontFamily}, system-ui, sans-serif`,
    fontWeight: preset.fontWeight,
    fontSize: height * preset.fontSize,
    textTransform: preset.textTransform,
  };
  if (!hasLayout(layout)) {
    return {
      ...base,
      alignItems: 'center',
      textAlign: 'center',
      bottom: template === 'netflix' ? '9%' : '8%',
    };
  }
  const anchor = layout.anchor ?? 'bottom-center';
  const vertical = anchor.startsWith('top')
    ? 'top'
    : (anchor.startsWith('middle') || anchor === 'center') ? 'middle' : 'bottom';
  const horizontal = anchor.endsWith('left') ? 'left' : anchor.endsWith('right') ? 'right' : 'center';
  const offsetX = (layout.offsetXRatio ?? 0) * width;
  const offsetY = (layout.offsetYRatio ?? 0) * height;
  const visualTransform = `rotate(${layout.rotation ?? 0}deg) scale(${layout.scale ?? 1})`;
  const placed: CSSProperties = {
    ...base,
    alignItems: horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center',
    textAlign: horizontal,
    opacity: clampedOpacity(layout.opacity),
    transformOrigin: 'center',
  };
  if (vertical === 'middle') {
    return { ...placed, top: '50%', transform: `translateY(-50%) translate(${offsetX}px, ${offsetY}px) ${visualTransform}` };
  }
  if (vertical === 'top') {
    return { ...placed, top: height * 0.08, transform: `translate(${offsetX}px, ${offsetY}px) ${visualTransform}` };
  }
  return { ...placed, bottom: height * 0.08, transform: `translate(${offsetX}px, ${-offsetY}px) ${visualTransform}` };
}
