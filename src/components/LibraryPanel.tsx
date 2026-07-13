import { useState } from 'react';
import { theme } from '../theme';
import type { Tpl } from '../types';

interface LibraryPanelProps {
  templates: Tpl[];
  selectedIdx: number;
  onSelect: (i: number) => void;
  props: Record<string, unknown>;
  onPropChange: (key: string, value: unknown) => void;
}

const MAIN_TABS = ['我的素材', '资源库', '文字稿'] as const;
const SUB_TABS = ['G 动画', '音效', '转场', '特效', '缩放', 'LUT', 'Audio'] as const;

export function LibraryPanel({ templates, selectedIdx, onSelect, props, onPropChange }: LibraryPanelProps) {
  const [mainTab, setMainTab] = useState<(typeof MAIN_TABS)[number]>('资源库');
  const [subTab, setSubTab] = useState<(typeof SUB_TABS)[number]>('G 动画');
  const selected = templates[selectedIdx];

  return (
    <section style={{ display: 'flex', flexDirection: 'column', borderRight: `1px solid ${theme.border}`, background: theme.panel, minHeight: 0, overflow: 'hidden' }}>
      {/* main tabs */}
      <div style={{ display: 'flex', gap: 16, padding: '10px 16px 0', fontSize: 13 }}>
        {MAIN_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setMainTab(t)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', paddingBottom: 8,
              color: mainTab === t ? theme.text : theme.textDim,
              fontWeight: mainTab === t ? 600 : 400,
              borderBottom: `2px solid ${mainTab === t ? theme.text : 'transparent'}`,
            }}
          >{t}</button>
        ))}
      </div>
      {/* sub tabs */}
      <div style={{ display: 'flex', gap: 14, padding: '10px 16px', fontSize: 12, borderBottom: `1px solid ${theme.border}`, flexWrap: 'wrap' }}>
        {SUB_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setSubTab(t)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: subTab === t ? theme.text : theme.textDim,
              borderBottom: `2px solid ${subTab === t ? theme.accent : 'transparent'}`,
              paddingBottom: 4,
            }}
          >{t}</button>
        ))}
      </div>

      {/* body: G 动画 shows the template grid; others are stubs */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
        {mainTab === '资源库' && subTab === 'G 动画' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
            {templates.map((tp, i) => (
              <button
                key={tp.id}
                onClick={() => onSelect(i)}
                title={tp.name}
                style={{
                  cursor: 'pointer', textAlign: 'left', padding: 0, overflow: 'hidden',
                  border: `1px solid ${i === selectedIdx ? theme.select : theme.border}`,
                  borderRadius: 8, background: theme.panelAlt, color: theme.text,
                }}
              >
                <div style={{ aspectRatio: '16 / 9', background: '#0c0c0c', display: 'grid', placeItems: 'center', fontSize: 22 }}>▦</div>
                <div style={{ padding: '6px 8px', fontSize: 11, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tp.name}</div>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ color: theme.textDim, fontSize: 12, padding: 8 }}>
            「{mainTab} · {subTab}」内容待接入（对应 ChatCut 的内置库/素材池）。
          </div>
        )}
      </div>

      {/* selected template props (asset detail) */}
      {selected && (
        <div style={{ borderTop: `1px solid ${theme.border}`, padding: '10px 14px', maxHeight: 220, overflowY: 'auto', background: theme.panelAlt }}>
          <div style={{ fontSize: 12, color: theme.text, marginBottom: 8, fontWeight: 600 }}>属性 · {selected.name}</div>
          {selected.propSchema.length === 0 && <div style={{ fontSize: 12, color: theme.textDim }}>该模板用内置默认值。</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {selected.propSchema.map((p) => (
              <label key={p.key} style={{ fontSize: 11, color: theme.textDim }}>
                <div style={{ marginBottom: 3 }}>{p.key}</div>
                {p.type === 'boolean' ? (
                  <input type="checkbox" checked={!!props[p.key]} onChange={(e) => onPropChange(p.key, e.target.checked)} />
                ) : p.type === 'color' ? (
                  <input type="color" value={String(props[p.key] ?? '#000000')} onChange={(e) => onPropChange(p.key, e.target.value)} />
                ) : (
                  <input
                    type={p.type === 'number' ? 'number' : 'text'}
                    value={String(props[p.key] ?? '')}
                    onChange={(e) => onPropChange(p.key, p.type === 'number' ? Number(e.target.value) : e.target.value)}
                    style={{ width: '100%', padding: '4px 6px', background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 5 }}
                  />
                )}
              </label>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
