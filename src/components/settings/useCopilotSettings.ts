import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CopilotAgentModel, CopilotAgentStatus } from '../../../shared/copilot-agent';
import type { CopilotAuthState } from '../../../shared/copilot-auth';
import {
  cancelCopilotAuth, fetchCopilotAuth, fetchCopilotModels, fetchCopilotStatus,
  logoutCopilotAuth, startCopilotAuth,
} from '../../agent/copilot/client';
import { applyCopilotAgentStatus } from '../../agent/model-selection';
import { t } from '../../i18n/locale';

type AuthAction = 'start' | 'cancel' | 'logout';

export interface CopilotSettingsController {
  readonly status: CopilotAgentStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly auth: CopilotAuthState | null;
  readonly authLoading: boolean;
  readonly authBusy: AuthAction | null;
  readonly authError: string | null;
  readonly modelBusy: boolean;
  readonly modelError: string | null;
  readonly models: readonly CopilotAgentModel[];
  readonly refresh: () => Promise<CopilotAgentStatus | null>;
  readonly discoverModels: () => Promise<readonly CopilotAgentModel[]>;
  readonly startLogin: () => Promise<void>;
  readonly cancelLogin: () => Promise<void>;
  readonly logout: () => Promise<void>;
}

function accountKey(auth: CopilotAuthState | null): string | null {
  return auth?.status === 'signed-in' ? auth.account?.login ?? '' : null;
}

/** One enabled settings lifetime; request identity also guards fetches that ignore abort. */
export function createCopilotSettingsStore() {
  let active = false;
  let authRequest: AbortController | null = null;
  let runtimeRequest: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let discoverAfterLogin = false;
  const listeners = new Set<() => void>();
  let snapshot: CopilotSettingsController = {
    status: null, loading: true, error: null,
    auth: null, authLoading: false, authBusy: null, authError: null,
    models: [], modelBusy: false, modelError: null,
    refresh, discoverModels,
    startLogin: () => mutateAuth('start'),
    cancelLogin: () => mutateAuth('cancel'),
    logout: () => mutateAuth('logout'),
  };

  function update(patch: Partial<CopilotSettingsController>): void {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  }

  function stopPolling(): void {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function invalidateRuntime(): void {
    runtimeRequest?.abort();
    runtimeRequest = null;
  }

  function forgetModels(): void {
    discoverAfterLogin = false;
    const status = snapshot.status && { ...snapshot.status, authenticated: false, account: null, error: undefined };
    update({ models: [], modelError: null, status });
    applyCopilotAgentStatus(status ?? {
      installed: false, supported: false, authenticated: false,
      version: null, path: null, account: null,
    }, undefined, undefined, []);
  }

  async function syncRuntime(discover = false): Promise<CopilotAgentStatus | null> {
    if (!active) return null;
    invalidateRuntime();
    const request = new AbortController();
    runtimeRequest = request;
    discover ||= discoverAfterLogin;
    update({ loading: true, error: null, modelBusy: discover, ...(discover ? { modelError: null } : {}) });
    const [status, response] = await Promise.all([
      fetchCopilotStatus(request.signal).catch(() => null),
      discover ? fetchCopilotModels(request.signal).catch(() => ({
        models: [],
        error: t('无法读取 Copilot 模型列表，请稍后重试。'),
      })) : null,
    ]);
    if (!active || runtimeRequest !== request) return null;
    runtimeRequest = null;
    const models = status && !status.authenticated ? [] : response?.models ?? snapshot.models;
    update({
      status: status ?? snapshot.status,
      loading: false,
      error: status ? null : t('无法连接 Copilot 服务，请确认开发服务正在运行。'),
      models, modelBusy: false,
      ...(response ? { modelError: response.error ?? null } : {}),
    });
    if (status) {
      if (response && !response.error && status.authenticated) discoverAfterLogin = false;
      applyCopilotAgentStatus(status, undefined, undefined, discover || !status.authenticated ? models : undefined);
    }
    return status;
  }

  function acceptAuth(auth: CopilotAuthState): boolean {
    const previous = accountKey(snapshot.auth);
    const next = accountKey(auth);
    const changed = previous !== next;
    if (changed) {
      invalidateRuntime();
      forgetModels();
      discoverAfterLogin = next !== null;
    }
    update({ auth, authError: null, authLoading: false, authBusy: null });
    return changed;
  }

  function schedulePoll(): void {
    stopPolling();
    const device = snapshot.auth?.status === 'pending' && snapshot.auth.available
      ? snapshot.auth.device : null;
    if (!active || snapshot.authBusy || !device) return;
    const remaining = device.expiresAt - Date.now();
    if (remaining <= 0) {
      update({ authError: snapshot.authError ?? t('设备代码已过期，请重新登录。') });
      return;
    }
    const interval = Number.isFinite(device.intervalMs) ? device.intervalMs : 5_000;
    const delay = Math.max(1_000, Math.min(30_000, interval, remaining));
    pollTimer = setTimeout(() => { void readAuth(); }, delay);
  }

  async function readAuth(): Promise<void> {
    if (!active || snapshot.authBusy) return;
    stopPolling();
    authRequest?.abort();
    const request = new AbortController();
    authRequest = request;
    update({ authLoading: true });
    try {
      const auth = await fetchCopilotAuth(request.signal);
      if (!active || authRequest !== request) return;
      authRequest = null;
      const changed = acceptAuth(auth);
      schedulePoll();
      if (changed) await syncRuntime();
    } catch (error) {
      if (!active || authRequest !== request) return;
      authRequest = null;
      update({
        authLoading: false,
        authError: error instanceof Error ? error.message : t('无法读取 Copilot 登录状态，请刷新后重试。'),
      });
      schedulePoll();
    }
  }

  async function refresh(): Promise<CopilotAgentStatus | null> {
    if (!active || snapshot.authBusy) return null;
    await Promise.all([syncRuntime(), readAuth()]);
    return active ? snapshot.status : null;
  }

  async function discoverModels(): Promise<readonly CopilotAgentModel[]> {
    if (!active || snapshot.authBusy) return [];
    const status = await syncRuntime(true);
    return status ? snapshot.models : [];
  }

  async function mutateAuth(action: AuthAction): Promise<void> {
    if (!active || snapshot.authBusy || !snapshot.auth?.available) return;
    const device = snapshot.auth.device;
    if (action === 'cancel' && !device) return;
    stopPolling();
    authRequest?.abort();
    invalidateRuntime();
    const request = new AbortController();
    authRequest = request;
    update({ authBusy: action, authLoading: false, authError: null, loading: false, modelBusy: false });
    try {
      const auth = await (action === 'start' ? startCopilotAuth(request.signal)
        : action === 'cancel' ? cancelCopilotAuth(device!.id, request.signal)
          : logoutCopilotAuth(request.signal));
      if (!active || authRequest !== request) return;
      authRequest = null;
      acceptAuth(auth);
      if (action === 'logout' && auth.status !== 'signed-in') forgetModels();
      schedulePoll();
      await syncRuntime();
    } catch (error) {
      if (!active || authRequest !== request) return;
      authRequest = null;
      update({
        authBusy: null,
        authError: error instanceof Error ? error.message : t('无法更新 Copilot 登录状态，请稍后重试。'),
      });
      schedulePoll();
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activate: () => {
      active = true;
      void refresh();
      return () => {
        active = false;
        stopPolling();
        authRequest?.abort();
        authRequest = null;
        invalidateRuntime();
        update({ loading: false, authLoading: false, authBusy: null, modelBusy: false });
      };
    },
  };
}

export function useCopilotSettings(enabled: boolean): CopilotSettingsController {
  const [store] = useState(createCopilotSettingsStore);
  const controller = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (enabled) return store.activate();
  }, [enabled, store]);
  return controller;
}
