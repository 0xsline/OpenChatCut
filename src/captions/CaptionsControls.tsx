import { useMemo, useState } from 'react';
import type { CaptionsData, CaptionPacing, CaptionTemplate } from './types';
import type { TimelineItem } from '../editor/types';
import type { TranscriptVariant } from '../transcript/types';
import { CaptionCueEditor } from './CaptionCueEditor';
import { CAPTION_STYLES, CAPTION_STYLE_BY_ID } from './styles';
import { usePersistedState } from '../hooks/usePersistedState';
import { Icon } from '../components/icons';
import { theme } from '../theme';
import { useT } from '../i18n/locale';
import { ManualCaptionEditor } from './ManualCaptionEditor';

interface CaptionsControlsProps {
  captions: CaptionsData | null;
  hasTranscript: boolean;
  /** translation / correction variants of the caption's source transcript (main-line language picker) */
  sourceVariants?: TranscriptVariant[];
  /** 逐句编辑列表要复算与渲染层相同的分页,需要时间线 items + fps */
  items: TimelineItem[];
  fps: number;
  /** 逐句编辑:点句跳预览(时间线 ms) */
  onSeekMs?: (ms: number) => void;
  onGenerate: () => void;
  onCreateManual: () => void;
  getPlayheadMs?: () => number;
  onUpdate: (patch: Partial<CaptionsData>) => void;
  /** 完全移除字幕（隐藏且清掉 overlay 状态） */
  onRemove?: () => void;
  onTranslate: (lang: string) => void;
  translating: boolean;
  translateError: string | null;
  standalone?: boolean;
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

// 字幕 = 预览画面底部叠字（跟文字稿走）。整块面板可折叠，避免占满文字稿区。
export function CaptionsControls({
  captions, hasTranscript, sourceVariants = [], items, fps, onSeekMs, onGenerate, onCreateManual, getPlayheadMs, onUpdate, onRemove, onTranslate, translating, translateError, standalone = false,
}: CaptionsControlsProps) {
  const t = useT();
  // 默认收起：用户明确说「这个面板」碍事；点标题条展开
  const [panelOpen, setPanelOpen] = usePersistedState('cc.captionsPanelOpen', false);
  const [bilingualOpen, setBilingualOpen] = useState(!!captions?.bilingual || !!captions?.translation);
  const expanded = standalone || panelOpen;
  const style = captions ? CAPTION_STYLE_BY_ID[captions.template] : null;
  const pacingMeta = PACINGS.find((p) => p.v === (captions?.pacing ?? 'phrase')) ?? PACINGS[0]!;

  const translateLang = useMemo(() => {
    const cur = captions?.translationLang;
    if (cur && TRANSLATE_TO.some((l) => l.id === cur || l.label === cur)) return cur;
    // never default to 中文 — source VO is already Chinese
    return 'English';
  }, [captions?.translationLang]);

  const styleName = t(style?.labelZh ?? '字幕');
  const statusLine = !captions
    ? t('未生成')
    : captions.enabled
      ? t('显示中 · {style}', { style: styleName })
      : t('已隐藏 · {style}', { style: styleName });

  return (
    <div className={`cc-cap-panel${expanded ? ' open' : ' collapsed'}${standalone ? ' standalone' : ''}`}>
      {!standalone && <button
        type="button"
        className="cc-cap-head-btn"
        onClick={() => setPanelOpen((v) => !v)}
        aria-expanded={expanded}
        title={expanded ? t('收起字幕面板') : t('展开字幕面板')}
      >
        <span className={`cc-cap-chevron${expanded ? '' : ' closed'}`}>
          <Icon name="chevronDown" size={13} />
        </span>
        <span className="cc-cap-title">{t('字幕')}</span>
        <span className="cc-cap-status">{statusLine}</span>
        <span className="cc-cap-head-action">{expanded ? t('收起') : t('展开')}</span>
      </button>}

      {expanded && !captions && (
        <div className="cc-cap-empty">
          <button type="button" className="cc-cap-btn primary" onClick={onGenerate} disabled={!hasTranscript}>
            {t('生成字幕')}
          </button>
          <button type="button" className="cc-cap-btn" onClick={onCreateManual}>{t('手动添加字幕')}</button>
          <p className="cc-cap-hint">
            {hasTranscript
              ? t('根据当前文字稿在预览底部显示字幕。不需要时可点上方「收起」藏起本面板。')
              : t('没有文字稿也可手动添加字幕；需要自动生成时先完成转写。')}
          </p>
        </div>
      )}

      {expanded && captions && (
        <div className="cc-cap-body">
          {/* 显示 / 隐藏 — 最显眼 */}
          <div className="cc-cap-row main">
            <label className="cc-cap-toggle">
              <input
                type="checkbox"
                checked={captions.enabled}
                onChange={(e) => onUpdate({ enabled: e.target.checked })}
              />
              <span>{captions.enabled ? t('预览中显示字幕') : t('字幕已隐藏')}</span>
            </label>
            <div className="cc-cap-row-actions">
              {!captions.enabled && (
                <button type="button" className="cc-cap-btn sm" onClick={() => onUpdate({ enabled: true })}>
                  {t('显示')}
                </button>
              )}
              {captions.enabled && (
                <button type="button" className="cc-cap-btn sm" onClick={() => onUpdate({ enabled: false })}>
                  {t('隐藏')}
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  className="cc-cap-btn sm ghost"
                  title={t('从工程里去掉字幕（可再点生成字幕）')}
                  onClick={onRemove}
                >
                  {t('移除')}
                </button>
              )}
            </div>
          </div>
          {!captions.enabled && (
            <p className="cc-cap-hint warn">{t('字幕已关闭，预览/导出都不会烧录。再点「显示」或勾选即可恢复。')}</p>
          )}

          {/* 样式：色块 + 中文名 */}
          <div className="cc-cap-field">
            <div className="cc-cap-label">{t('样式外观')}</div>
            <div className="cc-cap-styles" role="listbox" aria-label={t('字幕样式')}>
              {CAPTION_STYLES.map((s) => {
                const active = captions.template === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`cc-cap-style${active ? ' selected' : ''}`}
                    title={`${t(s.labelZh)} — ${t(s.hint)}`}
                    onClick={() => onUpdate({ template: s.id as CaptionTemplate })}
                  >
                    <span
                      className="cc-cap-swatch"
                      style={{
                        color: s.color,
                        background: s.highlightBackground ?? '#1a1a1a',
                        borderColor: s.strokeWidth > 0 ? s.strokeColor : theme.border,
                      }}
                    >
                      {t('字')}
                    </span>
                    <span className="cc-cap-style-name">{t(s.labelZh)}</span>
                  </button>
                );
              })}
            </div>
            {style && <p className="cc-cap-hint">{t(style.labelZh)}：{t(style.hint)}</p>}
          </div>

          {/* 节奏 */}
          <div className="cc-cap-field">
            <div className="cc-cap-label">{t('显示节奏')}</div>
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

          <button type="button" className="cc-cap-btn" onClick={onGenerate} disabled={!hasTranscript}>
            {t('用当前文字稿刷新字幕')}
          </button>

          <ManualCaptionEditor captions={captions} items={items} onUpdate={onUpdate} getPlayheadMs={getPlayheadMs} onSeekMs={onSeekMs} />

          {/* 字幕语言（文本变体）：把主字幕行换成某个翻译/校正变体，时间轴不变。
              变体由 Agent 的 manage_transcript translate 生成，这里只选显示哪个。 */}
          {sourceVariants.length > 0 && (
            <div className="cc-cap-field">
              <div className="cc-cap-label">{t('字幕语言（文本变体）')}</div>
              <select
                value={captions.captionVariantId ?? ''}
                onChange={(e) => onUpdate({ captionVariantId: e.target.value || undefined })}
                className="cc-cap-select"
              >
                <option value="">{t('原文（source）')}</option>
                {sourceVariants.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
              <p className="cc-cap-hint">{t('切换主字幕行显示的语言。译文只换文本，词的时间/帧位仍取自源。')}</p>
            </div>
          )}

          {/* 双语：折叠，默认译成英文 */}
          <div className="cc-cap-bilingual">
            <button
              type="button"
              className="cc-cap-bilingual-toggle"
              onClick={() => setBilingualOpen((v) => !v)}
            >
              <span>{t('双语第二行（可选）')}</span>
              <span className="cc-cap-hint">{bilingualOpen ? t('收起') : t('展开')}</span>
            </button>
            {bilingualOpen && (
              <div className="cc-cap-bilingual-body">
                <p className="cc-cap-hint">
                  {t('第一行仍是原文（中文口播）。第二行是')}<strong>{t('翻译')}</strong>{t('，请选目标语言（不要选中文）。')}
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
                    {translating ? t('翻译中…') : captions.translation ? t('重新翻译') : t('生成翻译')}
                  </button>
                </div>
                {captions.translation && (
                  <label className="cc-cap-toggle">
                    <input
                      type="checkbox"
                      checked={!!captions.bilingual}
                      onChange={(e) => onUpdate({ bilingual: e.target.checked })}
                    />
                    <span>{t('显示翻译第二行（{lang}）', { lang: captions.translationLang ?? translateLang })}</span>
                  </label>
                )}
                {translateError && <div className="cc-cap-error">{translateError}</div>}
              </div>
            )}
          </div>

          {/* 逐句手改字幕文本(与 agent display_text 同通道) */}
          <CaptionCueEditor captions={captions} items={items} fps={fps} onUpdate={onUpdate} onSeekMs={onSeekMs} />
        </div>
      )}
    </div>
  );
}
