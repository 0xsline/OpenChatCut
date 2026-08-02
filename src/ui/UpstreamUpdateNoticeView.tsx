import { Icon } from '../components/icons';
import { theme, themeAlpha } from '../theme';

export function UpstreamUpdateNoticeView({
  message,
  closeLabel,
  onDismiss,
}: {
  message: string;
  closeLabel: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 320,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        width: 'min(420px, calc(100vw - 36px))',
        padding: '11px 12px 11px 14px',
        border: 'none',
        borderRadius: 5,
        background: theme.panel,
        color: theme.text,
        boxShadow: `0 12px 32px ${themeAlpha.shadow(0.32)}`,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={closeLabel}
        title={closeLabel}
        onMouseEnter={(event) => { event.currentTarget.style.color = theme.text; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = theme.textDim; }}
        style={{
          display: 'grid',
          placeItems: 'center',
          flex: '0 0 auto',
          padding: 2,
          border: 'none',
          background: 'transparent',
          color: theme.textDim,
          cursor: 'pointer',
          lineHeight: 0,
        }}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

