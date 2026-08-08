import { Icon } from '../components/icons';
import { theme, themeAlpha } from '../theme';

const noticeStyle = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 190,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: 'min(460px, calc(100vw - 36px))',
  padding: '11px 12px 11px 14px',
  border: 'none',
  borderRadius: 5,
  background: theme.panel,
  color: theme.text,
  boxShadow: `0 12px 32px ${themeAlpha.shadow(0.32)}`,
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: 12.5,
  lineHeight: 1.5,
} as const;

const actionStyle = {
  flex: '0 0 auto',
  padding: '6px 9px',
  border: `0.5px solid ${theme.border}`,
  borderRadius: 4,
  background: themeAlpha.ink(0.05),
  color: theme.text,
  font: 'inherit',
  fontSize: 11.5,
} as const;

const closeStyle = {
  display: 'grid',
  placeItems: 'center',
  flex: '0 0 auto',
  padding: 2,
  border: 'none',
  background: 'transparent',
  color: theme.textDim,
  cursor: 'pointer',
  lineHeight: 0,
} as const;

export function UpstreamUpdateNoticeView({
  message,
  actionLabel,
  actionDisabled = false,
  closeLabel,
  onAction,
  onDismiss,
}: {
  message: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  closeLabel: string;
  onAction?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div role="status" aria-live="polite" style={noticeStyle}>
      <span style={{ flex: 1 }}>{message}</span>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          style={{ ...actionStyle, cursor: actionDisabled ? 'default' : 'pointer' }}
        >
          {actionLabel}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={closeLabel}
        title={closeLabel}
        style={closeStyle}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
