import { useState } from 'react';
import { theme } from '../../theme';
import { formatWidgetAnswer, type WidgetField, type WidgetValues } from './widget-parse';

const primaryBtn: React.CSSProperties = { background: theme.accent, border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 12, padding: '5px 14px', fontWeight: 600 };
const radioLabel: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: theme.text };

function isAudioUrl(url: string): boolean {
  return /\.(mp3|wav|ogg|m4a|aac)(\?|$)/i.test(url);
}
function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(url);
}

// visual-option 的媒体预览：路径来自不可信 LLM 输出，可能加载失败（如源站专属 /voice-samples/...
// 在本地复刻里没有对应资源）——加载失败就隐藏媒体元素，不影响卡片其余部分的布局。
function MediaPreview({ media, aspectRatio }: { media?: string; aspectRatio?: string }) {
  const [broken, setBroken] = useState(false);
  if (!media || broken) return null;
  if (isAudioUrl(media)) {
    return <audio controls src={media} onError={() => setBroken(true)} style={{ width: '100%', height: 30, marginTop: 6 }} />;
  }
  if (isImageUrl(media)) {
    return (
      <img src={media} alt="" onError={() => setBroken(true)}
        style={{ width: '100%', aspectRatio: aspectRatio?.replace(':', ' / '), objectFit: 'cover', borderRadius: 6, marginTop: 6, display: 'block' }} />
    );
  }
  return null; // 未知媒体类型，跳过
}

interface WidgetCardProps {
  fields: WidgetField[];
  onSubmit: (answer: string) => void;
}

function isFilled(f: WidgetField, v: string | string[] | undefined): boolean {
  if (f.kind === 'multi') return Array.isArray(v) && v.length > 0;
  return typeof v === 'string' && v.trim().length > 0;
}

// 解析后的 <widget> 表单卡：单选/多选/可视化单选三种字段的交互 + 校验必填 + 提交后禁用（不可重复提交）。
export function WidgetCard({ fields, onSubmit }: WidgetCardProps) {
  const [values, setValues] = useState<WidgetValues>({});
  const [otherFields, setOtherFields] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);

  const selectSingle = (id: string, value: string) => {
    setValues((v) => ({ ...v, [id]: value }));
    setOtherFields((o) => ({ ...o, [id]: false }));
  };
  const selectOther = (id: string) => {
    setOtherFields((o) => ({ ...o, [id]: true }));
    setValues((v) => ({ ...v, [id]: '' }));
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
    <div style={{ border: `1px solid ${theme.border}`, borderRadius: 10, background: theme.panelAlt, padding: 14, margin: '10px 0', opacity: submitted ? 0.7 : 1 }}>
      {fields.map((f) => (
        <div key={f.id} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12.5, color: theme.text, marginBottom: 8, fontWeight: 600 }}>
            {f.label}
            {f.required && <span style={{ color: theme.accent }}> *</span>}
          </div>

          {f.kind === 'single' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {f.options.map((o) => (
                <label key={o.value} style={{ ...radioLabel, cursor: submitted ? 'default' : 'pointer' }}>
                  <input type="radio" name={f.id} disabled={submitted} checked={!otherFields[f.id] && values[f.id] === o.value}
                    onChange={() => selectSingle(f.id, o.value)} style={{ accentColor: theme.accent }} />
                  {o.display}
                </label>
              ))}
              {f.allowOther && (
                <label style={{ ...radioLabel, cursor: submitted ? 'default' : 'pointer' }}>
                  <input type="radio" name={f.id} disabled={submitted} checked={!!otherFields[f.id]}
                    onChange={() => selectOther(f.id)} style={{ accentColor: theme.accent }} />
                  其他…
                  {otherFields[f.id] && (
                    <input type="text" disabled={submitted} value={typeof values[f.id] === 'string' ? (values[f.id] as string) : ''}
                      onChange={(e) => setOtherText(f.id, e.target.value)} placeholder="请输入"
                      style={{ flex: 1, minWidth: 80, background: theme.panel, border: `1px solid ${theme.borderLight}`, borderRadius: 6, color: theme.text, fontSize: 12, padding: '3px 8px' }} />
                  )}
                </label>
              )}
            </div>
          )}

          {f.kind === 'multi' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {f.options.map((o) => {
                const checked = Array.isArray(values[f.id]) && (values[f.id] as string[]).includes(o.value);
                return (
                  <label key={o.value} style={{ ...radioLabel, cursor: submitted ? 'default' : 'pointer' }}>
                    <input type="checkbox" disabled={submitted} checked={checked} onChange={() => toggleMulti(f.id, o.value)} style={{ accentColor: theme.accent }} />
                    {o.display}
                  </label>
                );
              })}
            </div>
          )}

          {f.kind === 'visual' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {f.options.map((o) => {
                const on = values[f.id] === o.value;
                return (
                  <button key={o.value} type="button" disabled={submitted} onClick={() => selectVisual(f.id, o.value)}
                    style={{ textAlign: 'left', display: 'block', width: '100%', background: on ? theme.panel : 'transparent', border: `1px solid ${on ? theme.accent : theme.border}`, borderRadius: 8, padding: 8, cursor: submitted ? 'default' : 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 14, height: 14, borderRadius: '50%', border: `1.5px solid ${on ? theme.accent : theme.textDim}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {on && <span style={{ width: 7, height: 7, borderRadius: '50%', background: theme.accent }} />}
                      </span>
                      <span style={{ fontSize: 12.5, color: theme.text, fontWeight: 600 }}>{o.name}</span>
                    </div>
                    {o.summary && <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4, marginLeft: 20 }}>{o.summary}</div>}
                    <MediaPreview media={o.media} aspectRatio={o.aspectRatio} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={handleSubmit} disabled={!canSubmit} style={{ ...primaryBtn, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'default' }}>
          {submitted ? '已提交' : '提交'}
        </button>
      </div>
    </div>
  );
}
