import type { ReactNode } from 'react';
import { theme } from '../../theme';
import { useT } from '../../i18n/locale';
import { copilotProviderForModel } from '../../../shared/model-capabilities';
import { VendorIcon } from './vendorIcons';
import { CopilotAccountCard } from './CopilotAccountCard';
import { ModelCapabilityEditor } from './ModelCapabilityEditor';
import { SettingsNoteAction } from './SettingsNoteAction.tsx';
import { modelValue, vendorConfigured, type SettingsVendorPage } from './settingsSchema';
import { fieldCardBox, ON, pageNote, pane } from './settingsVendorPane.styles';
import type { FieldCtx } from './settingsVendorPane';

export function CopilotVendorPane({ page, hint, ctx, children, rawOverrides, onOverridesChange }: {
  page: SettingsVendorPage; hint: string; ctx: FieldCtx; children: ReactNode;
  rawOverrides: string; onOverridesChange: (value: string) => void;
}) {
  const t = useT();
  const status = ctx.copilot.status;
  const statusLabel = !status ? t('状态未知')
    : !status.installed ? t('CLI 未安装')
      : !status.supported ? t('版本过低')
        : status.authenticated ? t('已登录')
          : status.error || ctx.copilot.error ? t('连接异常') : t('未登录');
  const on = vendorConfigured(ctx.status, page, ctx.codex.status, status);
  const capabilityModelId = (ctx.values.COPILOT_MODEL ?? modelValue(ctx.status, 'COPILOT_MODEL'))
    || ctx.copilot.models.find((model) => model.isDefault)?.id
    || '';
  const capabilityProvider = capabilityModelId
    ? copilotProviderForModel(capabilityModelId)
    : 'openai';
  return (
    <div style={pane}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <VendorIcon vendor={page.vendor} size={18} />
          <b style={{ fontSize: 13 }}>{t(page.title)}</b>
          <span style={{ fontSize: 11, color: on ? ON : theme.textDim }}>{statusLabel}</span>
        </div>
        <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 3, paddingLeft: 26 }}>{t(hint)}</div>
      </div>
      <CopilotAccountCard controller={ctx.copilot} />
      <section style={fieldCardBox}>
        {page.note && <div style={pageNote}>{t(page.note)}</div>}
        {page.noteAction && <SettingsNoteAction config={page.noteAction} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: page.note ? 9 : 0 }}>
          {children}
        </div>
        {capabilityModelId && (
          <ModelCapabilityEditor backend="copilot" provider={capabilityProvider}
            modelId={capabilityModelId}
            rawOverrides={rawOverrides}
            onChange={onOverridesChange} />
        )}
      </section>
    </div>
  );
}
