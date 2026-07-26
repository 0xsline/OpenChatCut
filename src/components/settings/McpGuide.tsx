// 外部 Agent 接入指南(MCP 可发现性,TODO F12):展示当前实际端点 + 各客户端
// 接入命令,一键复制。端点取 window.location.origin —— 网页版/桌面版(含 5199
// 被占回退随机端口)都自动正确。纯展示组件,不触任何服务端状态。
import { useState } from 'react';
import { theme } from '../../theme';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';

interface Snippet {
  label: string;
  code: string;
}

function snippets(endpoint: string): Snippet[] {
  return [
    { label: 'Claude Code', code: `claude mcp add --transport http openchatcut ${endpoint}` },
    { label: 'Codex', code: `codex mcp add openchatcut --url ${endpoint}` },
    {
      label: 'Cursor (~/.cursor/mcp.json)',
      code: JSON.stringify({ mcpServers: { openchatcut: { type: 'http', url: endpoint } } }, null, 2),
    },
  ];
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      style={{
        flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', border: `0.5px solid ${theme.border}`, borderRadius: 4,
        background: theme.hover, color: copied ? theme.accent : theme.textMuted,
        fontSize: 11, cursor: 'pointer',
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={11} />
      {copied ? t('已复制') : t('复制到剪贴板')}
    </button>
  );
}

export function McpGuideDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const endpoint = `${window.location.origin}/api/external-mcp/mcp`;
  const codeStyle: React.CSSProperties = {
    margin: 0, padding: '7px 9px', border: `0.5px solid ${theme.borderLight}`, borderRadius: 4,
    background: theme.inset, color: theme.text, fontSize: 11.5, lineHeight: 1.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'text',
  };
  return (
    <div className="cc-modal-backdrop" onPointerDown={onClose}>
      <div
        className="cc-modal"
        style={{ width: 560, gap: 10, maxHeight: 'calc(100vh - 64px)', overflowY: 'auto' }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start' }}>
          <Icon name="plug" size={15} />
          <strong style={{ fontSize: 14 }}>{t('外部 Agent 接入 (MCP)')}</strong>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', padding: '3px 9px' }}>{t('关闭')}</button>
        </div>
        <div style={{ color: theme.textMuted, fontSize: 12, lineHeight: 1.55 }}>
          {t('OpenChatCut 暴露一个 Streamable HTTP MCP 端点。Claude Code / Codex / Cursor 等外部 Agent 接入后,与内置 Agent 共用同一套编辑工具,可直接读写当前工程。')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start' }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{t('端点地址')}</span>
            <CopyButton text={endpoint} />
          </div>
          <pre style={codeStyle}>{endpoint}</pre>
        </div>

        {snippets(endpoint).map((snippet) => (
          <div key={snippet.label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start' }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{snippet.label}</span>
              <CopyButton text={snippet.code} />
            </div>
            <pre style={codeStyle}>{snippet.code}</pre>
          </div>
        ))}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Claude Desktop</span>
          <div style={{ color: theme.textMuted, fontSize: 12, lineHeight: 1.55 }}>
            {t('设置 → 连接器 → 添加自定义连接器,粘贴上面的端点地址即可。')}
          </div>
        </div>

        <div style={{ color: theme.textDim, fontSize: 11.5, lineHeight: 1.55, borderTop: `0.5px solid ${theme.borderLight}`, paddingTop: 8 }}>
          {t('端点默认仅监听本机;对外暴露时请配置 OPENCHATCUT_MCP_TOKEN 鉴权。桌面端 5199 端口被占用时会回退随机端口,以启动日志与本页地址为准。')}
        </div>
      </div>
    </div>
  );
}
