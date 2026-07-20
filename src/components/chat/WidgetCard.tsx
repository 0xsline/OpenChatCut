import { useState } from 'react';
import { useT } from '../../i18n/locale';
import { formatWidgetAnswer, type WidgetField, type WidgetValues } from './widget-parse';

function isAudioUrl(url: string): boolean {
  return /\.(mp3|wav|ogg|m4a|aac)(\?|$)/i.test(url);
}
function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(url);
}

function MediaPreview({ media, aspectRatio }: { media?: string; aspectRatio?: string }) {
  const [broken, setBroken] = useState(false);
  if (!media || broken) return null;
  if (isAudioUrl(media)) {
    return <audio controls src={media} onError={() => setBroken(true)} className="cc-widget-media-audio" />;
  }
  if (isImageUrl(media)) {
    return (
      <img
        src={media}
        alt=""
        onError={() => setBroken(true)}
        className="cc-widget-media-img"
        style={{ aspectRatio: aspectRatio?.replace(':', ' / ') }}
      />
    );
  }
  return null;
}

interface WidgetCardProps {
  fields: WidgetField[];
  onSubmit: (answer: string) => void;
}

function isFilled(f: WidgetField, v: string | string[] | undefined): boolean {
  if (f.kind === 'multi') return Array.isArray(v) && v.length > 0;
  return typeof v === 'string' && v.trim().length > 0;
}

export function WidgetCard({ fields, onSubmit }: WidgetCardProps) {
  const t = useT();
  const [values, setValues] = useState<WidgetValues>({});
  const [otherFields, setOtherFields] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);

  const selectSingle = (id: string, value: string) => {
    setValues((v) => ({ ...v, [id]: value }));
    setOtherFields((o) => ({ ...o, [id]: false }));
  };
  const selectOther = (id: string) => {
    setOtherFields((o) => ({ ...o, [id]: true }));
    setValues((v) => ({ ...v, [id]: typeof v[id] === 'string' && otherFields[id] ? v[id] : '' }));
  };
  const setOtherText = (id: string, text: string) => setValues((v) => ({ ...v, [id]: text }));
  const toggleMulti = (id: string, value: string) => {
    setValues((v) => {
      const cur = Array.isArray(v[id]) ? (v[id] as string[]) : [];
      const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
      return { ...v, [id]: next };
    });
  };
  const selectVisual = (id: string, value: string) => setValues((v) => ({ ...v, [id]: value }));

  const canSubmit = !submitted && fields.every((f) => !f.required || isFilled(f, values[f.id]));
  const handleSubmit = () => {
    if (!canSubmit) return;
    const answer = formatWidgetAnswer(fields, values);
    setSubmitted(true);
    onSubmit(answer);
  };

  return (
    <div className={`cc-widget${submitted ? ' submitted' : ''}`}>
      <div className="cc-widget-body">
        {fields.map((f, fi) => (
          <section key={f.id} className={`cc-widget-field${fi === 0 ? ' first' : ''}`}>
            <header className="cc-widget-field-head">
              <h4 className="cc-widget-label">{f.label}</h4>
              {f.required ? <span className="cc-widget-req">{t('必选')}</span> : <span className="cc-widget-opt">{t('可选')}</span>}
            </header>

            {f.kind === 'single' && (
              <div className="cc-widget-options" role="radiogroup" aria-label={f.label}>
                {f.options.map((o) => {
                  const on = !otherFields[f.id] && values[f.id] === o.value;
                  return (
                    <label key={o.value} className={`cc-widget-option${on ? ' on' : ''}${submitted ? ' disabled' : ''}`}>
                      <input
                        type="radio"
                        name={f.id}
                        disabled={submitted}
                        checked={on}
                        onChange={() => selectSingle(f.id, o.value)}
                      />
                      <span className="cc-widget-radio" aria-hidden />
                      <span className="cc-widget-option-text">{o.display}</span>
                    </label>
                  );
                })}
                {f.allowOther && (
                  <label className={`cc-widget-option cc-widget-other${otherFields[f.id] ? ' on' : ''}${submitted ? ' disabled' : ''}`}>
                    <input
                      type="radio"
                      name={f.id}
                      disabled={submitted}
                      checked={!!otherFields[f.id]}
                      onChange={() => selectOther(f.id)}
                    />
                    <span className="cc-widget-radio" aria-hidden />
                    <span className="cc-widget-option-text">{t('其他…')}</span>
                    {otherFields[f.id] && (
                      <input
                        type="text"
                        className="cc-widget-other-input"
                        disabled={submitted}
                        autoFocus
                        value={typeof values[f.id] === 'string' ? (values[f.id] as string) : ''}
                        onChange={(e) => setOtherText(f.id, e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        placeholder={t('请输入')}
                      />
                    )}
                  </label>
                )}
              </div>
            )}

            {f.kind === 'multi' && (
              <div className="cc-widget-options" role="group" aria-label={f.label}>
                {f.options.map((o) => {
                  const checked = Array.isArray(values[f.id]) && (values[f.id] as string[]).includes(o.value);
                  return (
                    <label key={o.value} className={`cc-widget-option${checked ? ' on' : ''}${submitted ? ' disabled' : ''}`}>
                      <input
                        type="checkbox"
                        disabled={submitted}
                        checked={checked}
                        onChange={() => toggleMulti(f.id, o.value)}
                      />
                      <span className="cc-widget-check" aria-hidden />
                      <span className="cc-widget-option-text">{o.display}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {f.kind === 'visual' && (
              <div className="cc-widget-visuals" role="radiogroup" aria-label={f.label}>
                {f.options.map((o) => {
                  const on = values[f.id] === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={submitted}
                      className={`cc-widget-visual${on ? ' on' : ''}`}
                      onClick={() => selectVisual(f.id, o.value)}
                    >
                      <span className="cc-widget-radio" aria-hidden />
                      <span className="cc-widget-visual-body">
                        <span className="cc-widget-visual-name">{o.name}</span>
                        {o.summary ? <span className="cc-widget-visual-summary">{o.summary}</span> : null}
                        <MediaPreview media={o.media} aspectRatio={o.aspectRatio} />
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        ))}
      </div>

      <footer className="cc-widget-foot" aria-live="polite">
        {submitted ? (
          <span className="cc-widget-done">
            <span className="cc-widget-done-dot" />
            {t('已提交')}
          </span>
        ) : (
          <span className="cc-widget-hint">{t('选择后提交，Agent 会按你的选择继续')}</span>
        )}
        <button
          type="button"
          className="cc-widget-submit"
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          {submitted ? t('已提交') : t('提交')}
        </button>
      </footer>
    </div>
  );
}
