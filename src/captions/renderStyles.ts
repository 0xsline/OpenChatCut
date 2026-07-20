import type { CSSProperties } from 'react';
import type { CaptionLayout, CaptionsData, CaptionTemplate } from './types';
import { CAPTION_STYLE_BY_ID, type CaptionStyle } from './styles';

/** Template preset merged with the caption's explicit style override. */
export function effectivePreset(captions: CaptionsData): CaptionStyle {
  const preset = CAPTION_STYLE_BY_ID[captions.template];
  return captions.styleOverride ? { ...preset, ...captions.styleOverride } : preset;
}

/** Per-word look; active marks the word currently being spoken. */
export function wordStyle(preset: CaptionStyle, active: boolean): CSSProperties {
  return {
    color: active ? preset.highlightColor : preset.color,
    background: active && preset.highlightBackground ? preset.highlightBackground : 'transparent',
    borderRadius: preset.highlightBackground ? 6 : 0,
    padding: preset.highlightBackground ? '0 .14em' : 0,
    textShadow: preset.textShadow,
    WebkitTextStroke: preset.strokeWidth ? `${preset.strokeWidth}px ${preset.strokeColor}` : undefined,
  };
}

function hasLayout(layout: CaptionLayout | undefined): layout is CaptionLayout {
  return !!layout && (
    layout.anchor !== undefined
    || layout.offsetXRatio !== undefined
    || layout.offsetYRatio !== undefined
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
  const placed: CSSProperties = {
    ...base,
    alignItems: horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center',
    textAlign: horizontal,
  };
  if (vertical === 'middle') {
    return { ...placed, top: '50%', transform: `translateY(-50%) translate(${offsetX}px, ${offsetY}px)` };
  }
  if (vertical === 'top') {
    return { ...placed, top: height * 0.08, transform: `translate(${offsetX}px, ${offsetY}px)` };
  }
  return { ...placed, bottom: height * 0.08, transform: `translate(${offsetX}px, ${-offsetY}px)` };
}
