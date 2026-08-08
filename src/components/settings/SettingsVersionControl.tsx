import { theme, themeAlpha } from '../../theme';

export function SettingsVersionControl({
  versionLabel,
  actionLabel,
  disabled,
  onAction,
}: {
  versionLabel: string;
  actionLabel: string;
  disabled: boolean;
  onAction: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap' }}>
      <span style={{ color: theme.textDim, fontSize: 11.5 }}>{versionLabel}</span>
      <button
        type="button"
        onClick={onAction}
        disabled={disabled}
        onMouseEnter={(event) => {
          if (!disabled) event.currentTarget.style.background = themeAlpha.ink(0.07);
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = themeAlpha.ink(0.035);
        }}
        style={{
          appearance: 'none',
          border: `0.5px solid ${theme.border}`,
          borderRadius: 4,
          background: themeAlpha.ink(0.035),
          color: disabled ? theme.textDim : theme.text,
          cursor: disabled ? 'default' : 'pointer',
          font: 'inherit',
          fontSize: 11.5,
          lineHeight: 1,
          padding: '6px 8px',
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}
