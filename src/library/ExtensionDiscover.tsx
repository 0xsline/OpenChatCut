import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { installFromUrl, type InstallResult } from '../plugins/install';
import type { InstalledPack } from '../plugins/store';
import { theme } from '../theme';
import {
  EXTENSION_CATEGORIES,
  hasExtensionUpdate,
  secondaryButton,
  type Category,
  type RegistryEntry,
} from './ExtensionCenterModel';
import { ExtensionGlyph, ExtensionTag, InstallPanel } from './ExtensionCenterParts';

interface DiscoverProps {
  entries: RegistryEntry[];
  packs: InstalledPack[];
  busyId: string | null;
  showLocalInstall: boolean;
  query: string;
  category: Category;
  onQuery: (value: string) => void;
  onCategory: (value: Category) => void;
  onInstall: (id: string, task: Promise<InstallResult>) => void;
}

function RegistryCard({ entry, installed, busyId, onInstall }: {
  entry: RegistryEntry;
  installed?: InstalledPack;
  busyId: string | null;
  onInstall: DiscoverProps['onInstall'];
}) {
  const t = useT();
  const hasUpdate = !!installed && hasExtensionUpdate(installed.version, entry.version);
  const disabled = busyId !== null || (!!installed && !hasUpdate);
  const install = () => onInstall(entry.id, installFromUrl(entry.url, {
    ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
    source: { kind: 'registry', url: entry.url, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) },
  }));
  return (
    <article style={{ border: `0.5px solid ${theme.border}`, background: theme.panelAlt, padding: 11, borderRadius: 5, display: 'flex', flexDirection: 'column', gap: 9, minHeight: 116 }}>
      <div style={{ display: 'flex', gap: 9, minWidth: 0 }}>
        <ExtensionGlyph label={entry.name} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: theme.textStrong, fontSize: 12.5, fontWeight: 700 }}>{entry.name}</div>
          <div style={{ color: theme.textDim, fontSize: 10, marginTop: 2 }}>{entry.author ?? t('community author')}{entry.version ? ` · v${entry.version}` : ''}</div>
        </div>
        {entry.sha256 && <ExtensionTag verified>{t('Integrity checked')}</ExtensionTag>}
      </div>
      <div style={{ color: theme.textDim, fontSize: 10.5, lineHeight: 1.5, flex: 1 }}>{entry.description ?? t('Creative resource expansion pack')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {entry.categories.map((item) => <ExtensionTag key={item}>{t(item)}</ExtensionTag>)}
        {entry.itemCount !== undefined && <ExtensionTag>{t('{n} items', { n: entry.itemCount })}</ExtensionTag>}
        <span style={{ flex: 1 }} />
        <button type="button" disabled={disabled} onClick={install} style={{ ...secondaryButton(disabled), borderColor: !installed || hasUpdate ? theme.accent : theme.border, color: !installed || hasUpdate ? theme.textStrong : theme.textDim }}>
          {busyId === entry.id ? t('Installing…') : hasUpdate ? t('update') : installed ? t('Installed') : t('Installation')}
        </button>
      </div>
    </article>
  );
}

function DiscoverToolbar({ query, category, onQuery, onCategory }: Pick<DiscoverProps, 'query' | 'category' | 'onQuery' | 'onCategory'>) {
  const t = useT();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <span style={{ position: 'absolute', left: 8, top: 7, color: theme.textDim }}><Icon name="search" size={12} /></span>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={t('Search extensions…')}
          style={{ width: '100%', boxSizing: 'border-box', border: `0.5px solid ${theme.border}`, borderRadius: 4, background: theme.panelAlt, color: theme.text, padding: '6px 8px 6px 25px', fontSize: 11.5 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 3 }}>
        {EXTENSION_CATEGORIES.map((item) => (
          <button key={item} type="button" onClick={() => onCategory(item)} style={{ ...secondaryButton(), borderColor: category === item ? theme.accent : theme.border, color: category === item ? theme.textStrong : theme.textDim, background: category === item ? `color-mix(in srgb, ${theme.accent} 10%, transparent)` : 'transparent' }}>
            {t(item)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ExtensionDiscover(props: DiscoverProps) {
  const t = useT();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {props.showLocalInstall && <InstallPanel busy={props.busyId !== null} onInstall={(task) => props.onInstall('local', task)} />}
      <DiscoverToolbar query={props.query} category={props.category} onQuery={props.onQuery} onCategory={props.onCategory} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(245px, 1fr))', gap: 8 }}>
        {props.entries.map((entry) => (
          <RegistryCard key={entry.id} entry={entry} installed={props.packs.find((pack) => pack.id === entry.id)} busyId={props.busyId} onInstall={props.onInstall} />
        ))}
      </div>
      {!props.entries.length && <div style={{ padding: 36, textAlign: 'center', color: theme.textDim, fontSize: 11.5 }}>{t('No matching extension')}</div>}
    </div>
  );
}
