import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/icons';
import type { TimelineItem, TransitionItem } from '../editor/types';
import type { SerializableFxDef } from '../gl/fx/uniforms';
import { useT } from '../i18n/locale';
import type { InstallResult } from '../plugins/install';
import { removePack, setPackEnabled } from '../plugins/store';
import { theme } from '../theme';
import { ExtensionDiscover } from './ExtensionDiscover';
import { ExtensionInstalled } from './ExtensionInstalled';
import {
  CENTER_TABS,
  parseRegistry,
  secondaryButton,
  type Category,
  type CenterTab,
  type RegistryEntry,
} from './ExtensionCenterModel';
import { ExtensionTag } from './ExtensionCenterParts';
import { PluginExport } from './PluginExport';
import { usePluginPacks } from './pluginResources';

interface ExtensionCenterProps {
  items: TimelineItem[];
  transitions: TransitionItem[];
  fxDefs: Record<string, SerializableFxDef>;
  onClose: () => void;
}

function useRegistry(query: string, category: Category): RegistryEntry[] {
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);
  useEffect(() => {
    let alive = true;
    void fetch('/plugins/index.json')
      .then((response) => (response.ok ? response.json() : []))
      .then((value) => { if (alive) setRegistry(parseRegistry(value)); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return registry.filter((entry) => {
      if (category !== '全部' && !entry.categories.includes(category)) return false;
      return !needle || `${entry.name} ${entry.description ?? ''} ${entry.author ?? ''}`.toLocaleLowerCase().includes(needle);
    });
  }, [registry, query, category]);
}

function useExtensionActions() {
  const t = useT();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const runInstall = (id: string, task: Promise<InstallResult>) => {
    setBusyId(id); setStatus(null);
    void task.then((result) => {
      setBusyId(null);
      setStatus(result.ok
        ? { ok: true, text: t('已安装「{name}」', { name: result.pack.name }) }
        : { ok: false, text: result.errors.slice(0, 3).join('；') });
    }).catch((error) => {
      setBusyId(null);
      setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
    });
  };
  const runAction = (id: string, task: Promise<void>, success: string, onSuccess?: () => void) => {
    setBusyId(id); setStatus(null);
    void task.then(() => {
      setBusyId(null); setStatus({ ok: true, text: success }); onSuccess?.();
    }).catch((error) => {
      setBusyId(null);
      setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
    });
  };
  return { busyId, status, runInstall, runAction };
}

function CenterHeader({ tab, installedCount, onTab, onClose, showLocalInstall, onLocalInstall }: {
  tab: CenterTab;
  installedCount: number;
  onTab: (tab: CenterTab) => void;
  onClose: () => void;
  showLocalInstall: boolean;
  onLocalInstall: () => void;
}) {
  const t = useT();
  return (
    <header style={{ borderBottom: `0.5px solid ${theme.border}`, padding: '11px 14px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <button type="button" onClick={onClose} aria-label={t('返回资源库')} style={{ ...secondaryButton(), padding: 4, display: 'grid', placeItems: 'center' }}><Icon name="prev" size={14} /></button>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: theme.textStrong, fontSize: 14, fontWeight: 700 }}>{t('扩展中心')}</div>
          <div style={{ color: theme.textDim, fontSize: 10.5 }}>{t('发现、管理并分享创意扩展包')}</div>
        </div>
        <span style={{ flex: 1 }} />
        <ExtensionTag verified>{t('本机共享存储')}</ExtensionTag>
        {tab === '发现' && <button type="button" onClick={onLocalInstall} style={secondaryButton()}>{t(showLocalInstall ? '收起本地安装' : '本地安装')}</button>}
      </div>
      <nav style={{ display: 'flex', gap: 18, marginTop: 11 }}>
        {CENTER_TABS.map((item) => (
          <button key={item} type="button" onClick={() => onTab(item)} style={{ background: 'none', border: 'none', borderBottom: `2px solid ${tab === item ? theme.accent : 'transparent'}`, color: tab === item ? theme.textStrong : theme.textDim, padding: '0 1px 7px', fontSize: 11.5, fontWeight: tab === item ? 650 : 500, cursor: 'pointer' }}>
            {t(item)}{item === '已安装' && installedCount > 0 ? ` ${installedCount}` : ''}
          </button>
        ))}
      </nav>
    </header>
  );
}

export function ExtensionCenter({ items, transitions, fxDefs, onClose }: ExtensionCenterProps) {
  const t = useT();
  const packs = usePluginPacks();
  const [tab, setTab] = useState<CenterTab>('发现');
  const [category, setCategory] = useState<Category>('全部');
  const [query, setQuery] = useState('');
  const [showLocalInstall, setShowLocalInstall] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const entries = useRegistry(query, category);
  const actions = useExtensionActions();
  return (
    <section style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: theme.panel }}>
      <CenterHeader tab={tab} installedCount={packs.length} onTab={setTab} onClose={onClose} showLocalInstall={showLocalInstall} onLocalInstall={() => setShowLocalInstall((value) => !value)} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {actions.status && <div style={{ marginBottom: 10, padding: '7px 9px', border: `0.5px solid ${actions.status.ok ? theme.success : theme.danger}`, borderRadius: 3, background: theme.panelAlt, color: actions.status.ok ? theme.text : theme.danger, fontSize: 11 }}>{actions.status.text}</div>}
        {tab === '发现' && <ExtensionDiscover entries={entries} packs={packs} busyId={actions.busyId} showLocalInstall={showLocalInstall} query={query} category={category} onQuery={setQuery} onCategory={setCategory} onInstall={actions.runInstall} />}
        {tab === '已安装' && (
          <ExtensionInstalled
            packs={packs}
            busyId={actions.busyId}
            expandedId={expandedId}
            confirmId={confirmId}
            onExpand={setExpandedId}
            onConfirm={setConfirmId}
            onToggle={(pack) => actions.runAction(pack.id, setPackEnabled(pack.id, !pack.enabled), pack.enabled ? t('已停用「{name}」', { name: pack.name }) : t('已启用「{name}」', { name: pack.name }))}
            onRemove={(pack) => actions.runAction(pack.id, removePack(pack.id), t('已卸载「{name}」', { name: pack.name }), () => setConfirmId(null))}
          />
        )}
        {tab === '创作' && (
          <div style={{ maxWidth: 720 }}>
            <div style={{ color: theme.textStrong, fontSize: 13, fontWeight: 700 }}>{t('创建扩展包')}</div>
            <div style={{ color: theme.textDim, fontSize: 10.5, lineHeight: 1.6, margin: '4px 0 12px' }}>{t('把当前工程中的自定义 MG、Shader 特效和转场打包分享；接收方安装后仍会经过安全校验。')}</div>
            <PluginExport items={items} transitions={transitions} fxDefs={fxDefs} defaultOpen />
          </div>
        )}
      </div>
    </section>
  );
}
