import { useT } from '../i18n/locale';
import type { InstalledPack } from '../plugins/store';
import { theme } from '../theme';
import {
  EXTENSION_TYPE_LABEL,
  packCounts,
  secondaryButton,
} from './ExtensionCenterModel';
import { ExtensionGlyph, ExtensionTag, ExtensionToggle, SourceLabel } from './ExtensionCenterParts';

interface InstalledProps {
  packs: InstalledPack[];
  busyId: string | null;
  expandedId: string | null;
  confirmId: string | null;
  onExpand: (id: string | null) => void;
  onConfirm: (id: string | null) => void;
  onToggle: (pack: InstalledPack) => void;
  onRemove: (pack: InstalledPack) => void;
}

function PackDetails({ pack, confirming, busy, onConfirm, onRemove }: {
  pack: InstalledPack;
  confirming: boolean;
  busy: boolean;
  onConfirm: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div style={{ borderTop: `0.5px solid ${theme.border}`, padding: '9px 11px 11px' }}>
      {pack.description && <div style={{ color: theme.textDim, fontSize: 10.5, lineHeight: 1.5, marginBottom: 8 }}>{pack.description}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 4 }}>
        {pack.items.map((item) => (
          <div key={`${item.type}:${item.id}`} style={{ border: `0.5px solid ${theme.border}`, padding: '5px 7px', color: theme.text, fontSize: 10.5, borderRadius: 3 }}>
            <span style={{ color: theme.textDim }}>{t(EXTENSION_TYPE_LABEL[item.type] ?? item.type)} · </span>{item.name}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 9 }}>
        {confirming ? (
          <>
            <button type="button" disabled={busy} onClick={onRemove} style={{ ...secondaryButton(busy), color: theme.danger }}>{t('Confirm uninstall')}</button>
            <button type="button" onClick={onConfirm} style={secondaryButton()}>{t('Cancel')}</button>
          </>
        ) : (
          <button type="button" onClick={onConfirm} style={{ ...secondaryButton(), color: theme.danger }}>{t('Uninstall')}</button>
        )}
      </div>
    </div>
  );
}

function InstalledCard({ pack, props }: { pack: InstalledPack; props: InstalledProps }) {
  const t = useT();
  const expanded = props.expandedId === pack.id;
  return (
    <article style={{ border: `0.5px solid ${theme.border}`, background: theme.panelAlt, borderRadius: 5, overflow: 'hidden', opacity: pack.enabled ? 1 : 0.72 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 11 }}>
        <ExtensionGlyph label={pack.name} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ color: theme.textStrong, fontSize: 12.5, fontWeight: 700 }}>{pack.name}</span>
            <span style={{ color: theme.textDim, fontSize: 10 }}>v{pack.version}</span>
          </div>
          <div style={{ color: theme.textDim, fontSize: 10, marginTop: 3 }}>{pack.author || t('unknown author')} · <SourceLabel pack={pack} /> · {new Date(pack.installedAt).toLocaleDateString()}</div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 180 }}>
          {packCounts(pack).map(([label, count]) => <ExtensionTag key={label}>{t(label)} ×{count}</ExtensionTag>)}
        </div>
        <ExtensionToggle checked={pack.enabled} disabled={props.busyId !== null} onChange={() => props.onToggle(pack)} />
        <button type="button" onClick={() => props.onExpand(expanded ? null : pack.id)} style={secondaryButton()}>{expanded ? t('close') : t('View content')}</button>
      </div>
      {expanded && (
        <PackDetails
          pack={pack}
          confirming={props.confirmId === pack.id}
          busy={props.busyId !== null}
          onConfirm={() => props.onConfirm(props.confirmId === pack.id ? null : pack.id)}
          onRemove={() => props.onRemove(pack)}
        />
      )}
    </article>
  );
}

export function ExtensionInstalled(props: InstalledProps) {
  const t = useT();
  if (!props.packs.length) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{ color: theme.text, fontSize: 12, fontWeight: 650 }}>{t('No extension installed yet')}</div>
        <div style={{ color: theme.textDim, fontSize: 10.5, marginTop: 5 }}>{t('Go to "Discover" to install the extension, and the content will automatically enter the corresponding resource category.')}</div>
      </div>
    );
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>{props.packs.map((pack) => <InstalledCard key={pack.id} pack={pack} props={props} />)}</div>;
}
