import { useMemo, useState } from 'react';
import type { CaptionsData, CaptionPacing, CaptionTemplate } from './types';
import type { TimelineItem, TrackId } from '../editor/types';
import type { TranscriptVariant } from '../transcript/types';
import { CaptionCueEditor } from './CaptionCueEditor';
import { CAPTION_STYLES, CAPTION_STYLE_BY_ID } from './styles';
import { theme } from '../theme';
import { useT } from '../i18n/locale';
import { ManualCaptionEditor } from './ManualCaptionEditor';
import { beginCaptionStylePointerDrag } from './captionStyleDrag';

interface CaptionsControlsProps {
  captionTrackId?: TrackId;
  captions: CaptionsData | null;
  /** translation / correction variants of the caption's source transcript (main-line language picker) */
  sourceVariants?: TranscriptVariant[];
  /** The sentence-by-sentence editing list needs to recalculate the same pagination as the rendering layer.,Need timeline items + fps */
  items: TimelineItem[];
  fps: number;
  /** Edit sentence by sentence:Jump preview(timeline ms) */
  onSeekMs?: (ms: number) => void;
  onCreateManual: () => void;
  getPlayheadMs?: () => number;
  onUpdate: (patch: Partial<CaptionsData>) => void;
  /** Completely remove subtitles (hide and clear overlay status) */
  onRemove?: () => void;
  onTranslate: (lang: string) => void;
  translating: boolean;
  translateError: string | null;
}

const PACINGS: { v: CaptionPacing; label: string; hint: string }[] = [
  { v: 'phrase', label: 'Sentence/phrase', hint: 'Display one sentence at a time, suitable for oral broadcast of documentaries' },
  { v: 'word', label: 'Highlight word by word', hint: 'The currently spoken word changes color, like Kara OK' },
];

/** translation target = Second line of language. When the spoken broadcast is in Chinese, it will be translated into English by default. Do not select "Chinese" again. */
const TRANSLATE_TO: { id: string; label: string }[] = [
  { id: 'English', label: 'English' },
  { id: 'Japanese', label: 'Japanese' },
  { id: 'Español', label: 'spanish' },
  { id: 'Français', label: 'French' },
  { id: '한국어', label: 'Korean' },
];

// Independent subtitle workspace: style, rhythm, manual subtitles and translation are all edited here.
export function CaptionsControls({
  captionTrackId, captions, sourceVariants = [], items, fps, onSeekMs, onCreateManual, getPlayheadMs, onUpdate, onRemove, onTranslate, translating, translateError,
}: CaptionsControlsProps) {
  const t = useT();
  const [bilingualOpen, setBilingualOpen] = useState(!!captions?.bilingual || !!captions?.translation);
  const style = captions ? CAPTION_STYLE_BY_ID[captions.template] : null;
  const pacingMeta = PACINGS.find((p) => p.v === (captions?.pacing ?? 'phrase')) ?? PACINGS[0]!;

  const translateLang = useMemo(() => {
    const cur = captions?.translationLang;
    if (cur && TRANSLATE_TO.some((l) => l.id === cur || l.label === cur)) return cur;
    // never default to Chinese — source VO is already Chinese
    return 'English';
  }, [captions?.translationLang]);

  return (
    <div className="cc-cap-panel open standalone">
      {!captions && (
        <div className="cc-cap-empty">
          <div className="cc-cap-empty-actions">
            <button type="button" className="cc-cap-btn primary" onClick={onCreateManual}>{t('Add subtitles manually')}</button>
          </div>
          <p className="cc-cap-hint">{t('Open Subtitle Styles from your transcript, or add individual subtitles manually here.')}</p>
        </div>
      )}

      {captions && (
        <div className="cc-cap-body">
          {/* show / Hidden — most visible */}
          <div className="cc-cap-row main">
            <label className="cc-cap-toggle">
              <input
                type="checkbox"
                checked={captions.enabled}
                onChange={(e) => onUpdate({ enabled: e.target.checked })}
              />
              <span>{captions.enabled ? t('Show subtitles in preview') : t('Subtitles are hidden')}</span>
            </label>
            <div className="cc-cap-row-actions">
              {!captions.enabled && (
                <button type="button" className="cc-cap-btn sm" onClick={() => onUpdate({ enabled: true })}>
                  {t('show')}
                </button>
              )}
              {captions.enabled && (
                <button type="button" className="cc-cap-btn sm" onClick={() => onUpdate({ enabled: false })}>
                  {t('hide')}
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  className="cc-cap-btn sm ghost"
                  title={t('Remove subtitles from the project')}
                  onClick={onRemove}
                >
                  {t('Remove')}
                </button>
              )}
            </div>
          </div>
          {!captions.enabled && (
            <p className="cc-cap-hint warn">{t('Subtitles are off, preview/Export will not be burned. Click "Show" again or check the box to restore.')}</p>
          )}

          {/* Style: color block + Chinese name */}
          <div className="cc-cap-field">
            <div className="cc-cap-label">{t('style appearance')}</div>
            <div className="cc-cap-styles" role="listbox" aria-label={t('subtitle style')}>
              {CAPTION_STYLES.map((s) => {
                const active = captions.template === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`cc-cap-style${active ? ' selected' : ''}`}
                    title={`${t(s.labelZh)} — ${t(s.hint)} · ${t('Drag to any position on the preview screen to create a new subtitle')}`}
                    onClick={() => onUpdate({ template: s.id as CaptionTemplate })}
                    onPointerDown={(event) => {
                      if (!captionTrackId) return;
                      beginCaptionStylePointerDrag(event.nativeEvent, { trackId: captionTrackId, template: s.id });
                    }}
                  >
                    <span
                      className="cc-cap-swatch"
                      style={{
                        color: s.color,
                        background: s.highlightBackground ?? '#1a1a1a',
                        borderColor: s.strokeWidth > 0 ? s.strokeColor : theme.border,
                      }}
                    >
                      {t('word')}
                    </span>
                    <span className="cc-cap-style-name">{t(s.labelZh)}</span>
                  </button>
                );
              })}
            </div>
            {style && <p className="cc-cap-hint">{t(style.labelZh)}：{t(style.hint)} · {t('Can be dragged to any position on the preview screen to create and edit subtitles')}</p>}
          </div>

          {/* Rhythm */}
          <div className="cc-cap-field">
            <div className="cc-cap-label">{t('show rhythm')}</div>
            <div className="cc-cap-pills">
              {PACINGS.map((p) => (
                <button
                  key={p.v}
                  type="button"
                  className={`cc-cap-pill${captions.pacing === p.v ? ' selected' : ''}`}
                  onClick={() => onUpdate({ pacing: p.v })}
                >
                  {t(p.label)}
                </button>
              ))}
            </div>
            <p className="cc-cap-hint">{t(pacingMeta.hint)}</p>
          </div>

          <ManualCaptionEditor captions={captions} items={items} onUpdate={onUpdate} getPlayheadMs={getPlayheadMs} onSeekMs={onSeekMs} />

          {/* Subtitle language (text variant): Change the main subtitle line to a certain translation/Corrected variant, timeline unchanged.
              Variants by Agent of manage_transcript translate Generate, only choose which one to display here. */}
          {sourceVariants.length > 0 && (
            <div className="cc-cap-field">
              <div className="cc-cap-label">{t('Subtitle language (text variant)')}</div>
              <select
                value={captions.captionVariantId ?? ''}
                onChange={(e) => onUpdate({ captionVariantId: e.target.value || undefined })}
                className="cc-cap-select"
              >
                <option value="">{t('Original text (source）')}</option>
                {sourceVariants.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
              <p className="cc-cap-hint">{t('Switch the language displayed in the main subtitle line. The translation only changes the text and the time of the words/The frame bits are still taken from the source.')}</p>
            </div>
          )}

          {/* Bilingual: folded, translated into English by default */}
          <div className="cc-cap-bilingual">
            <button
              type="button"
              className="cc-cap-bilingual-toggle"
              onClick={() => setBilingualOpen((v) => !v)}
              aria-expanded={bilingualOpen}
            >
              <span>{t('Bilingual second line (optional)')}</span>
              <span className="cc-cap-hint">{bilingualOpen ? t('close') : t('Expand')}</span>
            </button>
            {bilingualOpen && (
              <div className="cc-cap-bilingual-body">
                <p className="cc-cap-hint">
                  {t('The first line is still the original text (spoken in Chinese). The second line is')}<strong>{t('Translate')}</strong>{t(', please select the target language (do not select Chinese).')}
                </p>
                <div className="cc-cap-translate-row">
                  <select
                    value={translateLang}
                    disabled={translating}
                    onChange={(e) => onTranslate(e.target.value)}
                    className="cc-cap-select"
                  >
                    {TRANSLATE_TO.map((l) => (
                      <option key={l.id} value={l.id}>{t(l.label)}（{l.id}）</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="cc-cap-btn primary sm"
                    disabled={translating}
                    onClick={() => onTranslate(translateLang)}
                  >
                    {translating ? t('Translating…') : captions.translation ? t('retranslate') : t('Generate translation')}
                  </button>
                </div>
                {captions.translation && (
                  <label className="cc-cap-toggle">
                    <input
                      type="checkbox"
                      checked={!!captions.bilingual}
                      onChange={(e) => onUpdate({ bilingual: e.target.checked })}
                    />
                    <span>{t('Display the second line of translation ({lang}）', { lang: captions.translationLang ?? translateLang })}</span>
                  </label>
                )}
                {translateError && <div className="cc-cap-error">{translateError}</div>}
              </div>
            )}
          </div>

          {/* Manually change subtitle text sentence by sentence(with agent display_text Same channel) */}
          <CaptionCueEditor captions={captions} items={items} fps={fps} onUpdate={onUpdate} onSeekMs={onSeekMs} />
        </div>
      )}
    </div>
  );
}
