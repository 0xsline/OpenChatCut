import { AbsoluteFill } from 'remotion';
import { getCompiledTemplate } from '../template-host';
import type { AspectFit, TimelineItem, Watermark } from './types';
import { VisualClipSurface } from './TimelineMediaLayer';

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
    fontFamily: 'system-ui, -apple-system, sans-serif',
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
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
      <div style={{ width: dw, height: dh, flexShrink: 0, transform: `scale(${scale})`, display: 'flex', alignItems: 'center', justifyContent: justify, padding: '0 96px', boxSizing: 'border-box' }}>
        <div style={{ color: String(props.color ?? '#ffffff'), fontSize: Number(props.fontSize ?? 96), fontWeight: Number(props.fontWeight ?? 700), textAlign: align, width: '100%', fontFamily: 'system-ui, -apple-system, sans-serif', textShadow: '0 3px 16px rgba(0,0,0,0.55)', whiteSpace: 'pre-wrap', lineHeight: 1.2 }}>{String(props.text ?? '文字')}</div>
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
