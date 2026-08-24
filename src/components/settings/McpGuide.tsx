// Trusted editor guide for the authenticated Streamable HTTP endpoint.
// Clients connect through the one-click server-side writer; no copy-paste.
import { useEffect, useState, type ReactElement } from 'react';
import { editorBootstrapInfo } from '../../agent/editor-credential';
import { theme, themeAlpha } from '../../theme';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';
import claudeSvg from '../../../assets/vendor-icons/claude-color.svg?raw';
import codexPng from '../../../assets/vendor-icons/codex-color.png';
import cursorPng from '../../../assets/vendor-icons/cursor-color.png';
import antigravityPng from '../../../assets/vendor-icons/antigravity-color.png';

interface ClientSnippet {
  client: 'claude' | 'codex' | 'cursor' | 'antigravity';
  logo: ReactElement;
  name: string;
  desc: string;
}

function clientSnippets(): ClientSnippet[] {
  return [
    {
      client: 'claude',
      logo: <span aria-hidden className="cc-vendor-icon" style={{ color: '#d97757', width: 26, height: 26, fontSize: 26, display: 'inline-flex' }} dangerouslySetInnerHTML={{ __html: claudeSvg }} />,
      name: 'Claude Code',
      desc: 'Anthropic 官方 CLI，Claude 订阅用户直连。',
    },
    {
      client: 'codex',
      logo: <ClientLogo src={codexPng} alt="Codex" />,
      name: 'Codex',
      desc: 'OpenAI CLI，通过环境变量携带令牌。',
    },
    {
      client: 'cursor',
      logo: <ClientLogo src={cursorPng} alt="Cursor" />,
      name: 'Cursor',
      desc: '写入 ~/.cursor/mcp.json 的全局配置。',
    },
    {
      client: 'antigravity',
      logo: <ClientLogo src={antigravityPng} alt="Antigravity" />,
      name: 'Antigravity',
      desc: '写入 ~/.gemini/antigravity/mcp_config.json。',
    },
  ];
}

function ClientLogo({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      aria-hidden
      style={{ width: 26, height: 26, borderRadius: 6, objectFit: 'contain', flex: '0 0 auto', background: theme.panel, border: `0.5px solid ${theme.borderLight}` }}
    />
  );
}

function connectErrorMessage(t: ReturnType<typeof useT>, error: string): string {
  if (error === 'config-parse-error') return t('目标配置文件不是有效 JSON，为避免覆盖未写入。');
  if (error === 'config-write-error') return t('写入配置文件失败。');
  if (error === 'codex-cli-failed') return t('执行 codex mcp add 失败。');
  return t('连接失败');
}

function ConnectButton({ client, onStatus }: { client: ClientSnippet['client']; onStatus: (message: string, ok: boolean) => void }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const busy = state === 'busy';
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setState('busy');
        onStatus('', true);
        void fetch('/api/external-agent/connect-client', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client }),
        })
          .then(async (response) => {
            const data: unknown = await response.json().catch(() => null);
            const result = data as { ok?: boolean; paths?: string[]; error?: string } | null;
            if (response.ok && result?.ok) {
              setState('done');
              onStatus(t('已写入 {paths}', { paths: (result.paths ?? []).join('、') }), true);
              setTimeout(() => setState('idle'), 2500);
            } else {
              setState('error');
              onStatus(connectErrorMessage(t, result?.error ?? ''), false);
            }
          })
          .catch(() => {
            setState('error');
            onStatus(connectErrorMessage(t, ''), false);
          });
      }}
      style={{
        flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '4px 10px', border: '0.5px solid transparent', borderRadius: 5,
        background: state === 'error' ? theme.hover : `linear-gradient(135deg, ${theme.accent}, ${theme.accentDeep})`,
        boxShadow: state === 'error' ? 'none' : themeAlpha.shadow(0.25),
        color: state === 'error' ? theme.danger : theme.onAccent,
        fontSize: 11, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.7 : 1,
      }}
    >
      <Icon name={state === 'done' ? 'check' : 'plug'} size={11} />
      {busy ? t('连接中…') : state === 'done' ? t('已连接') : state === 'error' ? t('连接失败') : t('连接')}
    </button>
  );
}

const cardStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  background: theme.panelAlt, border: `0.5px solid ${theme.borderLight}`,
  borderRadius: 8, padding: '10px 12px',
};

const endpointStyle: React.CSSProperties = {
  margin: 0, padding: '6px 9px', border: `0.5px solid ${theme.borderLight}`, borderRadius: 4,
  background: theme.inset, color: theme.textMuted, fontSize: 11.5, lineHeight: 1.5,
  fontFamily: 'Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'nowrap', overflowX: 'auto', userSelect: 'text',
};

export function McpGuideDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const endpoint = `${window.location.origin}/api/external-mcp/mcp`;
  const [mcpToken, setMcpToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState(false);
  const [connectStatus, setConnectStatus] = useState<Record<string, { message: string; ok: boolean }>>({});
  useEffect(() => {
    let active = true;
    void editorBootstrapInfo().then(
      (info) => { if (active) setMcpToken(info.mcpToken); },
      () => { if (active) setTokenError(true); },
    );
    return () => { active = false; };
  }, []);
  return (
    <div className="cc-modal-backdrop" onPointerDown={onClose}>
      <div
        className="cc-modal"
        style={{ width: 600, gap: 12, maxHeight: 'calc(100vh - 64px)', overflowY: 'auto' }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            aria-hidden
            style={{
              width: 36, height: 36, borderRadius: 10, flex: '0 0 auto',
              background: `linear-gradient(135deg, ${theme.accent}, ${theme.accentDeep})`,
              boxShadow: themeAlpha.shadow(0.35),
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: theme.onAccent,
            }}
          >
            <Icon name="plug" size={18} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <strong style={{ fontSize: 14 }}>{t('外部 Agent 接入 (MCP)')}</strong>
            <span style={{ color: theme.textMuted, fontSize: 11.5 }}>
              {t('Streamable HTTP · 与内置 Agent 共享编辑工具')}
            </span>
          </div>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', padding: '3px 9px' }}>{t('关闭')}</button>
        </div>

        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{t('端点地址')}</span>
            <span style={{ color: theme.textMuted, fontSize: 11.5 }}>{t('所有客户端共用一个端点')}</span>
          </div>
          <pre style={endpointStyle}>{endpoint}</pre>
        </div>

        {mcpToken ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {clientSnippets().map((snippet) => (
              <div key={snippet.name} style={cardStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {snippet.logo}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{snippet.name}</span>
                    <span style={{ color: theme.textMuted, fontSize: 11.5 }}>{t(snippet.desc)}</span>
                  </div>
                  <div style={{ marginLeft: 'auto' }}>
                    <ConnectButton
                      client={snippet.client}
                      onStatus={(message, ok) => setConnectStatus((prev) => ({ ...prev, [snippet.client]: { message, ok } }))}
                    />
                  </div>
                </div>
                {connectStatus[snippet.client]?.message ? (
                  <div style={{ color: connectStatus[snippet.client].ok ? theme.accent : theme.danger, fontSize: 11 }}>
                    {connectStatus[snippet.client].message}
                  </div>
                ) : null}
              </div>
            ))}
            <div style={{ color: theme.textDim, fontSize: 11 }}>
              {t('连接后重启对应客户端生效；Codex 需新开终端使环境变量生效。')}
            </div>
          </div>
        ) : (
          <div style={{ color: tokenError ? theme.danger : theme.textMuted, fontSize: 12 }}>
            {tokenError ? t('无法读取 MCP 连接令牌，请从受信任的编辑器窗口重试。') : t('正在读取 MCP 连接令牌…')}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={cardStyle}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{t('内置 Agent 与外部 MCP')}</span>
            <div style={{ color: theme.textMuted, fontSize: 12, lineHeight: 1.55 }}>
              {t('内置 Agent 会先生成可预览的修改提案，由你应用或拒绝；外部 MCP 使用独立编辑会话，manual 模式等待审核，auto 模式在 review 时直接应用。两者都只通过 EditorCore 命令修改工程。')}
            </div>
          </div>
          <div style={cardStyle}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{t('连接本地模型')}</span>
            <div style={{ color: theme.textMuted, fontSize: 12, lineHeight: 1.55 }}>
              {t('打开 设置 → Agent 模型 → Agent 大脑 → OpenAI，填写本地或兼容服务的 API URL 和模型；按服务选择 Responses API 或 Chat Completions API，再点“测试并读取模型”。仅在服务要求时填写 API Key。')}
            </div>
          </div>
        </div>

        <div style={{ color: theme.textDim, fontSize: 11.5, lineHeight: 1.55, borderTop: `0.5px solid ${theme.borderLight}`, paddingTop: 8 }}>
          {t('MCP 端点始终要求 Bearer 令牌。令牌在首次启动时生成并保存在本机，重启后保持不变，配置一次即可持续使用；OPENCHATCUT_MCP_TOKEN 环境变量可覆盖。令牌只在当前受信任编辑器会话中显示，不写入工程、聊天或浏览器存储。')}
        </div>
      </div>
    </div>
  );
}
