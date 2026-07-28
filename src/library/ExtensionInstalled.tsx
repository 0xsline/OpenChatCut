import { useT } from '../i18n/locale';
import type { InstalledPack } from '../plugins/store';
import { theme } from '../theme';
import { packCounts, secondaryButton } from './ExtensionCenterModel';
import { ExtensionGlyph, ExtensionTag, SourceLabel } from './ExtensionCenterParts';

interface InstalledProps {
  packs: InstalledPack[];
  busyId: string | null;
  confirmId: string | null;
  onConfirm: (id: string | null) => void;
  onToggle: (pack: InstalledPack) => void;
  onRemove: (pack: InstalledPack) => void;
}

function InstalledCard({ pack, props }: { pack: InstalledPack; props: InstalledProps }) {
  const t = useT();
  const confirming = props.confirmId === pack.id;
  const busy = props.busyId !== null;
  return (
    <article style={{ border: `0.5px solid ${theme.border}`, background: theme.panelAlt, borderRadius: 5, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12 }}>
        <ExtensionGlyph label={pack.name} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ color: theme.textStrong, fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pack.name}</span>
            <span style={{ color: theme.textDim, fontSize: 10 }}>v{pack.version}</span>
          </div>
          <div style={{ color: theme.textDim, fontSize: 10, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pack.author || t('未知作者')} · <SourceLabel pack={pack} /> · {new Date(pack.installedAt).toLocaleDateString()}</div>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: theme.textDim, fontSize: 10, whiteSpace: 'nowrap' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: pack.enabled ? theme.success : theme.textDim }} />
          {t(pack.enabled ? '已启用' : '已停用')}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: `0.5px solid ${theme.border}`, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1 }}>
          {packCounts(pack).map(([label, count]) => <ExtensionTag key={label}>{t(label)} ×{count}</ExtensionTag>)}
        </div>
        <button type="button" disabled={busy} onClick={() => props.onToggle(pack)} style={secondaryButton(busy)}>
          {t(pack.enabled ? '停用扩展' : '启用扩展')}
        </button>
        {confirming ? (
          <>
            <button type="button" disabled={busy} onClick={() => props.onRemove(pack)} style={{ ...secondaryButton(busy), color: theme.danger }}>{t('确认卸载')}</button>
            <button type="button" onClick={() => props.onConfirm(null)} style={secondaryButton()}>{t('取消')}</button>
          </>
        ) : (
          <button type="button" onClick={() => props.onConfirm(pack.id)} style={{ ...secondaryButton(), color: theme.danger }}>{t('卸载扩展')}</button>
        )}
      </div>
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
