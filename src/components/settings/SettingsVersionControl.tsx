import { theme, themeAlpha } from '../../theme';

export function SettingsVersionControl({
  versionLabel,
  checkLabel,
  checkingLabel,
  checking,
  onCheck,
}: {
  versionLabel: string;
  checkLabel: string;
  checkingLabel: string;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap' }}>
      <span style={{ color: theme.textDim, fontSize: 11.5 }}>{versionLabel}</span>
      <button
        type="button"
        onClick={onCheck}
        disabled={checking}
        onMouseEnter={(event) => {
          if (!checking) event.currentTarget.style.background = themeAlpha.ink(0.07);
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = themeAlpha.ink(0.035);
        }}
        style={{
          appearance: 'none',
          border: `0.5px solid ${theme.border}`,
          borderRadius: 4,
          background: themeAlpha.ink(0.035),
          color: checking ? theme.textDim : theme.text,
          cursor: checking ? 'default' : 'pointer',
          font: 'inherit',
          fontSize: 11.5,
          lineHeight: 1,
          padding: '6px 8px',
        }}
      >
        {checking ? checkingLabel : checkLabel}
      </button>
    </div>
  );
}
