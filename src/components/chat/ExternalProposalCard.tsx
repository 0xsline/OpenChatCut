import { useEffect } from 'react';
import type { ExternalProposalController } from '../../agent/useExternalAgentBridge';
import type { TimelineState } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import { ProposalCard } from './ProposalCard';
import { Icon } from '../icons';
import { ApprovalDetails } from './ApprovalDetails';

type ExternalGuard = NonNullable<ExternalProposalController['pendingGuard']>;
type ConfirmGuard = ExternalProposalController['confirmGuard'];

function ExternalErrorAlert({ message }: { message: string }) {
  const t = useT();
  return (
    <div role="alert" style={{ margin: '10px 0', color: theme.danger, fontSize: 12 }}>
      {t('外部 Agent：{message}', { message })}
    </div>
  );
}

function GuardDetails({ guard }: { guard: ExternalGuard }) {
  const t = useT();
  return (
    <div style={{ fontSize: 12, color: theme.text, marginBottom: 8, lineHeight: 1.5 }}>
      {t('工具 {tool} 将作用于当前工程。确认仅绑定下方参数；修改参数后必须重新确认。', {
        tool: guard.tool,
      })}
      {!guard.details.length && (
        <div style={{ marginTop: 5, color: theme.textDim, overflowWrap: 'anywhere' }}>
          {guard.summary}
        </div>
      )}
      <ApprovalDetails
        details={guard.details}
        argsDigest={guard.argsDigest}
        operationId={guard.operationId}
      />
    </div>
  );
}

function GuardActions({ guard, confirmGuard }: {
  guard: ExternalGuard;
  confirmGuard: ConfirmGuard;
}) {
  const t = useT();
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <button
        type="button"
        onClick={() => confirmGuard(guard.id, true)}
        style={{ border: `0.5px solid ${theme.accent}`, background: 'none', color: theme.text, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}
      >
        {t('确认')}
      </button>
      <button
        type="button"
        onClick={() => confirmGuard(guard.id, false)}
        style={{ border: `0.5px solid ${theme.border}`, background: 'none', color: theme.textDim, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}
      >
        {t('拒绝')}
      </button>
    </div>
  );
}

function PendingGuardDialog({ guard, confirmGuard }: {
  guard: ExternalGuard;
  confirmGuard: ConfirmGuard;
}) {
  const t = useT();
  return (
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
      <GuardDetails guard={guard} />
      <GuardActions guard={guard} confirmGuard={confirmGuard} />
    </div>
  );
}

function ExternalProposal({ external, onPreviewState }: {
  external: ExternalProposalController;
  onPreviewState: (state: TimelineState | null) => void;
}) {
  const t = useT();
  const proposal = external.proposal;
  if (!proposal) return null;
  return (
    <ProposalCard
      proposal={{ ...proposal, title: `${proposal.title} ${t('编辑提案')}` }}
      onApply={external.applyProposal}
      onReject={external.rejectProposal}
      stale={external.proposalStale}
      onForceApply={external.forceApplyProposal}
      onPreview={(on) => onPreviewState(on ? proposal.resultState : null)}
    />
  );
}

export function ExternalProposalCard({ external, onPreviewState }: {
  external: ExternalProposalController;
  onPreviewState: (state: TimelineState | null) => void;
}) {
  useEffect(() => {
    if (!external.proposal) onPreviewState(null);
  }, [external.proposal, onPreviewState]);

  return (
    <>
      {external.error && <ExternalErrorAlert message={external.error} />}
      {external.pendingGuard && (
        <PendingGuardDialog
          guard={external.pendingGuard}
          confirmGuard={external.confirmGuard}
        />
      )}
      <ExternalProposal external={external} onPreviewState={onPreviewState} />
    </>
  );
}
