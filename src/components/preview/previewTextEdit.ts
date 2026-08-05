import type { TimelineItem } from '../../editor/types';

/** On-canvas text fields for a selected text clip or text-like MG. */
export interface PreviewTextEditFields {
  colorKey: string | null;
  fontSizeKey: string | null;
  color: string;
  fontSize: number;
  fontSizeMin: number;
  fontSizeMax: number;
  fontSizeStep: number;
  /** Primary copy field when present (text / title / caption…). */
  textKey: string | null;
  text: string;
  fontWeightKey: string | null;
  fontWeight: number;
  alignKey: string | null;
  align: 'left' | 'center' | 'right';
}

const COLOR_KEYS = ['color', 'textColor', 'fillColor', 'titleColor', 'inkColor'] as const;
const FONT_SIZE_KEYS = ['fontSize', 'textSize', 'titleSize'] as const;
const TEXT_KEYS = [
  'text', 'title', 'caption', 'quoteText', 'nameText', 'titleText',
  'line1Text', 'keyword', 'subText', 'subtitle', 'content', 'label',
] as const;
const WEIGHT_KEYS = ['fontWeight', 'weight'] as const;
const ALIGN_KEYS = ['align', 'textAlign'] as const;
const WEIGHT_STEPS = [400, 700, 900] as const;

const isHexColor = (value: unknown): value is string => (
  typeof value === 'string' && /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value.trim())
);

const isPositiveNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string'
);

function pickKey(
  props: Record<string, unknown>,
  keys: readonly string[],
  test: (value: unknown) => boolean,
): string | null {
  for (const key of keys) {
    if (test(props[key])) return key;
  }
  // Allow missing defaults for known text-clip keys later.
  return null;
}

function pickAlign(value: unknown): 'left' | 'center' | 'right' {
  return value === 'left' || value === 'right' ? value : 'center';
}

/**
 * Resolve editable text/style props for text clips and text-like MGs.
 * Null when the clip has no live text style fields (e.g. baked video).
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
      textKey: 'text',
      text: typeof props.text === 'string' ? props.text : '',
      fontWeightKey: 'fontWeight',
      fontWeight: isPositiveNumber(props.fontWeight) ? props.fontWeight : 700,
      alignKey: 'align',
      align: pickAlign(props.align),
    };
  }
  if (item.kind !== 'motion-graphic') return null;
  const props = item.props ?? {};
  const colorKey = pickKey(props, COLOR_KEYS, isHexColor);
  const fontSizeKey = pickKey(props, FONT_SIZE_KEYS, isPositiveNumber);
  const textKey = pickKey(props, TEXT_KEYS, isNonEmptyString)
    ?? (typeof props.text === 'string' ? 'text' : null)
    ?? (typeof props.title === 'string' ? 'title' : null);
  if (!colorKey && !fontSizeKey && !textKey) return null;
  const fontSize = fontSizeKey && isPositiveNumber(props[fontSizeKey]) ? props[fontSizeKey] as number : 48;
  const scaled = fontSize <= 4;
  const weightKey = pickKey(props, WEIGHT_KEYS, isPositiveNumber);
  const alignKey = pickKey(props, ALIGN_KEYS, (value) => value === 'left' || value === 'center' || value === 'right');
  return {
    colorKey,
    fontSizeKey,
    color: colorKey && isHexColor(props[colorKey]) ? props[colorKey] as string : '#ffffff',
    fontSize,
    fontSizeMin: scaled ? 0.02 : 12,
    fontSizeMax: scaled ? 0.2 : 300,
    fontSizeStep: scaled ? 0.002 : 2,
    textKey,
    text: textKey && typeof props[textKey] === 'string' ? props[textKey] as string : '',
    fontWeightKey: weightKey,
    fontWeight: weightKey && isPositiveNumber(props[weightKey]) ? props[weightKey] as number : 700,
    alignKey,
    align: alignKey ? pickAlign(props[alignKey]) : 'center',
  };
}

export function bumpPreviewFontSize(fields: PreviewTextEditFields, direction: 1 | -1): number {
  if (!fields.fontSizeKey) return fields.fontSize;
  const factor = direction > 0 ? 1.12 : 1 / 1.12;
  const next = fields.fontSize * factor;
  const clamped = Math.min(fields.fontSizeMax, Math.max(fields.fontSizeMin, next));
  const step = fields.fontSizeStep;
  if (step >= 1) return Math.round(clamped / step) * step;
  return Math.round(clamped / step) * step;
}

export function cyclePreviewFontWeight(weight: number): number {
  const index = WEIGHT_STEPS.findIndex((step) => step >= weight);
  const at = index < 0 ? 0 : (index + 1) % WEIGHT_STEPS.length;
  return WEIGHT_STEPS[at]!;
}

export function cyclePreviewAlign(align: 'left' | 'center' | 'right'): 'left' | 'center' | 'right' {
  if (align === 'left') return 'center';
  if (align === 'center') return 'right';
  return 'left';
}

/** True when the selected clip is painted media with no live text props. */
export function isBakedVisualClip(item: TimelineItem): boolean {
  return (item.kind === 'video' || item.kind === 'image') && !previewTextEditFields(item);
}

/** Whether the item supports the full on-canvas text edit surface. */
export function canPreviewTextEdit(item: TimelineItem): boolean {
  return previewTextEditFields(item) !== null;
}
