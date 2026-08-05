import type { TimelineItem } from '../../editor/types';

/** On-canvas text style fields exposed for a selected visual clip. */
export interface PreviewTextEditFields {
  colorKey: string;
  fontSizeKey: string;
  color: string;
  fontSize: number;
  /** Soft range for the font-size control (design px for text clips). */
  fontSizeMin: number;
  fontSizeMax: number;
  fontSizeStep: number;
}

const COLOR_KEYS = ['color', 'textColor', 'fillColor', 'titleColor', 'inkColor'] as const;
/** Prefer explicit type keys — avoid generic `size` (often layout scale, not type). */
const FONT_SIZE_KEYS = ['fontSize', 'textSize', 'titleSize'] as const;

const isHexColor = (value: unknown): value is string => (
  typeof value === 'string' && /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value.trim())
);

const isPositiveNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

function pickKey(
  props: Record<string, unknown>,
  keys: readonly string[],
  test: (value: unknown) => boolean,
): string | null {
  for (const key of keys) {
    if (test(props[key])) return key;
  }
  return null;
}

/**
 * Resolve editable color + fontSize props for text clips and text-like MGs.
 * Returns null when the clip has no live text style fields (e.g. baked video).
 */
export function previewTextEditFields(item: TimelineItem): PreviewTextEditFields | null {
  if (item.kind === 'text') {
    const props = item.props ?? {};
    return {
      colorKey: 'color',
      fontSizeKey: 'fontSize',
      color: isHexColor(props.color) ? props.color : '#ffffff',
      fontSize: isPositiveNumber(props.fontSize) ? props.fontSize : 96,
      fontSizeMin: 24,
      fontSizeMax: 300,
      fontSizeStep: 2,
    };
  }
  if (item.kind !== 'motion-graphic') return null;
  const props = item.props ?? {};
  const colorKey = pickKey(props, COLOR_KEYS, isHexColor);
  const fontSizeKey = pickKey(props, FONT_SIZE_KEYS, isPositiveNumber);
  if (!colorKey || !fontSizeKey) return null;
  const fontSize = props[fontSizeKey] as number;
  const scaled = fontSize <= 4;
  return {
    colorKey,
    fontSizeKey,
    color: props[colorKey] as string,
    fontSize,
    // MG props sometimes store relative sizes (0..1); keep a matching range.
    fontSizeMin: scaled ? 0.02 : 12,
    fontSizeMax: scaled ? 0.2 : 300,
    fontSizeStep: scaled ? 0.002 : 2,
  };
}

export function bumpPreviewFontSize(fields: PreviewTextEditFields, direction: 1 | -1): number {
  const factor = direction > 0 ? 1.12 : 1 / 1.12;
  const next = fields.fontSize * factor;
  const clamped = Math.min(fields.fontSizeMax, Math.max(fields.fontSizeMin, next));
  const step = fields.fontSizeStep;
  if (step >= 1) return Math.round(clamped / step) * step;
  return Math.round(clamped / step) * step;
}

/** True when the selected clip is painted media with no live text props. */
export function isBakedVisualClip(item: TimelineItem): boolean {
  return (item.kind === 'video' || item.kind === 'image') && !previewTextEditFields(item);
}
