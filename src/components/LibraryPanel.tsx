import { useState } from 'react';
import { theme } from '../theme';
import type { Tpl } from '../types';
import type { TimelineItem } from '../editor/types';

interface LibraryPanelProps {
  templates: Tpl[];
  onAddTemplate: (tpl: Tpl) => void;
  selectedItem: TimelineItem | null;
  onItemPropChange: (key: string, value: unknown) => void;
}

const MAIN_TABS = ['我的素材', '资源库', '文字稿'] as const;
const SUB_TABS = ['G 动画', '音效', '转场', '特效', '缩放', 'LUT', 'Audio'] as const;

// group templates by category, preserving first-seen order
function CATEGORIES(templates: Tpl[]): { cat: string; items: Tpl[] }[] {
  const map = new Map<string, Tpl[]>();
  for (const t of templates) {
    if (!map.has(t.category)) map.set(t.category, []);
    map.get(t.category)!.push(t);
  }
  return [...map.entries()].map(([cat, items]) => ({ cat, items }));
}

export function LibraryPanel({ templates, onAddTemplate, selectedItem, onItemPropChange }: LibraryPanelProps) {
  const [mainTab, setMainTab] = useState<(typeof MAIN_TABS)[number]>('资源库');
  const [subTab, setSubTab] = useState<(typeof SUB_TABS)[number]>('G 动画');

  const schema = selectedItem
    ? templates.find((t) => t.id === selectedItem.templateId)?.propSchema ?? []
    : [];

  return (
    <section style={{ display: 'flex', flexDirection: 'column', borderRight: `1px solid ${theme.border}`, background: theme.panel, minHeight: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 16, padding: '10px 16px 0', fontSize: 13 }}>
        {MAIN_TABS.map((t) => (
          <button key={t} onClick={() => setMainTab(t)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', paddingBottom: 8, color: mainTab === t ? theme.text : theme.textDim, fontWeight: mainTab === t ? 600 : 400, borderBottom: `2px solid ${mainTab === t ? theme.text : 'transparent'}` }}>{t}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, padding: '10px 16px', fontSize: 12, borderBottom: `1px solid ${theme.border}`, flexWrap: 'wrap' }}>
        {SUB_TABS.map((t) => (
          <button key={t} onClick={() => setSubTab(t)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: subTab === t ? theme.text : theme.textDim, borderBottom: `2px solid ${subTab === t ? theme.accent : 'transparent'}`, paddingBottom: 4 }}>{t}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
        {mainTab === '资源库' && subTab === 'G 动画' ? (
          <>
            <div style={{ fontSize: 11, color: theme.textDim, marginBottom: 8 }}>{templates.length} 个模板</div>
            {CATEGORIES(templates).map(({ cat, items }) => (
              <div key={cat} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: theme.textDim, margin: '4px 2px 8px', textTransform: 'capitalize' }}>{cat} · {items.length}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
                  {items.map((tp) => (
                    <button key={tp.id} onClick={() => onAddTemplate(tp)} title={`点击加到时间线：${tp.name}`}
                      style={{ cursor: 'pointer', textAlign: 'left', padding: 0, overflow: 'hidden', border: `1px solid ${theme.border}`, borderRadius: 8, background: theme.panelAlt, color: theme.text }}>
                      <div style={{ aspectRatio: '16 / 9', background: '#0c0c0c', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
                        {tp.thumb ? (
                          <img src={tp.thumb} alt={tp.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <span style={{ fontSize: 20, color: theme.textDim }}>＋</span>
                        )}
                      </div>
                      <div style={{ padding: '5px 7px', fontSize: 10.5, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tp.name}</div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        ) : (
          <div style={{ color: theme.textDim, fontSize: 12, padding: 8 }}>「{mainTab} · {subTab}」内容待接入。</div>
        )}
      </div>

      {/* selected timeline item props */}
      <div style={{ borderTop: `1px solid ${theme.border}`, padding: '10px 14px', maxHeight: 220, overflowY: 'auto', background: theme.panelAlt }}>
        {!selectedItem ? (
          <div style={{ fontSize: 12, color: theme.textDim }}>选中时间线上的片段以编辑属性。</div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: theme.text, marginBottom: 8, fontWeight: 600 }}>属性 · {selectedItem.name}</div>
            {schema.length === 0 && <div style={{ fontSize: 12, color: theme.textDim }}>该模板用内置默认值。</div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {schema.map((p) => (
                <label key={p.key} style={{ fontSize: 11, color: theme.textDim }}>
                  <div style={{ marginBottom: 3 }}>{p.key}</div>
                  {p.type === 'boolean' ? (
                    <input type="checkbox" checked={!!selectedItem.props[p.key]} onChange={(e) => onItemPropChange(p.key, e.target.checked)} />
                  ) : p.type === 'color' ? (
                    <input type="color" value={String(selectedItem.props[p.key] ?? '#000000')} onChange={(e) => onItemPropChange(p.key, e.target.value)} />
                  ) : (
                    <input type={p.type === 'number' ? 'number' : 'text'} value={String(selectedItem.props[p.key] ?? '')}
                      onChange={(e) => onItemPropChange(p.key, p.type === 'number' ? Number(e.target.value) : e.target.value)}
                      style={{ width: '100%', padding: '4px 6px', background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 5 }} />
                  )}
                </label>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
