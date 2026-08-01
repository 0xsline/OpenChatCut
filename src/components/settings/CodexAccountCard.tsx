import {
  useEffect, useRef, useState, type ReactNode,
} from 'react';
import type {
  CodexAgentStatus, CodexLoginStartResponse,
} from '../../../shared/codex-agent';
import { useT } from '../../i18n/locale';
import { theme, themeAlpha } from '../../theme';
import { Icon } from '../icons';
import {
  safeHttpsUrl, type CodexSettingsController,
} from './useCodexSettings';

const COPY_FEEDBACK_MS = 1_600;

type AccountState = 'loading' | 'missing' | 'signed-out' | 'pending' | 'signed-in' | 'api-key' | 'error';

function accountState(controller: CodexSettingsController): AccountState {
  const { status } = controller;
  if (controller.loading && !status) return 'loading';
  if (!status) return 'error';
  if (!status.installed) return 'missing';
  if (status.loginPending || controller.login) return 'pending';
  if (status.account?.type === 'apiKey') return 'api-key';
  if (status.account) return 'signed-in';
  if (status.error || controller.error) return 'error';
  return 'signed-out';
}

export function CodexAccountCard({ controller, onModelsDiscovered }: {
  controller: CodexSettingsController;
  onModelsDiscovered: (models: readonly string[]) => void;
}) {
  const state = accountState(controller);
  const loadModels = async (): Promise<void> => {
    const models = await controller.discoverModels();
    if (models.length > 0) onModelsDiscovered(models);
  };
  return (
    <section style={card} aria-live="polite">
      <StatusSummary state={state} controller={controller} />
      {state === 'pending' && <LoginDetails login={controller.login} />}
      <ActionRow state={state} controller={controller} onLoadModels={() => { void loadModels(); }} />
      {state !== 'error' && (controller.error ?? controller.status?.error) && (
        <div role="alert" style={errorText}>{controller.error ?? controller.status?.error}</div>
      )}
      {state === 'signed-in' && controller.modelError && <div role="alert" style={errorText}>{controller.modelError}</div>}
    </section>
  );
}

function StatusSummary({ state, controller }: {
  state: AccountState; controller: CodexSettingsController;
}) {
  const t = useT();
  const status = controller.status;
  const signedInDetail = t('凭据与续期均由 Codex CLI 管理。');
  const copy: Record<AccountState, readonly [string, string]> = {
    loading: [t('正在检查 Codex CLI…'), t('正在读取本机 Codex 运行时状态。')],
    missing: [t('未检测到 Codex CLI'), t('请先安装 OpenAI Codex CLI，然后刷新状态。')],
    'signed-out': [t('尚未登录 ChatGPT'), t('通过 Codex 官方登录流程连接 ChatGPT 订阅。')],
    pending: [t('等待 ChatGPT 授权'), t('请在登录页面完成授权，完成后会自动刷新。')],
    'signed-in': [t('已登录 ChatGPT'), signedInDetail],
    'api-key': [
      t('Codex CLI 正在使用 API Key'),
      t('此页面仅启用 ChatGPT 订阅；API Key 请使用 OpenAI 厂商页。'),
    ],
    error: [t('Codex 暂时不可用'), controller.error ?? status?.error ?? t('请刷新后重试。')],
  };
  const [title, detail] = copy[state];
  const tone = state === 'signed-in' ? theme.success
    : state === 'pending' || state === 'api-key' ? theme.gold
      : state === 'error' || state === 'missing' ? theme.danger : theme.borderLight;
  return (
    <div style={summaryRow}>
      <span aria-hidden style={{ ...statusDot, background: tone }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={summaryTitle}>{title}</div>
        <div style={summaryDetail}>{detail}</div>
        {(state === 'signed-in' || state === 'api-key') && status?.account && <AccountMetadata status={status} />}
      </div>
      {status?.installed && status.version && <span style={versionTag}>{t('Codex CLI {version}', { version: status.version })}</span>}
    </div>
  );
}

function AccountMetadata({ status }: { status: CodexAgentStatus }) {
  const t = useT();
  const account = status.account;
  if (!account) return null;
  return (
    <div style={metadata}>
      {account.email && <span title={account.email}>{account.email}</span>}
      {account.planType && <span>{t('套餐：{plan}', { plan: account.planType })}</span>}
    </div>
  );
}

function LoginDetails({ login }: { login: CodexLoginStartResponse | null }) {
  const t = useT();
  if (!login) return <div style={pendingNote}>{t('请在先前打开的 Codex 登录窗口中完成授权。')}</div>;
  if (login.type === 'chatgpt') {
    const authUrl = safeHttpsUrl(login.authUrl);
    return authUrl
      ? <ValueRow label={t('登录地址')} value={authUrl} href={authUrl} />
      : <div role="alert" style={errorText}>{t('Codex 返回了无效的登录地址。')}</div>;
  }
  const verificationUrl = safeHttpsUrl(login.verificationUrl);
  if (!verificationUrl) {
    return <div role="alert" style={errorText}>{t('Codex 返回了无效的验证地址。')}</div>;
  }
  return (
    <div style={loginDetails}>
      <ValueRow label={t('验证地址')} value={verificationUrl} href={verificationUrl} />
      <ValueRow label={t('设备代码')} value={login.userCode} prominent />
    </div>
  );
}

function ValueRow({ label, value, href, prominent = false }: {
  label: string; value: string; href?: string; prominent?: boolean;
}) {
  return (
    <div style={valueRow}>
      <span style={valueLabel}>{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" style={valueLink} title={value}>
          <code style={valueCode}>{value}</code>
        </a>
      ) : <code tabIndex={0} style={{ ...valueCode, ...(prominent ? prominentCode : {}) }}>{value}</code>}
      <CopyButton value={value} />
    </div>
  );
}

function ActionRow({ state, controller, onLoadModels }: {
  state: AccountState; controller: CodexSettingsController; onLoadModels: () => void;
}) {
  const t = useT();
  const busy = controller.loginBusy || controller.logoutBusy || controller.loading || controller.modelBusy;
  if (state === 'loading' || state === 'missing' || state === 'error') {
    return <div style={actions}><ActionButton disabled={busy} onClick={() => { void controller.refresh(); }}>{controller.loading ? t('刷新中…') : t('刷新状态')}</ActionButton></div>;
  }
  if (state === 'signed-in') {
    return (
      <div style={actions}>
        <ActionButton primary disabled={busy} onClick={onLoadModels}>{controller.modelBusy ? t('读取中…') : t('读取模型')}</ActionButton>
        <ActionButton disabled={busy} onClick={() => { void controller.refresh(); }}>{controller.loading ? t('刷新中…') : t('刷新状态')}</ActionButton>
        <ActionButton danger disabled={busy} onClick={() => { void controller.logout(); }}>{controller.logoutBusy ? t('正在退出…') : t('退出登录')}</ActionButton>
      </div>
    );
  }
  if (state === 'api-key') {
    return (
      <div style={actions}>
        <ActionButton disabled={busy} onClick={() => { void controller.refresh(); }}>{controller.loading ? t('刷新中…') : t('刷新状态')}</ActionButton>
        <ActionButton danger disabled={busy} onClick={() => { void controller.logout(); }}>{controller.logoutBusy ? t('正在退出…') : t('退出登录')}</ActionButton>
      </div>
    );
  }
  if (state === 'pending') {
    return (
      <div style={actions}>
        <ActionButton danger disabled={busy} onClick={() => { void controller.cancelLogin(); }}>{t('取消登录')}</ActionButton>
        <ActionButton disabled={busy} onClick={() => { void controller.refresh(); }}>{controller.loading ? t('刷新中…') : t('刷新状态')}</ActionButton>
      </div>
    );
  }
  return (
    <div style={actions}>
      <ActionButton primary disabled={busy} onClick={() => { void controller.startLogin('chatgpt'); }}>{controller.loginBusy ? t('正在启动…') : t('浏览器登录')}</ActionButton>
      <ActionButton disabled={busy} onClick={() => { void controller.startLogin('chatgptDeviceCode'); }}>{t('使用设备代码')}</ActionButton>
      <ActionButton disabled={busy} onClick={() => { void controller.refresh(); }}>{controller.loading ? t('刷新中…') : t('刷新状态')}</ActionButton>
    </div>
  );
}

function ActionButton({ children, onClick, disabled = false, primary = false, danger = false }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; danger?: boolean;
}) {
  const color = danger ? theme.danger : primary ? theme.onAccent : theme.text;
  const background = primary ? theme.accent : 'transparent';
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ ...button, color, background, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}>
      {children}
    </button>
  );
}

function CopyButton({ value }: { value: string }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), COPY_FEEDBACK_MS);
  };
  const label = state === 'copied' ? t('已复制') : state === 'failed' ? t('复制失败') : t('复制');
  return (
    <button type="button" onClick={() => { void copy(); }} title={label} aria-label={label} style={copyButton}>
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={11} />
      {label}
    </button>
  );
}

const card: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 10, padding: '11px 13px',
  background: theme.bg, border: `0.5px solid ${theme.border}`, borderRadius: 4,
};
const summaryRow: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 9 };
const statusDot: React.CSSProperties = { width: 8, height: 8, marginTop: 4, borderRadius: '50%', flex: '0 0 auto' };
const summaryTitle: React.CSSProperties = { color: theme.text, fontSize: 12, fontWeight: 600, lineHeight: 1.35 };
const summaryDetail: React.CSSProperties = { marginTop: 2, color: theme.textDim, fontSize: 10.5, lineHeight: 1.45 };
const versionTag: React.CSSProperties = {
  flex: '0 0 auto', padding: '1px 5px', border: `0.5px solid ${theme.border}`,
  borderRadius: 4, color: theme.textDim, fontSize: 9.5,
};
const metadata: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '2px 9px', marginTop: 5, color: theme.textMuted,
  fontSize: 10.5, lineHeight: 1.35, overflowWrap: 'anywhere',
};
const pendingNote: React.CSSProperties = { color: theme.textDim, fontSize: 10.5, lineHeight: 1.45 };
const loginDetails: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const valueRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 };
const valueLabel: React.CSSProperties = { width: 52, flex: '0 0 52px', color: theme.textDim, fontSize: 10.5 };
const valueLink: React.CSSProperties = { minWidth: 0, flex: 1, color: theme.accent, textDecoration: 'underline' };
const valueCode: React.CSSProperties = {
  display: 'block', minWidth: 0, overflow: 'hidden', color: 'inherit', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10.5, lineHeight: 1.45, textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'all',
};
const prominentCode: React.CSSProperties = { color: theme.textStrong, fontSize: 14, fontWeight: 700, letterSpacing: '0.08em' };
const actions: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 };
const button: React.CSSProperties = {
  minHeight: 28, padding: '4px 9px', border: `0.5px solid ${theme.border}`, borderRadius: 4,
  font: 'inherit', fontSize: 10.5, fontWeight: 500,
};
const copyButton: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto', minHeight: 24,
  padding: '2px 6px', border: `0.5px solid ${theme.border}`, borderRadius: 4,
  background: themeAlpha.ink(0.04), color: theme.textMuted, cursor: 'pointer', fontSize: 10,
};
const errorText: React.CSSProperties = {
  paddingTop: 7, borderTop: `0.5px solid ${theme.border}`, color: theme.danger,
  fontSize: 10.5, lineHeight: 1.45,
};
