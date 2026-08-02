import { useT } from '../i18n/locale';
import type { InstalledPack } from '../plugins/store';
import { theme } from '../theme';
import { EXTENSION_TYPE_LABEL, packCounts, secondaryButton } from './ExtensionCenterModel';
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

function PackDetails({ pack, props }: { pack: InstalledPack; props: InstalledProps }) {
  const t = useT();
  const confirming = props.confirmId === pack.id;
  const busy = props.busyId !== null;
  return (
    <div style={{ borderTop: `0.5px solid ${theme.border}`, padding: '9px 11px 11px' }}>
      {pack.description && (
        <div style={{ color: theme.textDim, fontSize: 10.5, lineHeight: 1.5, marginBottom: 8 }}>
          {pack.description}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 4 }}>
        {pack.items.map((item) => (
          <div key={`${item.type}:${item.id}`} style={{ border: `0.5px solid ${theme.border}`, padding: '5px 7px', color: theme.text, fontSize: 10.5, borderRadius: 3 }}>
            <span style={{ color: theme.textDim }}>{t(EXTENSION_TYPE_LABEL[item.type] ?? item.type)} · </span>
            {item.name}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 9 }}>
        {confirming ? (
          <>
            <button type="button" disabled={busy} onClick={() => props.onRemove(pack)} style={{ ...secondaryButton(busy), color: theme.danger }}>{t('确认卸载')}</button>
            <button type="button" onClick={() => props.onConfirm(null)} style={secondaryButton()}>{t('取消')}</button>
          </>
        ) : (
          <button type="button" onClick={() => props.onConfirm(pack.id)} style={{ ...secondaryButton(), color: theme.danger }}>{t('卸载')}</button>
        )}
      </div>
    </div>
  );
}

function InstalledCard({ pack, props }: { pack: InstalledPack; props: InstalledProps }) {
  const t = useT();
  const expanded = props.expandedId === pack.id;
  const busy = props.busyId !== null;
  return (
    <article style={{ border: `0.5px solid ${theme.border}`, background: theme.panelAlt, borderRadius: 5, overflow: 'hidden', opacity: pack.enabled ? 1 : 0.72 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: '8px 10px', padding: 12 }}>
        <ExtensionGlyph label={pack.name} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ color: theme.textStrong, fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pack.name}</span>
            <span style={{ color: theme.textDim, fontSize: 10, whiteSpace: 'nowrap' }}>v{pack.version}</span>
          </div>
          <div style={{ color: theme.textDim, fontSize: 10, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pack.author || t('未知作者')} · <SourceLabel pack={pack} /> · {new Date(pack.installedAt).toLocaleDateString()}</div>
        </div>
        <ExtensionToggle checked={pack.enabled} disabled={busy} onChange={() => props.onToggle(pack)} />
        <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: '1 1 160px' }}>
            {packCounts(pack).map(([label, count]) => <ExtensionTag key={label}>{t(label)} ×{count}</ExtensionTag>)}
          </div>
          <span style={{ color: theme.textDim, fontSize: 10, whiteSpace: 'nowrap' }}>{t(pack.enabled ? '已启用' : '已停用')}</span>
          <button type="button" onClick={() => props.onExpand(expanded ? null : pack.id)} aria-expanded={expanded} style={secondaryButton()}>
            {t(expanded ? '收起' : '查看内容')}
          </button>
        </div>
      </div>
      {expanded && <PackDetails pack={pack} props={props} />}
    </article>
  );
}

export function ExtensionInstalled(props: InstalledProps) {
  const t = useT();
  if (!props.packs.length) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{ color: theme.text, fontSize: 12, fontWeight: 650 }}>{t('还没有安装扩展')}</div>
        <div style={{ color: theme.textDim, fontSize: 10.5, marginTop: 5 }}>{t('去“发现”安装扩展，内容会自动进入对应资源分类。')}</div>
      </div>
    );
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>{props.packs.map((pack) => <InstalledCard key={pack.id} pack={pack} props={props} />)}</div>;
}
