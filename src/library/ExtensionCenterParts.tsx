import { useRef, useState, type ReactNode } from 'react';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { installFromText, installFromUrl, type InstallResult } from '../plugins/install';
import type { InstalledPack } from '../plugins/store';
import { theme } from '../theme';
import { secondaryButton } from './ExtensionCenterModel';

export function SourceLabel({ pack }: { pack: InstalledPack }) {
  const t = useT();
  const label = pack.source?.kind === 'registry'
    ? t('Extension Center')
    : pack.source?.kind === 'url'
      ? t('URL Installation')
      : pack.source?.kind === 'file'
        ? t('local file')
        : t('Legacy migration');
  return <span>{label}</span>;
}

export function ExtensionToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? t('Disable extension') : t('Enable extension')}
      disabled={disabled}
      onClick={onChange}
      style={{
        width: 30,
        height: 17,
        border: `0.5px solid ${checked ? theme.accent : theme.border}`,
        borderRadius: 9,
        padding: 2,
        background: checked ? `color-mix(in srgb, ${theme.accent} 28%, ${theme.panelAlt})` : theme.panelAlt,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span style={{
        display: 'block',
        width: 11,
        height: 11,
        borderRadius: '50%',
        background: checked ? theme.accent : theme.textDim,
        transform: checked ? 'translateX(13px)' : 'translateX(0)',
        transition: 'transform 140ms ease-out',
      }} />
    </button>
  );
}

export function ExtensionGlyph({ label }: { label: string }) {
  return (
    <div style={{
      width: 38,
      height: 38,
      display: 'grid',
      placeItems: 'center',
      flex: '0 0 auto',
      border: `0.5px solid ${theme.border}`,
      background: theme.panelAlt,
      color: theme.accent,
      fontSize: 15,
      fontWeight: 750,
      borderRadius: 5,
    }}>
      {label.trim().slice(0, 1).toUpperCase()}
    </div>
  );
}

export function ExtensionTag({ children, verified = false }: { children: ReactNode; verified?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 3,
      border: `0.5px solid ${verified ? `color-mix(in srgb, ${theme.success} 55%, ${theme.border})` : theme.border}`,
      padding: '1px 5px',
      borderRadius: 3,
      color: verified ? theme.success : theme.textDim,
      fontSize: 9.5,
      lineHeight: 1.45,
    }}>
      {verified && <Icon name="check" size={9} />}
      {children}
    </span>
  );
}

const INSTALL_INPUT_STYLE = {
  flex: 1,
  minWidth: 0,
  border: `0.5px solid ${theme.border}`,
  borderRadius: 4,
  background: theme.panel,
  color: theme.text,
  padding: '6px 8px',
  fontSize: 11.5,
} as const;

function UrlInstallRow({ busy, onInstall }: {
  busy: boolean;
  onInstall: (task: Promise<InstallResult>) => void;
}) {
  const t = useT();
  const [url, setUrl] = useState('');
  const submit = () => onInstall(installFromUrl(url.trim()));
  return (
    <>
      <input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && url.trim() && !busy) submit(); }}
        placeholder={t('expansion pack JSON URL…')}
        style={INSTALL_INPUT_STYLE}
      />
      <button type="button" disabled={busy || !url.trim()} onClick={submit} style={secondaryButton(busy || !url.trim())}>
        {t('from URL Installation')}
      </button>
    </>
  );
}

function FileInstallButton({ busy, onInstall }: {
  busy: boolean;
  onInstall: (task: Promise<InstallResult>) => void;
}) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const select = (file?: File) => {
    if (file) onInstall(file.text().then((text) => installFromText(text, { source: { kind: 'file' } })));
  };
  return (
    <>
      <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} style={secondaryButton(busy)}>{t('Select file')}</button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(event) => {
          select(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </>
  );
}

export function InstallPanel({
  busy,
  onInstall,
}: {
  busy: boolean;
  onInstall: (task: Promise<InstallResult>) => void;
}) {
  const t = useT();
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 7,
      border: `0.5px solid ${theme.border}`,
      background: theme.panelAlt,
      padding: 10,
      borderRadius: 5,
    }}>
      <div style={{ fontSize: 11.5, color: theme.text, fontWeight: 650 }}>{t('Local installation')}</div>
      <div style={{ fontSize: 10.5, color: theme.textDim }}>
        {t('Only install extension packages you trust; the format will be verified and actually compiled before installation. MG with Shader。')}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <UrlInstallRow busy={busy} onInstall={onInstall} />
        <FileInstallButton busy={busy} onInstall={onInstall} />
      </div>
    </div>
  );
}
