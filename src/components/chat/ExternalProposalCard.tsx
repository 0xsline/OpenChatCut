import { useEffect } from 'react';
import type { ExternalProposalController } from '../../agent/useExternalAgentBridge';
import type { TimelineState } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import { ProposalCard } from './ProposalCard';

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
