import { useMemo, useState } from 'react';
import type { CaptionsData } from './types';
import type { TimelineItem } from '../editor/types';
import { useT } from '../i18n/locale';
import { buildCues, cueTextPatch, fmtCueMs } from './captionCues';

// 逐句字幕编辑:把渲染层同一条管线(resolve→overrides→paginate)的分页结果列成
// 可点击/可改文字的句子列表。改动写回 wordOverrides(与 agent edit_captions 的
// display_text 同一通道):整句新文本挂在该句第一个词上(带 forceBreak 独占一页),
// 其余词 hidden;下一句句首补 forceBreak 防止后词并页。撤销走既有 undo。
// 代价:被手改过的句子失去逐词卡拉OK高亮粒度(整句随第一个词高亮)。

interface CaptionCueEditorProps {
  captions: CaptionsData;
  items: TimelineItem[];
  fps: number;
  onUpdate: (patch: Partial<CaptionsData>) => void;
  /** 点句 → 预览跳到该句开头(时间线 ms) */
  onSeekMs?: (ms: number) => void;
}

export function CaptionCueEditor({ captions, items, fps, onUpdate, onSeekMs }: CaptionCueEditorProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const multiLane = !!captions.sourceEntries?.length;
  const rows = useMemo(
    () => (multiLane ? [] : buildCues(captions, items, fps)),
    [multiLane, captions, items, fps],
  );

  const save = (k: number, text: string) => {
    const patch = cueTextPatch(captions, rows, k, text);
    if (patch) onUpdate(patch);
    setEditIdx(null);
  };

  const rowBtn: React.CSSProperties = {
    display: 'flex', gap: 8, alignItems: 'baseline', width: '100%', textAlign: 'left',
    background: 'none', border: 'none', padding: '5px 6px', borderRadius: 6, cursor: 'pointer',
    color: 'var(--cc-text)', font: 'inherit', fontSize: 12.5, lineHeight: 1.45,
  };

  return (
    <div className="cc-cap-bilingual">
      <button type="button" className="cc-cap-bilingual-toggle" onClick={() => setOpen((v) => !v)}>
        <span>{t('逐句编辑')}{rows.length > 0 ? t('（{n} 句）', { n: rows.length }) : ''}</span>
        <span className="cc-cap-hint">{open ? t('收起') : t('展开')}</span>
      </button>
      {open && multiLane && (
        <p className="cc-cap-hint">{t('多说话人/多车道字幕暂不支持逐句手改，请在对话里让 AI 修改。')}</p>
      )}
      {open && !multiLane && rows.length === 0 && (
        <p className="cc-cap-hint">{t('还没有可编辑的字幕句（先转写并生成字幕）。')}</p>
      )}
      {open && !multiLane && rows.length > 0 && (
        <div>
          <p className="cc-cap-hint">{t('点时间码跳到对应画面；点句子文字直接改，清空文字＝删掉这句。改动可撤销（⌘Z）。')}</p>
          <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {rows.map((cue, k) => (
              <div key={`${cue.start}_${k}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <button
                  type="button"
                  onClick={() => onSeekMs?.(cue.start)}
                  title={t('跳到这句')}
                  style={{ ...rowBtn, width: 'auto', flex: '0 0 auto', color: 'var(--cc-text-dim)', fontVariantNumeric: 'tabular-nums', padding: '5px 2px' }}
                >
                  {fmtCueMs(cue.start)}
                </button>
                {editIdx === k ? (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <textarea
                      value={draft}
                      autoFocus
                      rows={2}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(k, draft); }
                        if (e.key === 'Escape') setEditIdx(null);
                      }}
                      style={{
                        width: '100%', resize: 'vertical', borderRadius: 6, padding: '5px 7px',
                        background: 'var(--cc-bg)', color: 'var(--cc-text)', fontSize: 12.5, lineHeight: 1.45,
                        border: '1px solid var(--cc-accent)', outline: 'none', font: 'inherit',
                      }}
                    />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="cc-cap-btn primary sm" onClick={() => save(k, draft)}>{t('保存')}</button>
                      <button type="button" className="cc-cap-btn sm" onClick={() => setEditIdx(null)}>{t('取消')}</button>
                      <button
                        type="button"
                        className="cc-cap-btn sm ghost"
                        title={t('这句不再显示（词与时间线不受影响）')}
                        onClick={() => save(k, '')}
                      >
                        {t('删除这句')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    style={{ ...rowBtn, flex: 1 }}
                    title={t('点击编辑这句字幕')}
                    onClick={() => { setEditIdx(k); setDraft(cue.text); }}
                  >
                    {cue.text}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
