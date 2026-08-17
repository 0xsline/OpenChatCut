import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { MediaAsset } from '../editor/types';
import { useT } from '../i18n/locale';
import { Icon } from '../components/icons';
import { transcriptParagraphs, transcriptTimestamp } from './transcriptParagraphs';

export interface TranscriptViewerProps {
  /** Currently viewed asset; must be a member of `entries`. */
  asset: MediaAsset;
  /** Pool assets carrying a non-empty transcript, in pool display order. */
  entries: MediaAsset[];
  onClose: () => void;
  /** Step within `entries`; wraps at both ends. */
  onStep: (delta: number) => void;
}

interface PanelPosition {
  left: number;
  top: number;
}

/**
 * Non-modal floating transcript reader: draggable by its header, stays out of
 * the way of the main UI, and follows pool interactions (a ✓ badge click
 * swaps the viewed asset). Closes only via its close button.
 */
export function TranscriptViewerDialog({ asset, entries, onClose, onStep }: TranscriptViewerProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; baseLeft: number; baseTop: number } | null>(null);
  const index = entries.findIndex((entry) => entry.id === asset.id);
  const paragraphs = useMemo(() => transcriptParagraphs(asset.transcript ?? []), [asset.transcript]);
  const fullText = useMemo(() => paragraphs.map((paragraph) => paragraph.text).join('\n'), [paragraphs]);
  const stop = (event: ReactMouseEvent) => event.stopPropagation();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions / insecure context): keep the text selectable.
    }
  };
  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('button')) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseLeft: rect.left,
      baseTop: rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPosition({
      left: Math.round(drag.baseLeft + event.clientX - drag.startX),
      top: Math.round(drag.baseTop + event.clientY - drag.startY),
    });
  };
  const onHeaderPointerUp = () => {
    dragRef.current = null;
  };
  return (
    <div
      ref={panelRef}
      className="cc-transcript-viewer-panel"
      style={position ? { left: position.left, top: position.top, right: 'auto', bottom: 'auto' } : undefined}
      role="region"
      aria-label={t('文字稿：{name}', { name: asset.name })}
      onClick={stop}
    >
      <div
        className="cc-transcript-viewer-head"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <strong title={asset.name}>{asset.name}</strong>
        <div className="cc-transcript-viewer-actions">
          <button type="button" className="primary" onClick={() => void copy()}>{copied ? t('已复制') : t('复制全文')}</button>
          <button type="button" disabled={entries.length < 2} onClick={() => onStep(-1)} aria-label={t('上一条')} title={t('上一条')}><Icon name="prev" size={15} /></button>
          <span className="cc-transcript-viewer-count">{index >= 0 ? `${index + 1} / ${entries.length}` : '1 / 1'}</span>
          <button type="button" disabled={entries.length < 2} onClick={() => onStep(1)} aria-label={t('下一条')} title={t('下一条')}><Icon name="next" size={15} /></button>
          <button type="button" onClick={onClose} aria-label={t('关闭')}><Icon name="x" size={15} /></button>
        </div>
      </div>
      <div className="cc-transcript-viewer-body">
        {paragraphs.length === 0
          ? <p className="cc-transcript-viewer-empty">{t('暂无文字稿')}</p>
          : paragraphs.map((paragraph, i) => (
            <p key={`${paragraph.start}-${i}`} className="cc-transcript-viewer-paragraph">
              <span className="cc-transcript-viewer-time">{transcriptTimestamp(paragraph.start)}</span>
              {paragraph.text}
            </p>
          ))}
      </div>
    </div>
  );
}
