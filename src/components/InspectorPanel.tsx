import { theme } from '../theme';
import type { Tpl } from '../types';
import type { TimelineItem } from '../editor/types';

interface InspectorPanelProps {
  templates: Tpl[];
  selectedItem: TimelineItem | null;
  onItemPropChange: (key: string, value: unknown) => void;
}

// Property editor for the selected timeline item (sits under the preview).
export function InspectorPanel({ templates, selectedItem, onItemPropChange }: InspectorPanelProps) {
  const schema = selectedItem
    ? templates.find((t) => t.id === selectedItem.templateId)?.propSchema ?? []
    : [];

  return (
    <section style={{ borderTop: `1px solid ${theme.border}`, background: theme.panel, display: 'flex', flexDirection: 'column', minHeight: 0, flex: '0 0 auto', maxHeight: '42%', overflow: 'hidden' }}>
      <div style={{ padding: '8px 16px', fontSize: 12, color: theme.textDim, borderBottom: `1px solid ${theme.border}`, flexShrink: 0 }}>
        属性{selectedItem ? ` · ${selectedItem.name}` : ''}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px', minHeight: 0 }}>
        {!selectedItem ? (
          <div style={{ fontSize: 12, color: theme.textDim }}>选中时间线上的片段以编辑属性。</div>
        ) : schema.length === 0 ? (
          <div style={{ fontSize: 12, color: theme.textDim }}>该模板用内置默认值（无可编辑属性）。</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {schema.map((p) => (
              <label key={p.key} style={{ fontSize: 11, color: theme.textDim }}>
                <div style={{ marginBottom: 4 }}>{p.key} <em style={{ opacity: 0.5 }}>({p.type})</em></div>
                {p.type === 'boolean' ? (
                  <input type="checkbox" checked={!!selectedItem.props[p.key]} onChange={(e) => onItemPropChange(p.key, e.target.checked)} />
                ) : p.type === 'color' ? (
                  <input type="color" value={String(selectedItem.props[p.key] ?? '#000000')} onChange={(e) => onItemPropChange(p.key, e.target.value)} />
                ) : (
                  <input
                    type={p.type === 'number' ? 'number' : 'text'}
                    value={String(selectedItem.props[p.key] ?? '')}
                    onChange={(e) => onItemPropChange(p.key, p.type === 'number' ? Number(e.target.value) : e.target.value)}
                    style={{ width: '100%', padding: '5px 7px', background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 5 }}
                  />
                )}
              </label>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
