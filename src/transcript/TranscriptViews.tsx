import { useState } from 'react';
import { theme } from '../theme';
import {
  buildScriptRows,
  formatGapClock,
  isCjkText,
  speakerColor,
  speakerLabel,
  type IndexedWord,
  type ScriptRow,
  type WordGroup,
} from './segment';
import { msToFrame } from './types';
import { Icon } from '../components/icons';

interface WordRowProps {
  words: IndexedWord[];
  deleted: Set<number>;
  editMode: boolean;
  onWord: (w: IndexedWord) => void;
}

function WordRow({ words, deleted, editMode, onWord }: WordRowProps) {
  const cjk = isCjkText(words.map((w) => w.text).join(''));
  return (
    <span className="cc-tx-words" style={{ color: theme.text }}>
      {words.map((w, i) => {
        const isDel = deleted.has(w.gi);
        const prev = words[i - 1];
        const needSpace = !cjk && i > 0 && prev && !/^\s/.test(w.text) && !/\s$/.test(prev.text);
        return (
          <span key={w.gi}>
            {needSpace ? ' ' : null}
            <span
              className={`cc-tx-word${isDel ? ' del' : ''}${editMode ? ' editable' : ''}`}
              onClick={() => onWord(w)}
              title={editMode ? (isDel ? '恢复此词' : '删除此词') : `${(w.start / 1000).toFixed(2)}s`}
            >
              {w.text}
            </span>
          </span>
        );
      })}
    </span>
  );
}

interface ViewProps {
  groups: WordGroup[];
  deleted: Set<number>;
  editMode: boolean;
  onWord: (w: IndexedWord) => void;
}

/** Legacy paragraph groups (no gap rows) — kept for 段落视图. */
export function ParagraphView({ groups, deleted, editMode, onWord }: ViewProps) {
  if (!groups.length) {
    return <div className="cc-tx-muted">这段还没有转写文本。</div>;
  }
  return (
    <div className="cc-tx-script">
      {groups.map((p, i) => (
        <div key={i} className="cc-tx-speech">
          <div className="cc-tx-speech-label" style={{ color: speakerColor(p.speaker) }}>
            {speakerLabel(p.speaker)}
          </div>
          <div className="cc-tx-speech-body">
            <span className="cc-tx-grip" aria-hidden>⋮⋮</span>
            <WordRow words={p.words} deleted={deleted} editMode={editMode} onWord={onWord} />
          </div>
        </div>
      ))}
    </div>
  );
}

interface ScriptViewProps {
  words: import('./types').TranscriptWord[];
  deleted: Set<number>;
  editMode: boolean;
  fps: number;
  gapCapsMs?: Record<string, number>;
  silenceFrames?: number;
  onWord: (w: IndexedWord) => void;
  /** delete/compress gap before word afterWordGi */
  onDeleteGap: (afterWordGi: number) => void;
  /** set gap max ms (adjust); null = restore original */
  onCapGap: (afterWordGi: number, maxMs: number | null) => void;
}

/** Source-aligned 片段视图: speaker blocks + Gap: m:ss rows with trash. */
export function ScriptView({
  words, deleted, editMode, fps, gapCapsMs, silenceFrames, onWord, onDeleteGap, onCapGap,
}: ScriptViewProps) {
  const rows = buildScriptRows(words, deleted, { gapCapsMs, silenceFrames, fps });
  const [adjustGi, setAdjustGi] = useState<number | null>(null);

  if (!rows.length) {
    return <div className="cc-tx-muted">这段还没有转写文本。</div>;
  }

  return (
    <div className="cc-tx-script">
      {rows.map((row, i) => {
        if (row.kind === 'speech') {
          return (
            <div key={`s-${i}-${row.words[0]?.gi}`} className="cc-tx-speech">
              <div className="cc-tx-speech-label" style={{ color: speakerColor(row.speaker) }}>
                {speakerLabel(row.speaker)}
              </div>
              <div className="cc-tx-speech-body">
                <span className="cc-tx-grip" aria-hidden title="拖动手柄（展示对齐源站）">⋮⋮</span>
                <WordRow words={row.words} deleted={deleted} editMode={editMode} onWord={onWord} />
              </div>
            </div>
          );
        }
        // gap row
        const displayMs = row.removed ? 0 : row.appliedMs;
        const open = adjustGi === row.afterWordGi;
        return (
          <div key={`g-${row.afterWordGi}`} className={`cc-tx-gap-wrap${row.removed ? ' removed' : ''}`}>
            <div
              className="cc-tx-gap"
              role="group"
              aria-label={`气口 ${formatGapClock(row.gapMs)}`}
            >
              <button
                type="button"
                className="cc-tx-gap-main"
                onClick={() => setAdjustGi(open ? null : row.afterWordGi)}
                title="点击调整气口时长"
              >
                Gap: {formatGapClock(displayMs || (row.removed ? 0 : row.gapMs))}
                {row.removed ? ' · 已删除' : ''}
              </button>
              {!row.removed ? (
                <button
                  type="button"
                  className="cc-tx-gap-del"
                  title="删除气口（压掉这段静音）"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteGap(row.afterWordGi);
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="cc-tx-gap-del"
                  title="恢复原始气口"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCapGap(row.afterWordGi, null);
                  }}
                >
                  恢复
                </button>
              )}
            </div>
            {open && !row.removed && (
              <div className="cc-tx-gap-adjust">
                <span className="cc-tx-muted">原始 {formatGapClock(row.gapMs)}</span>
                <button type="button" className="cc-tx-btn sm" onClick={() => onCapGap(row.afterWordGi, 200)}>压到 0.2s</button>
                <button type="button" className="cc-tx-btn sm" onClick={() => onCapGap(row.afterWordGi, 500)}>压到 0.5s</button>
                <button type="button" className="cc-tx-btn sm" onClick={() => onDeleteGap(row.afterWordGi)}>删气口</button>
                <button type="button" className="cc-tx-btn sm ghost" onClick={() => onCapGap(row.afterWordGi, null)}>还原</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** @deprecated prefer ScriptView — kept for any external import */
export function SegmentView({ groups, deleted, editMode, onWord, fps }: ViewProps & { fps: number }) {
  return (
    <div className="cc-tx-script">
      {groups.map((s, i) => (
        <div key={i} className="cc-tx-speech">
          <div className="cc-tx-speech-label" style={{ color: speakerColor(s.speaker) }}>
            {speakerLabel(s.speaker)}
            <span className="cc-tx-muted" style={{ marginLeft: 8, fontWeight: 400 }}>
              {msToFrame(s.words[0]!.start, fps)}f
            </span>
          </div>
          <div className="cc-tx-speech-body">
            <span className="cc-tx-grip" aria-hidden>⋮⋮</span>
            <WordRow words={s.words} deleted={deleted} editMode={editMode} onWord={onWord} />
          </div>
        </div>
      ))}
    </div>
  );
}

// silence unused ScriptRow type export check
export type { ScriptRow };
