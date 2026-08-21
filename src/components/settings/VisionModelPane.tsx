// Vision bypass settings pane: pick a vision-capable model that describes
// images as text when the active agent model cannot see them.
// Two-level picker: provider (from configured API choices) → model (full
// vision-capable catalog for that provider, plus the configured model).
import { useMemo, useSyncExternalStore } from 'react';
import { theme } from '../../theme';
import { useT } from '../../i18n/locale';
import {
  getVisionModelConfig,
  setVisionModelConfig,
  subscribeVisionModelConfig,
  type VisionModelMode,
} from '../../agent/visionConfig';
import {
  getAgentModelSnapshot,
  subscribeAgentModels,
} from '../../agent/model-selection';
import { listVisionModels } from '../../../shared/model-capabilities';
import type { LlmProvider } from '../../../shared/llm-providers';
import { VendorIcon } from './vendorIcons';

// Data constants: keep Chinese originals and translate at render time via
// t(mode.label) / t(mode.hint) so a language switch re-renders correctly.
const MODES: readonly { value: VisionModelMode; label: string; hint: string }[] = [
  { value: 'follow', label: '跟随主模型', hint: '主模型不支持图片时维持现状（图片剥离为文本）。' },
  { value: 'custom', label: '指定视觉模型', hint: '图片与时间线帧由所选视觉模型理解后以文本注入。' },
  { value: 'disabled', label: '禁用', hint: '不描述图片，一律剥离。' },
];

const PROVIDER_LABELS: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  kimi: 'Kimi',
  qwen: 'Qwen',
  glm: 'GLM',
  deepseek: 'DeepSeek',
  stepfun: 'StepFun',
  byteplus: 'BytePlus',
  minimax: 'MiniMax',
  xiaomi: 'Xiaomi',
  mistral: 'Mistral',
  xai: 'xAI',
  'xai-oauth': 'xAI (订阅登录)',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

export function VisionModelPane(): React.JSX.Element {
  const t = useT();
  const config = useSyncExternalStore(subscribeVisionModelConfig, getVisionModelConfig, getVisionModelConfig);
  const snapshot = useSyncExternalStore(subscribeAgentModels, getAgentModelSnapshot, getAgentModelSnapshot);
  // Providers that are configured (API key present) and offer vision models.
  const providerChoices = useMemo(() => {
    const seen = new Map<LlmProvider, { label: string; configuredModel: string }>();
    for (const choice of snapshot.choices) {
      if (choice.backend !== 'api') continue;
      const existing = seen.get(choice.provider);
      if (!existing || (existing.configuredModel === '' && choice.model)) {
        seen.set(choice.provider, { label: choice.providerLabel, configuredModel: choice.model });
      }
    }
    return [...seen.entries()]
      .filter(([provider, entry]) => listVisionModels(provider, entry.configuredModel).length > 0)
      .map(([provider, entry]) => ({ provider, ...entry }));
  }, [snapshot.choices]);

  const selectedProvider = providerChoices.find((p) => p.provider === config.provider)?.provider
    ?? providerChoices[0]?.provider
    ?? null;
  const models = useMemo(() => {
    if (!selectedProvider) return [];
    const entry = providerChoices.find((p) => p.provider === selectedProvider);
    return listVisionModels(selectedProvider, entry?.configuredModel);
  }, [selectedProvider, providerChoices]);
  const selectedModel = config.mode === 'custom' && selectedProvider === config.provider
    ? (models.includes(config.model ?? '') ? config.model! : '')
    : '';

  const onMode = (mode: VisionModelMode): void => {
    if (mode === 'custom') {
      const firstProvider = providerChoices[0];
      if (!firstProvider) return;
      const firstModels = listVisionModels(firstProvider.provider, firstProvider.configuredModel);
      if (!firstModels.length) return;
      setVisionModelConfig({
        mode,
        provider: firstProvider.provider,
        model: firstModels[0]!,
        openAiApiMode: null,
      });
      return;
    }
    setVisionModelConfig({ mode, provider: null, model: null, openAiApiMode: null });
  };
  const onPickProvider = (provider: LlmProvider): void => {
    const entry = providerChoices.find((p) => p.provider === provider);
    const first = listVisionModels(provider, entry?.configuredModel)[0];
    if (!first) return;
    setVisionModelConfig({ mode: 'custom', provider, model: first, openAiApiMode: null });
  };
  const onPickModel = (model: string): void => {
    if (!selectedProvider) return;
    setVisionModelConfig({ mode: 'custom', provider: selectedProvider, model, openAiApiMode: null });
  };

  return (
    <div style={pane}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <VendorIcon vendor="vision" size={18} />
          <b style={{ fontSize: 13 }}>{t('视觉理解')}</b>
          <span style={{ fontSize: 11, color: theme.textDim }}>
            {config.mode === 'custom' ? t('已指定') : config.mode === 'disabled' ? t('已禁用') : t('跟随主模型')}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 3, paddingLeft: 26 }}>
          {t('基底模型不支持图片输入时（如 DeepSeek 系），图片由所选视觉模型理解后以文本注入。')}
        </div>
      </div>
      <section style={fieldCardBox}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {MODES.map((mode) => (
            <label key={mode.value} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="radio"
                name="vision-mode"
                checked={config.mode === mode.value}
                onChange={() => onMode(mode.value)}
              />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <b style={{ fontSize: 12 }}>{t(mode.label)}</b>
                <span style={{ fontSize: 11, color: theme.textDim }}>{t(mode.hint)}</span>
              </span>
            </label>
          ))}
          {config.mode === 'custom' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 11, color: theme.textDim }}>{t('厂商（已配置 API Key）')}</span>
                  <select
                    value={selectedProvider ?? ''}
                    onChange={(event) => onPickProvider(event.target.value as LlmProvider)}
                    style={selectStyle}
                  >
                    {providerChoices.length === 0 && <option value="">{t('无可用厂商（请先配置 API Key）')}</option>}
                    {providerChoices.map((entry) => (
                      <option key={entry.provider} value={entry.provider}>
                        {PROVIDER_LABELS[entry.provider]}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1.4 }}>
                  <span style={{ fontSize: 11, color: theme.textDim }}>{t('视觉模型')}</span>
                  <select
                    value={selectedModel}
                    onChange={(event) => onPickModel(event.target.value)}
                    style={selectStyle}
                  >
                    {models.map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                </div>
              </div>
              <span style={{ fontSize: 10.5, color: theme.textDim }}>
                {t('图片会发送给所选视觉模型厂商用于描述；视觉调用失败时自动回退为剥离文本，不阻塞对话。')}
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

const pane: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, width: '100%' };
const fieldCardBox: React.CSSProperties = {
  border: `0.5px solid ${theme.border}`,
  borderRadius: 8,
  padding: '10px 12px',
  background: theme.panel,
};
const selectStyle: React.CSSProperties = {
  fontSize: 12, padding: '5px 8px', borderRadius: 5,
  border: `0.5px solid ${theme.border}`, background: theme.panel, color: theme.text,
};
