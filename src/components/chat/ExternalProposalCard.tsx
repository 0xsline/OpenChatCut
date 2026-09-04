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
  // Bridge errors surface as machine-readable strings; map the common
  // ownership-conflict cases to user-facing copy, then translate via i18n.
  const BRIDGE_ERROR_KEYS: Record<string, string> = {
    'registration failed: HTTP 409': '工程正在其他窗口编辑，无法注册。请关闭其他窗口后重试。',
    'poll failed: HTTP 409': '工程正在其他窗口编辑，连接已中断。请关闭其他窗口后重试。',
    'cancellation poll failed: HTTP 409': '工程正在其他窗口编辑，连接已中断。请关闭其他窗口后重试。',
    'result failed: HTTP 409': '工程正在其他窗口编辑，结果未能送达。请关闭其他窗口后重试。',
  };
  const text = t(BRIDGE_ERROR_KEYS[message] ?? message);
  return (
    <div role="alert" style={{ margin: '10px 0', color: theme.danger, fontSize: 12 }}>
      {text}
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
        <strong style={{ fontSize: 12.5 }}>{t('真实工具确认')}</strong>
        <code style={{ marginLeft: 'auto', color: theme.textDim, fontSize: 10 }}>{guard.id}</code>
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
      proposal={{ ...proposal, title: `${t('提案审核')} · ${proposal.title}` }}
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
