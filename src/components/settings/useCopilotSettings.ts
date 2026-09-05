import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { CopilotAgentModel, CopilotAgentStatus } from '../../../shared/copilot-agent';
import { fetchCopilotModels, fetchCopilotStatus } from '../../agent/copilot/client';
import { applyCopilotAgentStatus } from '../../agent/model-selection';
import { t } from '../../i18n/locale';

export interface CopilotSettingsController {
  readonly status: CopilotAgentStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly modelBusy: boolean;
  readonly modelError: string | null;
  readonly models: readonly CopilotAgentModel[];
  readonly refresh: () => Promise<CopilotAgentStatus | null>;
  readonly discoverModels: () => Promise<readonly CopilotAgentModel[]>;
}

function useMountedRef(): RefObject<boolean> {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

/**
 * Copilot has no in-app sign-in: the CLI owns credentials and the user runs
 * `copilot login` in a terminal. This controller therefore only reads status
 * and discovers models, then republishes both to the agent model registry.
 */
export function useCopilotSettings(): CopilotSettingsController {
  const mounted = useMountedRef();
  const [status, setStatus] = useState<CopilotAgentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<readonly CopilotAgentModel[]>([]);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<CopilotAgentStatus | null> => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchCopilotStatus();
      if (!mounted.current) return next;
      setStatus(next);
      setLoading(false);
      applyCopilotAgentStatus(next);
      return next;
    } catch {
      if (mounted.current) {
        setLoading(false);
        setError(t('无法连接 Copilot 服务，请确认开发服务正在运行。'));
      }
      return null;
    }
  }, [mounted]);

  const discoverModels = useCallback(async (): Promise<readonly CopilotAgentModel[]> => {
    setModelBusy(true);
    setModelError(null);
    try {
      const response = await fetchCopilotModels();
      if (!mounted.current) return response.models;
      setModels(response.models);
      setModelBusy(false);
      if (response.error) setModelError(response.error);
      const current = await fetchCopilotStatus().catch(() => null);
      if (current && mounted.current) {
        setStatus(current);
        applyCopilotAgentStatus(current, undefined, undefined, response.models);
      }
      return response.models;
    } catch {
      if (mounted.current) {
        setModelBusy(false);
        setModelError(t('无法读取 Copilot 模型列表，请稍后重试。'));
      }
      return [];
    }
  }, [mounted]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { status, loading, error, modelBusy, modelError, models, refresh, discoverModels };
}
