import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import type { CopilotSettingsController } from './useCopilotSettings';

type AccountState = 'loading' | 'missing' | 'unsupported' | 'signed-out' | 'signed-in' | 'error';

function accountState(controller: CopilotSettingsController): AccountState {
  const { status } = controller;
  if (controller.loading && !status) return 'loading';
  if (!status) return 'error';
  if (!status.installed) return 'missing';
  if (!status.supported) return 'unsupported';
  if (status.authenticated) return 'signed-in';
  if (controller.error) return 'error';
  return 'signed-out';
}

const DOT: Record<AccountState, string> = {
  loading: theme.textDim,
  missing: theme.danger,
  unsupported: theme.danger,
  'signed-out': theme.textDim,
  'signed-in': theme.accent,
  error: theme.danger,
};

/**
 * Copilot credentials live in the CLI, so this card is read-only: it reports
 * install/auth state and points at the terminal command instead of offering an
 * in-app sign-in that OpenChatCut cannot own.
 */
export function CopilotAccountCard({ controller }: {
  controller: CopilotSettingsController;
}) {
  const t = useT();
  const state = accountState(controller);
  const status = controller.status;
  const copy: Record<AccountState, readonly [string, string]> = {
    loading: [t('正在检查 Copilot CLI…'), t('正在读取本机 Copilot 运行时状态。')],
    missing: [
      t('未检测到 Copilot CLI'),
      t('安装后重试：npm i -g @github/copilot（或 brew install copilot）。'),
    ],
    unsupported: [t('Copilot CLI 版本过低'), t('在终端运行 copilot update 后重试。')],
    'signed-out': [t('尚未登录 Copilot'), t('在终端运行 copilot login 完成登录后点击刷新。')],
    'signed-in': [t('已登录 GitHub Copilot'), t('凭据与续期均由 Copilot CLI 管理。')],
    error: [t('无法连接 Copilot'), t('请确认开发服务正在运行后重试。')],
  };
  const [title, detail] = copy[state];
  return (
    <section style={card} aria-live="polite">
      <div style={summaryRow}>
        <span style={{ ...statusDot, background: DOT[state] }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={summaryTitle}>{title}</div>
          <div style={summaryDetail}>{detail}</div>
          {state === 'signed-in' && status?.account && (
            <div style={metadata}>
              {status.account.login && <span>{t('账号')}: {status.account.login}</span>}
              {status.account.authType && <span>{t('登录方式')}: {status.account.authType}</span>}
              {status.account.host && <span>{t('主机')}: {status.account.host}</span>}
            </div>
          )}
        </div>
        {status?.version && <span style={versionTag}>v{status.version}</span>}
      </div>
      <div style={actions}>
        <button type="button" style={button} disabled={controller.loading}
          onClick={() => { void controller.refresh(); }}>
          {controller.loading ? t('刷新中…') : t('刷新状态')}
        </button>
        {state === 'signed-in' && (
          <button type="button" style={button} disabled={controller.modelBusy}
            onClick={() => { void controller.discoverModels(); }}>
            {controller.modelBusy ? t('读取中…') : t('读取模型')}
          </button>
        )}
      </div>
      {(controller.error ?? status?.error) && (
        <div role="alert" style={errorText}>{controller.error ?? status?.error}</div>
      )}
      {controller.modelError && <div role="alert" style={errorText}>{controller.modelError}</div>}
    </section>
  );
}

const card: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 10, padding: '11px 13px',
  background: theme.bg, border: `0.5px solid ${theme.border}`, borderRadius: 4,
};
const summaryRow: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 9 };
const statusDot: React.CSSProperties = {
  width: 8, height: 8, marginTop: 4, borderRadius: '50%', flex: '0 0 auto',
};
const summaryTitle: React.CSSProperties = {
  color: theme.text, fontSize: 12, fontWeight: 600, lineHeight: 1.35,
};
const summaryDetail: React.CSSProperties = {
  marginTop: 2, color: theme.textDim, fontSize: 10.5, lineHeight: 1.45,
};
const versionTag: React.CSSProperties = {
  flex: '0 0 auto', padding: '1px 5px', border: `0.5px solid ${theme.border}`,
  borderRadius: 4, color: theme.textDim, fontSize: 9.5,
};
const metadata: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '2px 9px', marginTop: 5, color: theme.textMuted,
  fontSize: 10.5, lineHeight: 1.35, overflowWrap: 'anywhere',
};
const actions: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6,
};
const button: React.CSSProperties = {
  minHeight: 28, padding: '4px 9px', border: `0.5px solid ${theme.border}`, borderRadius: 4,
  font: 'inherit', fontSize: 10.5, fontWeight: 500,
};
const errorText: React.CSSProperties = {
  paddingTop: 7, borderTop: `0.5px solid ${theme.border}`, color: theme.danger,
  fontSize: 10.5, lineHeight: 1.45,
};
