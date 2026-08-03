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

const finiteNumber = (value: number | undefined, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);
const nonNegativeNumber = (value: number | undefined, fallback = 0): number => Math.max(0, finiteNumber(value, fallback));
const positiveNumber = (value: number | undefined, fallback: number): number => {
  const normalized = finiteNumber(value, fallback);
  return normalized > 0 ? normalized : fallback;
};
const clampedOpacity = (value: number | undefined): number => Math.max(0, Math.min(1, finiteNumber(value, 1)));

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
  const source = typeof shadow === 'string' && shadow.trim() ? shadow.trim() : 'none';
  if (size === undefined || !Number.isFinite(size)) return source;
  const blur = nonNegativeNumber(size);
  if (blur === 0) return 'none';
  const layers = splitShadowLayers(source.toLowerCase() === 'none' ? fallback : source);
  let targetIndex = -1;
  let largest = -1;
  layers.forEach((layer, index) => {
    const match = SHADOW_BLUR_RE.exec(layer);
    if (!match) return;
    const current = nonNegativeNumber(Number.parseFloat(match[2]!));
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
  const strokeWidth = nonNegativeNumber(preset.strokeWidth);
  return {
    color: active ? preset.highlightColor : preset.color,
    textShadow: shadowWithBlurSize(preset.textShadow, preset.textShadowSize, '0 3px 8px #000000aa'),
    paintOrder: 'stroke fill',
    WebkitTextStroke: strokeWidth > 0
      ? `${strokeWidth}px ${colorWithOpacity(preset.strokeColor, preset.strokeOpacity)}`
      : '0px transparent',
  };
}

export function captionBoxStyle(preset: CaptionStyle, active: boolean, wholeLine = false): CSSProperties {
  const visible = wholeLine || active || Boolean(preset.background);
  const background = wholeLine
    ? preset.background
    : (active ? (preset.highlightBackground ?? preset.background) : preset.background);
  const borderWidth = nonNegativeNumber(preset.boxBorderWidth);
  const boxShadow = shadowWithBlurSize(preset.boxShadow, preset.boxShadowSize, '0 4px 12px #00000088');
  const hasConfiguredBox = Boolean(background || borderWidth || boxShadow !== 'none');
  return {
    background: background ? colorWithOpacity(background, preset.backgroundOpacity) : 'transparent',
    border: visible && borderWidth > 0
      ? `${borderWidth}px solid ${colorWithOpacity(preset.boxBorderColor ?? preset.strokeColor, preset.boxBorderOpacity)}`
      : '0px solid transparent',
    borderRadius: hasConfiguredBox ? nonNegativeNumber(preset.boxBorderRadius, 6) : 0,
    boxShadow: visible && boxShadow !== 'none' ? boxShadow : 'none',
    boxSizing: 'border-box',
    padding: wholeLine ? (hasConfiguredBox ? '0.1em 0.42em' : 0) : (hasConfiguredBox ? '0 .14em' : 0),
  };
}

function normalizedTextAlign(
  value: CaptionStyle['textAlign'],
  fallback: NonNullable<CaptionStyle['textAlign']> = 'center',
): NonNullable<CaptionStyle['textAlign']> {
  return value === 'left' || value === 'right' || value === 'center' ? value : fallback;
}

/** Serializable typography consumed by both the editor overlay and Remotion. */
export function captionTypographyStyle(
  preset: CaptionStyle,
  height: number,
  fallbackTextAlign: NonNullable<CaptionStyle['textAlign']> = 'center',
): CSSProperties {
  const fontStyle = preset.fontStyle === 'italic' || preset.fontStyle === 'oblique' ? preset.fontStyle : 'normal';
  const decoration = [
    preset.underline ? 'underline' : '',
    preset.strike ? 'line-through' : '',
  ].filter(Boolean).join(' ') || 'none';
  const fontFamily = preset.fontFamily.trim() || 'system-ui';
  return {
    fontFamily: `${fontFamily}, system-ui, sans-serif`,
    fontSize: nonNegativeNumber(height) * positiveNumber(preset.fontSize, 0.04),
    fontWeight: Math.max(1, Math.min(1000, finiteNumber(preset.fontWeight, 400))),
    fontStyle,
    textAlign: normalizedTextAlign(preset.textAlign, fallbackTextAlign),
    textDecorationLine: decoration,
    letterSpacing: finiteNumber(preset.letterSpacing, 0),
    lineHeight: positiveNumber(preset.lineHeight, 1.25),
    textTransform: preset.textTransform === 'uppercase' ? 'uppercase' : 'none',
  };
}

/** Complete text/paint box contract used for both Player preview and export. */
export function captionTextStyle(
  preset: CaptionStyle,
  height: number,
  active: boolean,
  wholeLine = false,
): CSSProperties {
  return {
    ...captionTypographyStyle(preset, height),
    ...wordStyle(preset, active),
    ...captionBoxStyle(preset, active, wholeLine),
  };
}

/** Word flow honors the same alignment in both single- and multi-lane rendering. */
export function captionFlowStyle(preset: CaptionStyle): CSSProperties {
  const align = normalizedTextAlign(preset.textAlign);
  const edge = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  const stacked = preset.displayMode === 'stacked';
  return {
    display: 'flex',
    flexDirection: stacked ? 'column' : 'row',
    flexWrap: 'wrap',
    justifyContent: stacked ? 'flex-start' : edge,
    alignItems: stacked ? edge : 'baseline',
    gap: '0.2em',
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
    ...captionTypographyStyle(preset, height),
  };
  if (!hasLayout(layout)) {
    return {
      ...base,
      alignItems: 'center',
      textAlign: normalizedTextAlign(preset.textAlign),
      bottom: template === 'netflix' ? '9%' : '8%',
    };
  }
  const anchor = layout.anchor ?? 'bottom-center';
  const vertical = anchor.startsWith('top')
    ? 'top'
    : (anchor.startsWith('middle') || anchor === 'center') ? 'middle' : 'bottom';
  const horizontal = anchor.endsWith('left') ? 'left' : anchor.endsWith('right') ? 'right' : 'center';
  const offsetX = finiteNumber(layout.offsetXRatio, 0) * finiteNumber(width, 0);
  const offsetY = finiteNumber(layout.offsetYRatio, 0) * finiteNumber(height, 0);
  const rotation = finiteNumber(layout.rotation, 0);
  const scale = positiveNumber(layout.scale, 1);
  const visualTransform = `rotate(${rotation}deg) scale(${scale})`;
  const placed: CSSProperties = {
    ...base,
    alignItems: horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center',
    textAlign: normalizedTextAlign(preset.textAlign, horizontal),
    opacity: clampedOpacity(layout.opacity),
    transformOrigin: 'center',
  };
  if (vertical === 'middle') {
    return { ...placed, top: '50%', transform: `translateY(-50%) translate(${offsetX}px, ${offsetY}px) ${visualTransform}` };
  }
  if (vertical === 'top') {
    return { ...placed, top: finiteNumber(height, 0) * 0.08, transform: `translate(${offsetX}px, ${offsetY}px) ${visualTransform}` };
  }
  return { ...placed, bottom: finiteNumber(height, 0) * 0.08, transform: `translate(${offsetX}px, ${-offsetY}px) ${visualTransform}` };
}
