import { theme } from '../theme';

interface TopBarProps {
  projectName: string;
  credits: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExport?: () => void;
  exporting?: boolean;
}

const iconBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: theme.textDim,
  cursor: 'pointer',
  fontSize: 16,
  padding: '4px 6px',
  borderRadius: 6,
};

export function TopBar({ projectName, credits, canUndo, canRedo, onUndo, onRedo, onExport, exporting }: TopBarProps) {
  return (
    <header
      style={{
        gridColumn: '1 / -1',
        gridRow: 1,
        height: 48,
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        borderBottom: `1px solid ${theme.border}`,
        background: theme.panel,
        gap: 12,
      }}
    >
      <button style={iconBtn} title="首页">⌂</button>
      <div style={{ flex: 1, textAlign: 'center', fontSize: 13, color: theme.text, display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center' }}>
        <span>{projectName}</span>
        <span style={{ color: theme.textDim }} title="协作者">⧉</span>
      </div>
      <button style={{ ...iconBtn, opacity: canUndo ? 1 : 0.3, cursor: canUndo ? 'pointer' : 'default' }} title="撤销" onClick={onUndo} disabled={!canUndo}>↶</button>
      <button style={{ ...iconBtn, opacity: canRedo ? 1 : 0.3, cursor: canRedo ? 'pointer' : 'default' }} title="重做" onClick={onRedo} disabled={!canRedo}>↷</button>
      <button style={iconBtn} title="历史">🕑</button>
      <button style={iconBtn} title="布局">▦</button>
      <button
        onClick={onExport}
        disabled={exporting || !onExport}
        title="导出 MP4"
        style={{
          background: theme.accent,
          color: '#fff',
          border: 'none',
          borderRadius: 8,
          padding: '6px 16px',
          fontSize: 13,
          fontWeight: 600,
          cursor: exporting || !onExport ? 'default' : 'pointer',
          opacity: exporting || !onExport ? 0.6 : 1,
        }}
      >
        {exporting ? '导出中…' : '导出'}
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.text }}>
        <span style={{ color: theme.accent }}>✦</span>
        {credits.toFixed(1)}
        <span
          style={{
            width: 22, height: 22, borderRadius: '50%', background: '#444',
            display: 'grid', placeItems: 'center', fontSize: 11, color: '#ddd',
          }}
        >W</span>
      </div>
    </header>
  );
}
