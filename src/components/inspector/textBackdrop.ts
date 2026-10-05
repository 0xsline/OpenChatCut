import { interpolateColors } from 'remotion';

export function textBackdropRgba(hex: string, opacity: number): string {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return 'rgba(' + channels.join(', ') + ', ' + opacity + ')';
}

/** Use the same authoritative color and default as TextLayer. */
export function textBackdropColor(props: Record<string, unknown>): { hex: string; opacity: number } {
  const fallback = { hex: '#0a0f1a', opacity: 0.85 };
  if (typeof props.bgColor !== 'string') return fallback;
  try {
    const color = props.bgColor;
    const rgba = interpolateColors(0, [0, 1], [color, color]);
    const channels = rgba.slice(5, -1).split(',').map(Number);
    const hex = '#' + channels.slice(0, 3).map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('');
    // Color normalization quantizes alpha to 8 bits; preserve editable RGBA
    // values so changing the color does not change the saved opacity.
    const alpha = /^rgba\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([\d.]+)\s*\)$/i.exec(color)?.[1];
    return { hex, opacity: alpha === undefined ? channels[3] ?? 1 : Math.max(0, Math.min(1, Number(alpha))) };
  } catch { return fallback; }
}

export function textBackdropBorder(props: Record<string, unknown>): { prefix: string; hex: string; opacity: number } {
  const raw = String(props.bgBorder ?? '1px solid rgba(255, 255, 255, 0.16)').trim();
  if (raw === 'none') return { prefix: '0px solid', hex: '#ffffff', opacity: 0 };
  const match = /^(\S+\s+(?:solid|dashed|dotted|double|groove|ridge|inset|outset))\s+(.+)$/.exec(raw);
  return { prefix: match?.[1] ?? '1px solid', ...textBackdropColor({ bgColor: match?.[2] ?? 'rgba(255, 255, 255, 0.16)' }) };
}
