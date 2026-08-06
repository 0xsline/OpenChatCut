import { useEffect } from 'react';
import type { ExternalProposalController } from '../../agent/useExternalAgentBridge';
import type { TimelineState } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import { ProposalCard } from './ProposalCard';
import { Icon } from '../icons';

export function ExternalProposalCard({ external, onPreviewState }: {
  external: ExternalProposalController;
  onPreviewState: (state: TimelineState | null) => void;
}) {
  const t = useT();
  useEffect(() => {
    if (!external.proposal) onPreviewState(null);
  }, [external.proposal, onPreviewState]);

  return (
    <>
      {external.error && (
        <div role="alert" style={{ margin: '10px 0', color: theme.danger, fontSize: 12 }}>
          {t('外部 Agent：{message}', { message: external.error })}
        </div>
      )}
      {external.pendingGuard && (
        <div
          role="alertdialog"
          style={{
            margin: '10px 0', padding: '10px 12px', borderRadius: 6,
            background: theme.panelAlt, border: `0.5px solid ${theme.accent}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
            <Icon name="wand" size={14} />
            <strong style={{ fontSize: 12.5 }}>{t('外部 Agent 请求执行真实工程操作')}</strong>
          </div>
          <div style={{ fontSize: 12, color: theme.text, marginBottom: 8, lineHeight: 1.5 }}>
            {t('工具 {tool} 会作用于当前工程（{summary}）。确认后本会话内不再询问。', {
              tool: external.pendingGuard.tool,
              summary: external.pendingGuard.summary,
            })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => external.confirmGuard(external.pendingGuard!.id, true)}
              style={{ border: `0.5px solid ${theme.accent}`, background: 'none', color: theme.text, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}
            >
              {t('确认')}
            </button>
            <button
              type="button"
              onClick={() => external.confirmGuard(external.pendingGuard!.id, false)}
              style={{ border: `0.5px solid ${theme.border}`, background: 'none', color: theme.textDim, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}
            >
              {t('拒绝')}
            </button>
          </div>
        </div>
      )}
      {external.proposal && (
        <ProposalCard
          proposal={{ ...external.proposal, title: `${external.proposal.title} ${t('编辑提案')}` }}
          onApply={external.applyProposal}
          onReject={external.rejectProposal}
          stale={external.proposalStale}
          onForceApply={external.forceApplyProposal}
          onPreview={(on) => onPreviewState(on ? external.proposal!.resultState : null)}
        />
      )}
    </>
  );
}
