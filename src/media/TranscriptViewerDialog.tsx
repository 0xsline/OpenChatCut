import { useMemo, useState, type MouseEvent } from 'react';
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

export function TranscriptViewerDialog({ asset, entries, onClose, onStep }: TranscriptViewerProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const index = entries.findIndex((entry) => entry.id === asset.id);
  const paragraphs = useMemo(() => transcriptParagraphs(asset.transcript ?? []), [asset.transcript]);
  const fullText = useMemo(() => paragraphs.map((paragraph) => paragraph.text).join('\n'), [paragraphs]);
  const stop = (event: MouseEvent) => event.stopPropagation();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions / insecure context): keep the text selectable.
    }
  };
  return <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('文字稿：{name}', { name: asset.name })} onClick={onClose}>
    <div className="cc-modal cc-transcript-viewer" onClick={stop}>
      <div className="cc-transcript-viewer-head">
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
  </div>;
}
