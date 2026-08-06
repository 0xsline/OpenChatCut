// Vision bypass settings pane: pick a vision-capable model that describes
// images as text when the active agent model cannot see them.
import { useSyncExternalStore } from 'react';
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
import { VendorIcon } from './vendorIcons';

const MODES: readonly { value: VisionModelMode; label: string; hint: string }[] = [
  { value: 'follow', label: '跟随主模型', hint: '主模型不支持图片时维持现状（图片剥离为文本）。' },
  { value: 'custom', label: '指定视觉模型', hint: '图片与时间线帧由所选视觉模型理解后以文本注入。' },
  { value: 'disabled', label: '禁用', hint: '不描述图片，一律剥离。' },
];

export function VisionModelPane(): React.JSX.Element {
  const t = useT();
  const config = useSyncExternalStore(subscribeVisionModelConfig, getVisionModelConfig, getVisionModelConfig);
  const snapshot = useSyncExternalStore(subscribeAgentModels, getAgentModelSnapshot, getAgentModelSnapshot);
  const visionChoices = snapshot.choices.filter((choice) => (
    choice.backend === 'api' && choice.capabilities.supportsImages.value
  ));
  const selected = config.mode === 'custom'
    ? visionChoices.find((choice) => (
        choice.provider === config.provider && choice.model === config.model
      ))
    : undefined;
  const activeId = selected?.id ?? '';

  const onMode = (mode: VisionModelMode): void => {
    if (mode === 'custom' && visionChoices.length > 0) {
      const first = visionChoices[0]!;
      setVisionModelConfig({
        mode,
        provider: first.provider,
        model: first.model,
        openAiApiMode: first.openAiApiMode ?? null,
      });
      return;
    }
    setVisionModelConfig({ mode, provider: null, model: null, openAiApiMode: null });
  };
  const onPick = (id: string): void => {
    const choice = visionChoices.find((candidate) => candidate.id === id);
    if (!choice) return;
    setVisionModelConfig({
      mode: 'custom',
      provider: choice.provider,
      model: choice.model,
      openAiApiMode: choice.openAiApiMode ?? null,
    });
  };

  return (
    <div style={pane}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <VendorIcon vendor="llm" size={18} />
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
              <span style={{ fontSize: 11.5, color: theme.textDim }}>{t('视觉模型（仅列出已配置且支持图片输入的模型）')}</span>
              <select
                value={activeId}
                onChange={(event) => onPick(event.target.value)}
                style={{ fontSize: 12, padding: '5px 8px', borderRadius: 5, border: `0.5px solid ${theme.border}`, background: theme.panel }}
              >
                {visionChoices.length === 0 && <option value="">{t('无可用视觉模型（请先配置 API Key）')}</option>}
                {visionChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.providerLabel} · {choice.model}
                  </option>
                ))}
              </select>
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
