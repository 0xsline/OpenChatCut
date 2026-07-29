import { useMemo, useState } from 'react';
import type { CaptionsData } from './types';
import type { TimelineItem } from '../editor/types';
import { useT } from '../i18n/locale';
import { buildCues, cueTextPatch, fmtCueMs } from './captionCues';

// Sentence-by-sentence caption editing: List the pagination results of the same pipeline in the rendering layer (resolve→overrides→paginate) as
// A list of sentences that can be clicked/changed. Changes written back to wordOverrides (with agent edit_captions
// display_text (same channel): The entire new text of the sentence is hung on the first word of the sentence (with forceBreak to occupy an exclusive page),
// The rest of the words hidden; the first complement of the next sentence forceBreak prevents the following words from merging pages. Undo the existing undo.
// Cost: Sentences that have been modified by hand lose the word-by-word karaoke highlighting granularity (the entire sentence is highlighted with the first word).

interface CaptionCueEditorProps {
  captions: CaptionsData;
  items: TimelineItem[];
  fps: number;
  onUpdate: (patch: Partial<CaptionsData>) => void;
  /** Click sentence → the preview jumps to the beginning of the sentence (timeline ms) */
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

  return (
    <div className="cc-cap-bilingual">
      <button type="button" className="cc-cap-bilingual-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{t('逐句编辑')}{rows.length > 0 ? t('（{n} 句）', { n: rows.length }) : ''}</span>
        <span className="cc-cap-hint">{open ? t('收起') : t('展开')}</span>
      </button>
      {open && multiLane && (
        <p className="cc-cap-hint">{t('转写字幕车道请在对话里修改；手动车道可在上方「手动字幕」中直接编辑。')}</p>
      )}
      {open && !multiLane && rows.length === 0 && (
        <p className="cc-cap-hint">{t('还没有可编辑的字幕句（先转写并生成字幕）。')}</p>
      )}
      {open && !multiLane && rows.length > 0 && (
        <div className="cc-cap-cues">
          <p className="cc-cap-hint">{t('点时间码跳到对应画面；点句子文字直接改，清空文字＝删掉这句。改动可撤销（⌘Z）。')}</p>
          <div className="cc-cap-cue-list">
            {rows.map((cue, k) => (
              <div key={`${cue.start}_${k}`} className="cc-cap-cue-row">
                <button
                  type="button"
                  onClick={() => onSeekMs?.(cue.start)}
                  title={t('跳到这句')}
                  className="cc-cap-cue-time"
                >
                  {fmtCueMs(cue.start)}
                </button>
                {editIdx === k ? (
                  <div className="cc-cap-cue-edit">
                    <textarea
                      value={draft}
                      autoFocus
                      rows={2}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(k, draft); }
                        if (e.key === 'Escape') setEditIdx(null);
                      }}
                      className="cc-cap-input cc-cap-textarea active"
                    />
                    <div className="cc-cap-cue-actions">
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
                    className="cc-cap-cue-text"
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
