import { AbsoluteFill } from 'remotion';
import { getCompiledTemplate } from '../template-host';
import type { AspectFit, TimelineItem, Watermark } from './types';
import { VisualClipSurface } from './TimelineMediaLayer';
import { isGenericFontFamily } from '../fonts/googleFontCatalog';

export function SolidLayer({ item, canvasW, canvasH, borderRadius }: {
  item: TimelineItem;
  canvasW: number;
  canvasH: number;
  borderRadius: number;
}) {
  const color = String(item.props?.color ?? '#1a1a1a');
  return (
    <VisualClipSurface item={item} fit="cover" canvasW={canvasW} canvasH={canvasH} borderRadius={borderRadius}>
      <AbsoluteFill style={{ background: color }} />
    </VisualClipSurface>
  );
}

export function WatermarkLayer({ watermark, canvasH }: { watermark: Watermark; canvasH: number }) {
  const style: React.CSSProperties = {
    position: 'absolute',
    color: '#ffffff',
    opacity: Math.max(0, Math.min(1, watermark.opacity)),
    fontSize: Math.round(canvasH * 0.035),
    fontWeight: 700,
    fontFamily: 'Geist, system-ui, -apple-system, sans-serif',
    textShadow: '0 2px 8px rgba(0,0,0,0.6)',
    whiteSpace: 'nowrap',
  };
  const pad = Math.round(canvasH * 0.04);
  if (watermark.position[0] === 't') style.top = pad;
  else style.bottom = pad;
  if (watermark.position[1] === 'l') style.left = pad;
  else style.right = pad;
  return <AbsoluteFill style={{ pointerEvents: 'none' }}><div style={style}>{watermark.text}</div></AbsoluteFill>;
}

export function TextLayer({ item, canvasW, canvasH, fit }: {
  item: TimelineItem;
  canvasW: number;
  canvasH: number;
  fit: AspectFit;
}) {
  const dw = item.width ?? 1920;
  const dh = item.height ?? 1080;
  const scale = fit === 'cover' ? Math.max(canvasW / dw, canvasH / dh) : Math.min(canvasW / dw, canvasH / dh);
  const props = item.props ?? {};
  const align = (props.align === 'left' || props.align === 'right' ? props.align : 'center') as 'left' | 'center' | 'right';
  const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';

  // Typography properties:
  const rawFamily = String(props.fontFamily ?? '').trim();
  const rawFam = rawFamily.includes(',') ? rawFamily : rawFamily.replace(/^["']|["']$/g, '');
  const fontFamily = !rawFam ? 'Geist, system-ui, -apple-system, sans-serif'
    : rawFam.includes(',') || isGenericFontFamily(rawFam) ? rawFam
    : `${JSON.stringify(rawFam)}, system-ui, -apple-system, sans-serif`;
  const fontStyle = (props.fontStyle ? String(props.fontStyle) : 'normal') as 'normal' | 'italic';
  const fontWeight = Number(props.fontWeight ?? 700);
  const fontSize = Number(props.fontSize ?? 96);
  const color = String(props.color ?? '#ffffff');
  const letterSpacing = props.letterSpacing !== undefined
    ? (typeof props.letterSpacing === 'number' ? `${props.letterSpacing}px` : String(props.letterSpacing))
    : 'normal';
  const lineHeight = props.lineHeight !== undefined ? Number(props.lineHeight) : 1.2;
  const textShadow = props.textShadow !== undefined
    ? String(props.textShadow)
    : '0 3px 16px rgba(0,0,0,0.55)';

  // Container / backdrop properties:
  const bgEnabled = Boolean(props.bgEnabled ?? false);

  const textNode = (
    <div style={{
      color,
      fontSize,
      fontWeight,
      fontStyle,
      fontFamily,
      letterSpacing,
      lineHeight,
      textAlign: align,
      textShadow,
      whiteSpace: 'pre-wrap',
      width: bgEnabled ? undefined : '100%',
    }}>
      {String(props.text ?? '文字')}
    </div>
  );

  let body = textNode;

  if (bgEnabled) {
    const defaultBg = 'rgba(10, 15, 26, 0.85)';
    const defaultBorder = '1px solid rgba(255, 255, 255, 0.16)';
    const defaultRadius = 9999;
    const defaultPadX = 32;
    const defaultPadY = 10;
    const defaultBlur = 20;
    const defaultShadow = '0 12px 36px rgba(0, 0, 0, 0.65), 0 2px 8px rgba(0, 0, 0, 0.4)';

    const bgColor = props.bgColor !== undefined ? String(props.bgColor) : defaultBg;
    const bgBorder = props.bgBorder !== undefined ? String(props.bgBorder) : defaultBorder;
    const bgRadius = props.bgRadius !== undefined ? Number(props.bgRadius) : defaultRadius;
    const bgPaddingX = props.bgPaddingX !== undefined ? Number(props.bgPaddingX) : defaultPadX;
    const bgPaddingY = props.bgPaddingY !== undefined ? Number(props.bgPaddingY) : defaultPadY;
    const bgBlur = props.bgBlur !== undefined ? Number(props.bgBlur) : defaultBlur;
    const bgShadow = props.bgShadow !== undefined ? String(props.bgShadow) : defaultShadow;

    body = (
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: bgColor,
        backdropFilter: bgBlur > 0 ? `blur(${bgBlur}px)` : undefined,
        WebkitBackdropFilter: bgBlur > 0 ? `blur(${bgBlur}px)` : undefined,
        border: bgBorder,
        borderRadius: bgRadius,
        padding: `${bgPaddingY}px ${bgPaddingX}px`,
        boxShadow: bgShadow,
        maxWidth: '88%',
      }}>
        {textNode}
      </div>
    );
  }

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
      <div style={{ width: dw, height: dh, flexShrink: 0, transform: `scale(${scale})`, display: 'flex', alignItems: 'center', justifyContent: justify, padding: '0 96px', boxSizing: 'border-box' }}>
        {body}
      </div>
    </AbsoluteFill>
  );
}

export function ItemLayer({ item, canvasW, canvasH, fit, borderRadius }: {
  item: TimelineItem;
  canvasW: number;
  canvasH: number;
  fit: AspectFit;
  borderRadius: number;
}) {
  const dw = item.width ?? 1920;
  const dh = item.height ?? 1080;
  const scale = fit === 'cover' ? Math.max(canvasW / dw, canvasH / dh) : Math.min(canvasW / dw, canvasH / dh);
  try {
    const Template = getCompiledTemplate(item.code ?? '');
    return (
      <VisualClipSurface item={item} fit={fit} canvasW={canvasW} canvasH={canvasH} borderRadius={borderRadius}>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ width: dw, height: dh, position: 'relative', flexShrink: 0, transform: `scale(${scale})` }}>
            <Template item={{ props: item.props ?? {}, width: dw, height: dh }} />
          </div>
        </div>
      </VisualClipSurface>
    );
  } catch (error) {
    return (
      <AbsoluteFill style={{ color: '#f88', fontFamily: 'monospace', fontSize: 20, padding: 40, whiteSpace: 'pre-wrap' }}>
        {(item.name + ' — compile error:\n') + (error instanceof Error ? error.message : String(error))}
      </AbsoluteFill>
    );
  }
}
