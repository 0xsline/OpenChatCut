import {
  useCallback, useEffect, useRef, useState, type RefObject,
} from 'react';
import type {
  CodexAgentStatus, CodexLoginMode, CodexLoginStartResponse,
} from '../../../shared/codex-agent';
import {
  cancelCodexLogin, fetchCodexModels, fetchCodexStatus, logoutCodex, startCodexLogin,
} from '../../agent/codex/client';
import { applyCodexAgentStatus } from '../../agent/model-selection';
import { t } from '../../i18n/locale';

const LOGIN_POLL_MS = 1_500;

interface RemoteStatusState {
  readonly status: CodexAgentStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
}

interface RemoteStatusControl {
  readonly state: RemoteStatusState;
  readonly refresh: (silent?: boolean) => Promise<CodexAgentStatus | null>;
}

export interface CodexSettingsController {
  readonly status: CodexAgentStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly login: CodexLoginStartResponse | null;
  readonly loginBusy: boolean;
  readonly logoutBusy: boolean;
  readonly modelBusy: boolean;
  readonly modelError: string | null;
  readonly refresh: () => Promise<CodexAgentStatus | null>;
  readonly startLogin: (mode: CodexLoginMode) => Promise<void>;
  readonly cancelLogin: () => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly discoverModels: () => Promise<readonly string[]>;
}

export function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function useMountedRef(): RefObject<boolean> {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

function useCodexStatusControl(savedModel?: string): RemoteStatusControl {
  const mounted = useMountedRef();
  const [state, setState] = useState<RemoteStatusState>({ status: null, loading: true, error: null });
  const refresh = useCallback(async (silent = false): Promise<CodexAgentStatus | null> => {
    if (!silent) setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const status = await fetchCodexStatus();
      if (mounted.current) setState({ status, loading: false, error: null });
      return status;
    } catch {
      if (mounted.current) {
        setState((current) => ({
          ...current, loading: false, error: t('无法连接 Codex 服务，请确认开发服务正在运行。'),
        }));
      }
      return null;
    }
  }, [mounted]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (state.status) applyCodexAgentStatus(state.status, savedModel);
  }, [savedModel, state.status]);
  return { state, refresh };
}

function usePendingLogin(remote: RemoteStatusControl) {
  const refresh = remote.refresh;
  const mounted = useMountedRef();
  const [login, setLogin] = useState<CodexLoginStartResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startLogin = useCallback(async (mode: CodexLoginMode): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const started = await startCodexLogin(mode);
      if (!mounted.current) return;
      setLogin(started);
      if (started.type === 'chatgpt') {
        const authUrl = safeHttpsUrl(started.authUrl);
        if (authUrl) window.open(authUrl, '_blank', 'noopener,noreferrer');
      }
    } catch {
      if (mounted.current) setError(t('无法启动登录，请稍后重试。'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [mounted]);
  const cancelLogin = useCallback(async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await cancelCodexLogin(login?.loginId);
      if (mounted.current) setLogin(null);
      await refresh(true);
    } catch {
      if (mounted.current) setError(t('无法取消登录，请稍后重试。'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [login, mounted, refresh]);
  useEffect(() => {
    if (!login && !remote.state.status?.loginPending) return;
    const timer = window.setInterval(() => {
      void refresh(true).then((status) => {
        if (mounted.current && status && !status.loginPending) setLogin(null);
      });
    }, LOGIN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [login, mounted, refresh, remote.state.status?.loginPending]);
  useEffect(() => setError(null), [remote.state.status]);
  return { login, busy, error, startLogin, cancelLogin };
}

function useCodexLogout(remote: RemoteStatusControl) {
  const refresh = remote.refresh;
  const mounted = useMountedRef();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logout = useCallback(async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await logoutCodex();
      await refresh(true);
    } catch {
      if (mounted.current) setError(t('无法退出登录，请稍后重试。'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [mounted, refresh]);
  useEffect(() => setError(null), [remote.state.status]);
  return { busy, error, logout };
}

function useCodexModels() {
  const mounted = useMountedRef();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discoverModels = useCallback(async (): Promise<readonly string[]> => {
    setBusy(true); setError(null);
    try {
      const response = await fetchCodexModels();
      if (response.error) {
        if (mounted.current) setError(t('读取模型失败：{message}', { message: response.error }));
        return [];
      }
      return response.models.map((model) => model.id);
    } catch {
      if (mounted.current) setError(t('无法读取 Codex 模型，请稍后重试。'));
      return [];
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [mounted]);
  return { busy, error, discoverModels };
}

export function useCodexSettings(savedModel?: string): CodexSettingsController {
  const remote = useCodexStatusControl(savedModel);
  const login = usePendingLogin(remote);
  const logout = useCodexLogout(remote);
  const models = useCodexModels();
  return {
    status: remote.state.status,
    loading: remote.state.loading,
    error: login.error ?? logout.error ?? remote.state.error,
    login: login.login,
    loginBusy: login.busy,
    logoutBusy: logout.busy,
    modelBusy: models.busy,
    modelError: models.error,
    refresh: remote.refresh,
    startLogin: login.startLogin,
    cancelLogin: login.cancelLogin,
    logout: logout.logout,
    discoverModels: models.discoverModels,
  };
}
