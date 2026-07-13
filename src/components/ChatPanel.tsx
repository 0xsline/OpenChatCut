import { theme } from '../theme';

// AI chat panel (left). Stub UI matching ChatCut — the agent layer is not built yet.
export function ChatPanel() {
  return (
    <aside
      style={{
        gridColumn: 1,
        gridRow: 2,
        display: 'flex',
        flexDirection: 'column',
        borderRight: `1px solid ${theme.border}`,
        background: theme.panel,
        minHeight: 0,
      }}
    >
      <div style={{ padding: '10px 14px', fontSize: 12, color: theme.textDim, borderBottom: `1px solid ${theme.border}` }}>AI</div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14, fontSize: 13, color: theme.text, minHeight: 0 }}>
        <div style={{ color: theme.text, marginBottom: 20 }}>有什么视频剪辑需要帮忙的吗？</div>
        <div
          style={{
            marginLeft: 'auto', maxWidth: '85%', background: theme.panelAlt,
            border: `1px solid ${theme.border}`, borderRadius: 10, padding: '10px 12px',
            fontSize: 12.5, color: theme.textDim,
          }}
        >
          (Agent 层待接入：Claude Agent SDK + 52 工具 schema)
        </div>
      </div>

      <div style={{ padding: 12, borderTop: `1px solid ${theme.border}` }}>
        <div
          style={{
            background: theme.panelAlt, border: `1px solid ${theme.border}`,
            borderRadius: 10, padding: 10,
          }}
        >
          <div style={{ fontSize: 13, color: theme.textDim, marginBottom: 10 }}>告诉 AI 要做哪些修改 · @ 引用素材</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: theme.textDim, fontSize: 14 }}>
            <span>✦</span><span>⚙</span><span style={{ flex: 1 }} />
            <span>＋</span><span>◑</span><span>▤</span>
            <span
              style={{
                width: 26, height: 26, borderRadius: '50%', background: theme.accent,
                color: '#fff', display: 'grid', placeItems: 'center', fontSize: 13,
              }}
            >↑</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
