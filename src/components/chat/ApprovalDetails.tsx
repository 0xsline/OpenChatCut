import type { ApprovalDetail } from '../../agent/approval-details';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export function ApprovalDetails({
  details,
  argsDigest,
  operationId,
}: {
  details?: readonly ApprovalDetail[];
  argsDigest?: string;
  operationId?: string;
}) {
  const t = useT();
  if (!details?.length && !argsDigest && !operationId) return null;
  return (
    <div style={{ marginTop: 7, display: 'grid', gap: 5 }}>
      {details?.map((detail, index) => (
        <div key={`${detail.kind}-${detail.label}-${index}`} style={{ display: 'grid', gap: 2 }}>
          <span style={{ color: theme.textDim, fontSize: 10.5 }}>{t(detail.label)}</span>
          <code style={{ color: theme.text, fontFamily: mono, fontSize: 11, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            {detail.value}
          </code>
        </div>
      ))}
      {operationId && (
        <div style={{ color: theme.textDim, fontFamily: mono, fontSize: 10.5, overflowWrap: 'anywhere' }}>
          {t('操作 ID')} {operationId}
        </div>
      )}
      {argsDigest && (
        <div style={{ color: theme.textDim, fontFamily: mono, fontSize: 10.5, overflowWrap: 'anywhere' }}>
          {t('参数摘要')} {argsDigest}
        </div>
      )}
    </div>
  );
}
