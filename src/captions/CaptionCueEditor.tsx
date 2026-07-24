import { useMemo, useState } from 'react';
import type { CaptionsData } from './types';
import type { TimelineItem } from '../editor/types';
import { useT } from '../i18n/locale';
import { buildCues, cueTextPatch, fmtCueMs } from './captionCues';

// Line-by-line subtitle editing: List the pagination results of the same pipeline in the rendering layer (resolve→overrides→paginate) as
// List of sentences with clickable/changeable text. Changes written back to wordOverrides (with agent edit_captions
// display_text (same channel): The entire new text of the sentence is hung on the first word of the sentence (with forceBreak to occupy an exclusive page),
// The remaining words are hidden; the first complement of the next sentence forceBreak prevents the following words from merging with the page. Undo the existing undo.
// Cost: Sentences that have been modified by hand lose the word-by-word karaoke highlighting granularity (the entire sentence is highlighted with the first word).

interface CaptionCueEditorProps {
  captions: CaptionsData;
  items: TimelineItem[];
  fps: number;
  onUpdate: (patch: Partial<CaptionsData>) => void;
  /** punctuation → The preview jumps to the beginning of the sentence(timeline ms) */
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
        <span>{t('Edit sentence by sentence')}{rows.length > 0 ? t('（{n} sentence)', { n: rows.length }) : ''}</span>
        <span className="cc-cap-hint">{open ? t('close') : t('Expand')}</span>
      </button>
      {open && multiLane && (
        <p className="cc-cap-hint">{t('Please modify the transcribed subtitle lane in the dialogue; the manual lane can be edited directly in the "Manual Subtitles" above.')}</p>
      )}
      {open && !multiLane && rows.length === 0 && (
        <p className="cc-cap-hint">{t('There are no editable subtitle sentences yet (translate and generate subtitles first).')}</p>
      )}
      {open && !multiLane && rows.length > 0 && (
        <div className="cc-cap-cues">
          <p className="cc-cap-hint">{t('Click the time code to jump to the corresponding screen; click the sentence text to change it directly, clear the text = delete the sentence. Changes can be undone (⌘Z）。')}</p>
          <div className="cc-cap-cue-list">
            {rows.map((cue, k) => (
              <div key={`${cue.start}_${k}`} className="cc-cap-cue-row">
                <button
                  type="button"
                  onClick={() => onSeekMs?.(cue.start)}
                  title={t('Skip to this sentence')}
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
                      <button type="button" className="cc-cap-btn primary sm" onClick={() => save(k, draft)}>{t('save')}</button>
                      <button type="button" className="cc-cap-btn sm" onClick={() => setEditIdx(null)}>{t('Cancel')}</button>
                      <button
                        type="button"
                        className="cc-cap-btn sm ghost"
                        title={t('This sentence will no longer be displayed (the words and timeline will not be affected)')}
                        onClick={() => save(k, '')}
                      >
                        {t('Delete this sentence')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="cc-cap-cue-text"
                    title={t('Click to edit this subtitle')}
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
