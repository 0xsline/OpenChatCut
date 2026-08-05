import type { ReactNode } from 'react';
import { theme } from '../theme';
import { Icon, type IconName } from './icons';

interface TopBarIconButtonProps {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  badge?: ReactNode;
}

/** Shared right-side top-bar icon button: instant tooltip and consistent hover feedback. */
export function TopBarIconButton({ icon, label, onClick, disabled = false, badge }: TopBarIconButtonProps) {
  return (
    <button
      type="button"
      className="cc-tip cc-tip-r"
      data-tip={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{ width: 28, height: 28, background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: 0, borderRadius: 4, lineHeight: 0, display: 'grid', placeItems: 'center', color: theme.textDim, opacity: disabled ? 0.35 : 1 }}
      onMouseEnter={(event) => {
        if (!disabled) {
          event.currentTarget.style.color = theme.text;
          event.currentTarget.style.background = theme.panelAlt;
        }
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.color = theme.textDim;
        event.currentTarget.style.background = 'none';
      }}
    >
      <Icon name={icon} size={17} />
      {badge}
    </button>
  );
}
