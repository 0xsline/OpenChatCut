import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useT } from '../i18n/locale';
import { theme } from '../theme';
import { Icon } from './icons';

const PROJECT_REPOSITORY_URL = 'https://github.com/0xsline/OpenChatCut';
const AUTHOR_EMAIL = 'hl2535771@gmail.com';
const CONTACT_POPOVER_ID = 'cc-dashboard-contact';

function useDismissablePopover<T extends HTMLElement>(
  open: boolean,
  containerRef: RefObject<T | null>,
  setOpen: Dispatch<SetStateAction<boolean>>,
) {
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [containerRef, open, setOpen]);
}

export function DashboardHeaderLinks() {
  const t = useT();
  const [contactOpen, setContactOpen] = useState(false);
  const contactRef = useRef<HTMLSpanElement>(null);
  useDismissablePopover(contactOpen, contactRef, setContactOpen);

  return (
    <span ref={contactRef} style={linkGroup}>
      <button
        type="button"
        onClick={() => setContactOpen((open) => !open)}
        aria-label={t('联系作者')}
        aria-expanded={contactOpen}
        aria-controls={CONTACT_POPOVER_ID}
        aria-haspopup="dialog"
        data-tip={t('联系作者')}
        className="cc-header-btn cc-tip cc-tip-r"
        style={iconButton}
      >
        <Icon name="mail" size={16} />
      </button>
      <a
        href={PROJECT_REPOSITORY_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('GitHub 仓库')}
        data-tip={t('GitHub 仓库')}
        data-cc-titlebar-control="true"
        className="cc-header-btn cc-tip cc-tip-r"
        style={githubLink}
      >
        <Icon name="github" size={16} />
      </a>
      {contactOpen && (
        <div id={CONTACT_POPOVER_ID} role="dialog" aria-label={t('联系作者')} style={contactPopover}>
          <span style={contactLabel}>{t('联系作者')}</span>
          <a href={`mailto:${AUTHOR_EMAIL}`} data-cc-titlebar-control="true" style={contactEmail}>
            {AUTHOR_EMAIL}
          </a>
        </div>
      )}
    </span>
  );
}

const linkGroup: CSSProperties = {
  position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 2,
};
const iconButton: CSSProperties = {
  background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 6,
  borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};
const githubLink: CSSProperties = { ...iconButton, textDecoration: 'none' };
const contactPopover: CSSProperties = {
  position: 'absolute', top: 34, right: 0, zIndex: 20, width: 220, maxWidth: 'calc(100vw - 32px)',
  display: 'flex', flexDirection: 'column', gap: 5, padding: '10px 12px',
  border: `0.5px solid ${theme.border}`, borderRadius: 6, background: theme.panelAlt,
  boxShadow: '0 6px 18px rgba(var(--cc-shadow-rgb), 0.24)',
};
const contactLabel: CSSProperties = { color: theme.textDim, fontSize: 11 };
const contactEmail: CSSProperties = {
  color: theme.textStrong, fontSize: 12.5, textDecoration: 'underline', textUnderlineOffset: 2,
  whiteSpace: 'nowrap',
};
