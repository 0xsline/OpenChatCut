import { theme } from '../theme';
import { speakerLabel, type IndexedWord, type WordGroup } from './segment';
import { msToFrame } from './types';

interface WordRowProps {
  words: IndexedWord[];
  deleted: Set<number>;
  editMode: boolean;
  onWord: (w: IndexedWord) => void;
}

function WordRow({ words, deleted, editMode, onWord }: WordRowProps) {
  return (
    <span style={{ fontSize: 13, lineHeight: 1.9, color: theme.text }}>
      {words.map((w) => {
        const isDel = deleted.has(w.gi);
        return (
          <span
            key={w.gi}
            onClick={() => onWord(w)}
            title={editMode ? (isDel ? '恢复此词' : '删除此词') : `${(w.start / 1000).toFixed(2)}s`}
            style={{ cursor: 'pointer', padding: '1px 2px', borderRadius: 3, textDecoration: isDel ? 'line-through' : 'none', opacity: isDel ? 0.38 : 1 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = editMode && !isDel ? '#7a2f2f' : theme.accent)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            {w.text}{' '}
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

export function ParagraphView({ groups, deleted, editMode, onWord }: ViewProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {groups.map((p, i) => (
        <div key={i}>
          <div style={{ color: '#5b9bff', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{speakerLabel(p.speaker)}</div>
          <WordRow words={p.words} deleted={deleted} editMode={editMode} onWord={onWord} />
        </div>
      ))}
    </div>
  );
}

export function SegmentView({ groups, deleted, editMode, onWord, fps }: ViewProps & { fps: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {groups.map((s, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 8px', border: `1px solid ${theme.border}`, borderRadius: 6, background: theme.panelAlt }}>
          <div style={{ fontSize: 10, color: theme.textDim, fontVariantNumeric: 'tabular-nums', flexShrink: 0, width: 58 }}>
            <div style={{ color: '#5b9bff' }}>{speakerLabel(s.speaker)}</div>
            {msToFrame(s.words[0].start, fps)}f
          </div>
          <WordRow words={s.words} deleted={deleted} editMode={editMode} onWord={onWord} />
        </div>
      ))}
    </div>
  );
}
