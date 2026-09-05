import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import { selectAgentModel } from '../../agent/model-selection';
import { Icon } from '../icons';
import { ComposerPopover } from './ComposerPopover';
import type { ComposerModelView } from './useComposerModelView';
import codexPng from '../../../assets/vendor-icons/codex-color.png';

function ChoiceLogo({ backend }: { backend: 'api' | 'codex' | 'copilot' }) {
  if (backend === 'copilot') {
    return (
      <span
        aria-hidden
        style={{ width: 18, height: 18, borderRadius: 5, flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.panel, border: `0.5px solid ${theme.borderLight}`, color: theme.text }}
      >
        <Icon name="github" size={12} />
      </span>
    );
  }
  if (backend !== 'codex') return null;
  return (
    <img
      src={codexPng}
      alt=""
      aria-hidden
      style={{ width: 18, height: 18, borderRadius: 5, objectFit: 'contain', flex: '0 0 auto', background: theme.panel, border: `0.5px solid ${theme.borderLight}` }}
    />
  );
}

export function ComposerModelPicker({ anchor, onClose, view }: {
  readonly anchor: HTMLElement | null;
  readonly onClose: () => void;
  readonly view: ComposerModelView;
}) {
  const t = useT();
  return (
    <ComposerPopover width={278} anchor={anchor} onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 10.5, color: theme.textDim, padding: '4px 8px 6px' }}>
        <span>{t('本条对话使用的模型')}</span>
        <span title={view.contextTitle} style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{view.contextLabel}</span>
      </div>
      {view.modelState.choices.length === 0 && (
        <div style={{ padding: '7px 9px 9px', color: theme.textDim, fontSize: 11.5, lineHeight: 1.5 }}>
          {view.modelState.loaded ? t('请先在设置中配置一个模型厂商。') : t('正在读取模型配置…')}
        </div>
      )}
      {view.modelState.choices.map((choice) => {
        const active = choice.id === view.modelState.activeId;
        return (
          <button type="button" key={choice.id}
            onClick={() => { selectAgentModel(choice.id); onClose(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 9px', border: 0, borderRadius: 3, background: active ? theme.panel : 'transparent', color: theme.text, cursor: 'pointer', textAlign: 'left' }}>
            <ChoiceLogo backend={choice.backend} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ display: 'block', fontSize: 11.5, fontWeight: 600 }}>{choice.providerLabel}</strong>
              <small style={{ display: 'block', color: theme.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{choice.model}</small>
            </span>
            {active && <span style={{ color: theme.accent, lineHeight: 0 }}><Icon name="check" size={13} /></span>}
          </button>
        );
      })}
    </ComposerPopover>
  );
}
