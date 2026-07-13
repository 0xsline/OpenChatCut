import { useEffect, useRef, useState } from 'react';
import { theme } from '../theme';
import { ratioLabel, type ProjectDoc } from '../editor/types';
import type { EditorCommands } from '../editor/store';

interface TimelineTabsProps {
  doc: ProjectDoc;
  commands: EditorCommands;
}

/** bottom sequence-tab bar (source manage_timelines): switch / add / rename /
 * duplicate / delete timelines, plus a one-click 9:16 vertical copy for
 * long→short retargeting. */
export function TimelineTabs({ doc, commands }: TimelineTabsProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (renaming) inputRef.current?.select(); }, [renaming]);

  const timelines = [...doc.timelines].sort((a, b) => a.order - b.order);
  const commitRename = () => {
    if (renaming && draft.trim()) commands.renameTimeline(renaming, draft.trim());
    setRenaming(null);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderTop: `1px solid ${theme.border}`, background: theme.panel, overflowX: 'auto', flexShrink: 0 }}>
      {timelines.map((t) => {
        const active = t.id === doc.activeTimelineId;
        return (
          <div
            key={t.id}
            onClick={() => !active && commands.switchTimeline(t.id)}
            onDoubleClick={() => { setRenaming(t.id); setDraft(t.name); }}
            title="单击切换 · 双击重命名"
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 7, cursor: 'pointer', flexShrink: 0,
              background: active ? 'rgba(240,86,46,0.14)' : 'transparent',
              border: `1px solid ${active ? theme.accent : theme.border}`,
              color: active ? theme.text : theme.textDim,
            }}
          >
            {renaming === t.id ? (
              <input
                ref={inputRef}
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }}
                style={{ width: 88, background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 4, padding: '1px 4px', fontSize: 12, fontFamily: 'inherit' }}
              />
            ) : (
              <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{t.name}</span>
            )}
            <span style={{ fontSize: 10, color: theme.textDim, fontVariantNumeric: 'tabular-nums', background: theme.bg, borderRadius: 4, padding: '0 4px' }}>{ratioLabel(t.width, t.height)}</span>
            {timelines.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); commands.deleteTimeline(t.id); }}
                title="删除该序列"
                style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}
              >×</button>
            )}
          </div>
        );
      })}
      <span style={{ width: 6 }} />
      <button onClick={() => commands.createTimeline()} title="新建序列" style={tabBtn}>＋序列</button>
      <button onClick={() => commands.duplicateTimeline(doc.activeTimelineId)} title="复制当前序列" style={tabBtn}>⧉ 复制</button>
      <button
        onClick={() => commands.duplicateTimeline(doc.activeTimelineId, { retarget: { width: 1080, height: 1920, fit: 'cover' }, name: '竖屏' })}
        title="把当前序列复制为 9:16 竖屏（长转短）"
        style={tabBtn}
      >⇋ 竖屏副本</button>
    </div>
  );
}

const tabBtn: React.CSSProperties = {
  background: 'none', border: `1px solid ${theme.border}`, color: theme.textDim, cursor: 'pointer',
  fontSize: 12, borderRadius: 7, padding: '4px 8px', whiteSpace: 'nowrap', flexShrink: 0,
};
