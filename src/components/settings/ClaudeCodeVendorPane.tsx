import type { ReactNode } from 'react';
import { theme } from '../../theme';
import { useT } from '../../i18n/locale';
import { VendorIcon } from './vendorIcons';
import { ClaudeCodeAccountCard } from './ClaudeCodeAccountCard';
import { ModelCapabilityEditor } from './ModelCapabilityEditor';
import { SettingsNoteAction } from './SettingsNoteAction.tsx';
import { modelValue, vendorConfigured, type SettingsVendorPage } from './settingsSchema';
import { fieldCardBox, ON, pageNote, pane } from './settingsVendorPane.styles';
import type { FieldCtx } from './settingsVendorPane';

/** Claude Code backend page: CLI/account status, the model picker and the
 * capability override editor. Split out of settingsVendorPane.tsx (which owns
 * the generic field renderer) to keep both files inside the 500-line gate. */
export function ClaudeCodeVendorPane({ page, hint, ctx, children, rawOverrides, onOverridesChange }: {
  page: SettingsVendorPage; hint: string; ctx: FieldCtx; children: ReactNode;
  rawOverrides: string; onOverridesChange: (value: string) => void;
}) {
  const t = useT();
  const status = ctx.claudeCode.status;
  const statusLabel = !status ? t('状态未知')
    : !status.installed ? t('CLI 未安装')
      : status.account?.loggedIn ? t('已登录')
        : status.error || ctx.claudeCode.error ? t('连接异常') : t('未登录');
  const on = vendorConfigured(ctx.status, page, ctx.codex.status, ctx.copilot.status, status);
  const capabilityModelId = (ctx.values.CLAUDE_CODE_MODEL ?? modelValue(ctx.status, 'CLAUDE_CODE_MODEL'))
    || ctx.claudeCode.models.find((model) => model.isDefault)?.id
    || '';
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
      <ClaudeCodeAccountCard controller={ctx.claudeCode} />
      <section style={fieldCardBox}>
        {page.note && <div style={pageNote}>{t(page.note)}</div>}
        {page.noteAction && <SettingsNoteAction config={page.noteAction} onOpenPage={ctx.openPage} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: page.note ? 9 : 0 }}>
          {children}
        </div>
        {capabilityModelId && (
          <ModelCapabilityEditor backend="claude-code" provider="anthropic"
            modelId={capabilityModelId}
            rawOverrides={rawOverrides}
            onChange={onOverridesChange} />
        )}
      </section>
    </div>
  );
}
