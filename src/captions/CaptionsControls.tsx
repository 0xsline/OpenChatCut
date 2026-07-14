import { useMemo, useState } from 'react';
import type { CaptionsData, CaptionPacing, CaptionTemplate } from './types';
import { CAPTION_STYLES, CAPTION_STYLE_BY_ID } from './styles';

interface CaptionsControlsProps {
  captions: CaptionsData | null;
  hasTranscript: boolean;
  onGenerate: () => void;
  onUpdate: (patch: Partial<CaptionsData>) => void;
  /** 完全移除字幕（隐藏且清掉 overlay 状态） */
  onRemove?: () => void;
  onTranslate: (lang: string) => void;
  translating: boolean;
  translateError: string | null;
}

const PACINGS: { v: CaptionPacing; label: string; hint: string }[] = [
  { v: 'phrase', label: '按句/短语', hint: '一次显示一句话，适合纪录片口播' },
  { v: 'word', label: '逐词高亮', hint: '当前说到的词会变色，像卡拉 OK' },
];

/** 翻译目标 = 第二行语言。口播已是中文时，默认译成英文，不要再选「中文」。 */
const TRANSLATE_TO: { id: string; label: string }[] = [
  { id: 'English', label: '英文' },
  { id: '日本語', label: '日文' },
  { id: 'Español', label: '西班牙文' },
  { id: 'Français', label: '法文' },
  { id: '한국어', label: '韩文' },
];

// 字幕 = 预览画面底部叠字（跟文字稿走）。样式只改外观，不改时间轴。
export function CaptionsControls({
  captions, hasTranscript, onGenerate, onUpdate, onRemove, onTranslate, translating, translateError,
}: CaptionsControlsProps) {
  const [bilingualOpen, setBilingualOpen] = useState(!!captions?.bilingual || !!captions?.translation);
  const style = captions ? CAPTION_STYLE_BY_ID[captions.template] : null;
  const pacingMeta = PACINGS.find((p) => p.v === (captions?.pacing ?? 'phrase')) ?? PACINGS[0]!;

  const translateLang = useMemo(() => {
    const cur = captions?.translationLang;
    if (cur && TRANSLATE_TO.some((l) => l.id === cur || l.label === cur)) return cur;
    // never default to 中文 — source VO is already Chinese
    return 'English';
  }, [captions?.translationLang]);

  return (
    <div className="cc-cap-panel">
      <div className="cc-cap-head">
        <span className="cc-cap-title">字幕</span>
        <span className="cc-cap-sub">叠在预览画面上，跟上方文字稿同步</span>
      </div>

      {!captions ? (
        <div className="cc-cap-empty">
          <button type="button" className="cc-cap-btn primary" onClick={onGenerate} disabled={!hasTranscript}>
            生成字幕
          </button>
          <p className="cc-cap-hint">
            {hasTranscript
              ? '根据当前文字稿在预览底部显示字幕。样式可随时改；不想要就关掉显示或移除。'
              : '先在上方完成「转写」，再生成字幕。'}
          </p>
        </div>
      ) : (
        <div className="cc-cap-body">
          {/* 显示 / 隐藏 — 最显眼 */}
          <div className="cc-cap-row main">
            <label className="cc-cap-toggle">
              <input
                type="checkbox"
                checked={captions.enabled}
                onChange={(e) => onUpdate({ enabled: e.target.checked })}
              />
              <span>{captions.enabled ? '预览中显示字幕' : '字幕已隐藏'}</span>
            </label>
            <div className="cc-cap-row-actions">
              {!captions.enabled && (
                <button type="button" className="cc-cap-btn sm" onClick={() => onUpdate({ enabled: true })}>
                  显示
                </button>
              )}
              {captions.enabled && (
                <button type="button" className="cc-cap-btn sm" onClick={() => onUpdate({ enabled: false })}>
                  隐藏
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  className="cc-cap-btn sm ghost"
                  title="从工程里去掉字幕（可再点生成字幕）"
                  onClick={onRemove}
                >
                  移除
                </button>
              )}
            </div>
          </div>
          {!captions.enabled && (
            <p className="cc-cap-hint warn">字幕已关闭，预览/导出都不会烧录。再点「显示」或勾选即可恢复。</p>
          )}

          {/* 样式：色块 + 中文名 */}
          <div className="cc-cap-field">
            <div className="cc-cap-label">样式外观</div>
            <div className="cc-cap-styles" role="listbox" aria-label="字幕样式">
              {CAPTION_STYLES.map((s) => {
                const active = captions.template === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`cc-cap-style${active ? ' selected' : ''}`}
                    title={`${s.labelZh} — ${s.hint}`}
                    onClick={() => onUpdate({ template: s.id as CaptionTemplate })}
                  >
                    <span
                      className="cc-cap-swatch"
                      style={{
                        color: s.color,
                        background: s.highlightBackground ?? '#1a1a1a',
                        borderColor: s.strokeWidth > 0 ? s.strokeColor : '#333',
                      }}
                    >
                      字
                    </span>
                    <span className="cc-cap-style-name">{s.labelZh}</span>
                  </button>
                );
              })}
            </div>
            {style && <p className="cc-cap-hint">{style.labelZh}：{style.hint}</p>}
          </div>

          {/* 节奏 */}
          <div className="cc-cap-field">
            <div className="cc-cap-label">显示节奏</div>
            <div className="cc-cap-pills">
              {PACINGS.map((p) => (
                <button
                  key={p.v}
                  type="button"
                  className={`cc-cap-pill${captions.pacing === p.v ? ' selected' : ''}`}
                  onClick={() => onUpdate({ pacing: p.v })}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="cc-cap-hint">{pacingMeta.hint}</p>
          </div>

          <button type="button" className="cc-cap-btn" onClick={onGenerate} disabled={!hasTranscript}>
            用当前文字稿刷新字幕
          </button>

          {/* 双语：折叠，默认译成英文 */}
          <div className="cc-cap-bilingual">
            <button
              type="button"
              className="cc-cap-bilingual-toggle"
              onClick={() => setBilingualOpen((v) => !v)}
            >
              <span>双语第二行（可选）</span>
              <span className="cc-cap-hint">{bilingualOpen ? '收起' : '展开'}</span>
            </button>
            {bilingualOpen && (
              <div className="cc-cap-bilingual-body">
                <p className="cc-cap-hint">
                  第一行仍是原文（中文口播）。第二行是<strong>翻译</strong>，请选目标语言（不要选中文）。
                </p>
                <div className="cc-cap-translate-row">
                  <select
                    value={translateLang}
                    disabled={translating}
                    onChange={(e) => onTranslate(e.target.value)}
                    className="cc-cap-select"
                  >
                    {TRANSLATE_TO.map((l) => (
                      <option key={l.id} value={l.id}>{l.label}（{l.id}）</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="cc-cap-btn primary sm"
                    disabled={translating}
                    onClick={() => onTranslate(translateLang)}
                  >
                    {translating ? '翻译中…' : captions.translation ? '重新翻译' : '生成翻译'}
                  </button>
                </div>
                {captions.translation && (
                  <label className="cc-cap-toggle">
                    <input
                      type="checkbox"
                      checked={!!captions.bilingual}
                      onChange={(e) => onUpdate({ bilingual: e.target.checked })}
                    />
                    <span>显示翻译第二行（{captions.translationLang ?? translateLang}）</span>
                  </label>
                )}
                {translateError && <div className="cc-cap-error">{translateError}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
