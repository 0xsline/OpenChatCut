import {
  useCallback, useEffect, useRef, useState, type RefObject,
} from 'react';
import type { ClaudeCodeAgentModel, ClaudeCodeAgentStatus } from '../../../shared/claude-code-agent';
import { fetchClaudeCodeModels, fetchClaudeCodeStatus } from '../../agent/claude-code/client';
import { applyClaudeCodeAgentStatus } from '../../agent/model-selection';
import { t } from '../../i18n/locale';

interface RemoteStatusState {
  readonly status: ClaudeCodeAgentStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
}

interface RemoteStatusControl {
  readonly state: RemoteStatusState;
  readonly refresh: (silent?: boolean) => Promise<ClaudeCodeAgentStatus | null>;
}

export interface ClaudeCodeSettingsController {
  readonly status: ClaudeCodeAgentStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly modelBusy: boolean;
  readonly modelError: string | null;
  readonly models: readonly ClaudeCodeAgentModel[];
  readonly refresh: () => Promise<ClaudeCodeAgentStatus | null>;
  readonly discoverModels: () => Promise<readonly ClaudeCodeAgentModel[]>;
}

function useMountedRef(): RefObject<boolean> {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

function useClaudeCodeStatusControl(): RemoteStatusControl {
  const mounted = useMountedRef();
  const [state, setState] = useState<RemoteStatusState>({ status: null, loading: true, error: null });
  const refresh = useCallback(async (silent = false): Promise<ClaudeCodeAgentStatus | null> => {
    if (!silent) setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const status = await fetchClaudeCodeStatus();
      if (mounted.current) setState({ status, loading: false, error: null });
      return status;
    } catch {
      if (mounted.current) {
        setState((current) => ({
          ...current, loading: false, error: t('无法连接 Claude Code 服务，请确认开发服务正在运行。'),
        }));
      }
      return null;
    }
  }, [mounted]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { state, refresh };
}

function useClaudeCodeModels(autoDiscover: boolean) {
  const mounted = useMountedRef();
  const autoStarted = useRef(false);
  const requestGeneration = useRef(0);
  const [models, setModels] = useState<readonly ClaudeCodeAgentModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = useCallback((): void => {
    requestGeneration.current += 1;
    autoStarted.current = false;
    if (!mounted.current) return;
    setModels([]);
    setBusy(false);
    setError(null);
  }, [mounted]);
  const discoverModels = useCallback(async (): Promise<readonly ClaudeCodeAgentModel[]> => {
    const generation = ++requestGeneration.current;
    setBusy(true); setError(null);
    try {
      const response = await fetchClaudeCodeModels();
      if (generation !== requestGeneration.current) return [];
      if (response.error) {
        if (mounted.current) setError(t('读取模型失败：{message}', { message: response.error }));
        return [];
      }
      if (mounted.current) setModels(response.models);
      return response.models;
    } catch {
      if (generation === requestGeneration.current && mounted.current) {
        setError(t('无法读取 Claude Code 模型，请稍后重试。'));
      }
      return [];
    } finally {
      if (generation === requestGeneration.current && mounted.current) setBusy(false);
    }
  }, [mounted]);
  useEffect(() => {
    if (!autoDiscover) {
      reset();
      return;
    }
    if (autoStarted.current) return;
    autoStarted.current = true;
    void discoverModels();
  }, [autoDiscover, discoverModels, reset]);
  return { models, busy, error, discoverModels, reset };
}

export function useClaudeCodeSettings(savedModel?: string): ClaudeCodeSettingsController {
  const remote = useClaudeCodeStatusControl();
  const models = useClaudeCodeModels(remote.state.status?.account?.loggedIn === true);
  useEffect(() => {
    if (remote.state.status) {
      applyClaudeCodeAgentStatus(remote.state.status, savedModel, models.models);
    }
  }, [models.models, remote.state.status, savedModel]);
  return {
    status: remote.state.status,
    loading: remote.state.loading,
    error: remote.state.error,
    modelBusy: models.busy,
    modelError: models.error,
    models: models.models,
    refresh: remote.refresh,
    discoverModels: models.discoverModels,
  };
}
