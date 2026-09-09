import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import type { CopilotSettingsController } from './useCopilotSettings';

type AccountState = 'loading' | 'missing' | 'unsupported' | 'signed-out' | 'pending' | 'expired' | 'signed-in' | 'error';

function accountState(controller: CopilotSettingsController): AccountState {
  const { status, auth } = controller;
  if (auth?.available && auth.status === 'pending' && auth.device) {
    return auth.device.expiresAt <= Date.now() ? 'expired' : 'pending';
  }
  if (controller.authError || (auth?.available && auth.status === 'error')) return 'error';
  if ((controller.loading || controller.authLoading) && !status) return 'loading';
  if (!status) return 'error';
  if (!status.installed) return 'missing';
  if (!status.supported) return 'unsupported';
  if (controller.error || status.error) return 'error';
  if (auth?.status === 'signed-in' || status.authenticated) return 'signed-in';
  return 'signed-out';
}

const DOT: Record<AccountState, string> = {
  loading: theme.textDim,
  missing: theme.danger,
  unsupported: theme.danger,
  'signed-out': theme.textDim,
  pending: theme.gold,
  expired: theme.danger,
  'signed-in': theme.accent,
  error: theme.danger,
};

export function CopilotAccountCard({ controller }: {
  controller: CopilotSettingsController;
}) {
  const t = useT();
  const state = accountState(controller);
  const status = controller.status;
  const auth = controller.auth;
  const appSignedIn = auth?.status === 'signed-in';
  const canSignOut = auth?.available && (appSignedIn || auth.status === 'error');
  const device = auth?.available && auth.status === 'pending' ? auth.device : null;
  const expired = !!device && device.expiresAt <= Date.now();
  const verificationUri = device?.verificationUri === 'https://github.com/login/device'
    ? device.verificationUri : null;
  const copy: Record<AccountState, readonly [string, string]> = {
    loading: [t('正在检查 Copilot CLI…'), t('正在读取本机 Copilot 运行时状态。')],
    missing: [
      t('未检测到 Copilot CLI'),
      auth?.available ? t('请更新或重新安装桌面应用，然后刷新状态。')
        : t('安装后重试：npm i -g @github/copilot（或 brew install copilot）。'),
    ],
    unsupported: [
      t('Copilot CLI 版本过低'),
      auth?.available ? t('请更新或重新安装桌面应用，然后刷新状态。')
        : t('在终端运行 copilot update 后重试。'),
    ],
    'signed-out': [
      t('尚未登录 Copilot'),
      auth?.available ? t('使用 GitHub 账号连接你的 Copilot 订阅。') : t('在终端运行 copilot login 完成登录后点击刷新。'),
    ],
    pending: [t('等待 GitHub 授权'), t('在 GitHub 页面输入设备代码，完成授权后此处会自动刷新。')],
    expired: [t('设备代码已过期，请重新登录。'), t('请刷新后重试。')],
    'signed-in': [
      t('已登录 GitHub Copilot'),
      appSignedIn ? t('已在此应用中连接 GitHub 账号。') : t('凭据与续期均由 Copilot CLI 管理。'),
    ],
    error: [t('无法连接 Copilot'), t('请刷新后重试。')],
  };
  const [title, detail] = copy[state];
  const authError = controller.authError ?? auth?.error;
  const runtimeError = controller.error ?? status?.error;
  return (
    <section style={card} aria-live="polite">
      <div style={summaryRow}>
        <span aria-hidden style={{ ...statusDot, background: DOT[state] }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={summaryTitle}>{title}</div>
          <div style={summaryDetail}>{detail}</div>
          {state === 'signed-in' && appSignedIn && auth.account && (
            <div style={metadata}>{t('账号')}: {auth.account.login}</div>
          )}
          {state === 'signed-in' && !appSignedIn && status?.account && (
            <div style={metadata}>
              {status.account.login && <span>{t('账号')}: {status.account.login}</span>}
              {status.account.authType && <span>{t('登录方式')}: {status.account.authType}</span>}
              {status.account.host && <span>{t('主机')}: {status.account.host}</span>}
            </div>
          )}
        </div>
        {status?.version && <span style={versionTag}>v{status.version}</span>}
      </div>
      {auth?.available && (
        <div style={summaryDetail}>{t('桌面版已内置 Copilot 运行时，无需安装 gh 或单独的 CLI。')}</div>
      )}
      {!auth?.available && state !== 'signed-out' && (
        <div style={summaryDetail}>{t('在终端运行 copilot login 完成登录后点击刷新。')}</div>
      )}
      {device && !expired && (
        <div style={deviceDetails}>
          <span style={summaryDetail}>{t('设备代码')}</span>
          <code tabIndex={0} aria-label={t('设备代码')} style={deviceCode}>{device.userCode}</code>
          <div style={summaryDetail}>
            {t('有效期至 {time}', { time: new Date(device.expiresAt).toLocaleTimeString() })}
          </div>
          {verificationUri ? (
            <a href={verificationUri} target="_blank" rel="noopener noreferrer" style={githubLink}>
              {t('打开 GitHub')}
            </a>
          ) : <div role="alert" style={errorText}>{t('Copilot 返回了无效的验证地址。')}</div>}
        </div>
      )}
      <div style={actions}>
        {auth?.available && !appSignedIn && (!device || expired) && (
          <button type="button" style={button} disabled={!!controller.authBusy}
            onClick={() => { void controller.startLogin(); }}>
            {controller.authBusy === 'start' ? t('正在启动…') : t('使用 GitHub 登录')}
          </button>
        )}
        {device && (
          <button type="button" style={button} disabled={!!controller.authBusy}
            onClick={() => { void controller.cancelLogin(); }}>
            {controller.authBusy === 'cancel' ? t('正在取消…') : t('取消登录')}
          </button>
        )}
        {canSignOut && (
          <button type="button" style={button} disabled={!!controller.authBusy}
            onClick={() => { void controller.logout(); }}>
            {controller.authBusy === 'logout' ? t('正在退出…') : t('退出此应用的登录')}
          </button>
        )}
        <button type="button" style={button}
          disabled={controller.loading || controller.authLoading || !!controller.authBusy}
          onClick={() => { void controller.refresh(); }}>
          {controller.loading || controller.authLoading ? t('刷新中…') : t('刷新状态')}
        </button>
        {!device && (status?.authenticated || appSignedIn) && (
          <button type="button" style={button} disabled={controller.modelBusy || !!controller.authBusy}
            onClick={() => { void controller.discoverModels(); }}>
            {controller.modelBusy ? t('读取中…') : t('读取模型')}
          </button>
        )}
      </div>
      {canSignOut && (
        <div style={summaryDetail}>{t('仅移除此应用的 OAuth 登录，不会撤销 GitHub 授权或退出其他应用。')}</div>
      )}
      {authError && <div role="alert" style={errorText}>{authError}</div>}
      {runtimeError && <div role="alert" style={errorText}>{runtimeError}</div>}
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
const deviceDetails: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5,
};
const deviceCode: React.CSSProperties = {
  color: theme.text, fontSize: 20, fontWeight: 600, letterSpacing: 2,
  userSelect: 'all', overflowWrap: 'anywhere',
};
const githubLink: React.CSSProperties = { color: theme.accent, fontSize: 11 };
const button: React.CSSProperties = {
  minHeight: 28, padding: '4px 9px', border: `0.5px solid ${theme.border}`, borderRadius: 4,
  font: 'inherit', fontSize: 10.5, fontWeight: 500,
};
const errorText: React.CSSProperties = {
  paddingTop: 7, borderTop: `0.5px solid ${theme.border}`, color: theme.danger,
  fontSize: 10.5, lineHeight: 1.45,
};
