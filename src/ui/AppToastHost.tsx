import { useEffect, useState } from 'react';
import { theme, themeAlpha } from '../theme';
import { Icon } from '../components/icons';
import { clearAppToast, subscribeAppToast, type AppToast } from './appToast';

/** Fixed bottom-center toast; mirrors Timeline clipJob chrome. */
export function AppToastHost() {
  const [toast, setToast] = useState<AppToast | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    return subscribeAppToast((next) => {
      if (timer) window.clearTimeout(timer);
      setToast(next);
      if (next && (next.ms ?? 0) > 0) {
        const msg = next.msg;
        timer = window.setTimeout(() => {
          setToast((cur) => (cur && cur.msg === msg ? null : cur));
        }, next.ms);
      }
    });
  }, []);

  if (!toast) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 56,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        maxWidth: 'min(520px, 90vw)',
        padding: '10px 14px',
        borderRadius: 4,
        fontSize: 12.5,
        lineHeight: 1.35,
        boxShadow: `0 8px 28px ${themeAlpha.shadow(0.35)}`,
        background: toast.error ? theme.accent : theme.panelAlt,
        color: toast.error ? theme.onAccent : theme.text,
        border: `0.5px solid ${theme.border}`,
      }}
    >
      <span style={{ flex: 1 }}>{toast.msg}</span>
      {toast.error && (
        <button
          type="button"
          onClick={() => clearAppToast()}
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            padding: 0,
            lineHeight: 0,
            display: 'grid',
            placeItems: 'center',
          }}
          aria-label="dismiss"
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}
