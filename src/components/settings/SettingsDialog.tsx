import { useEffect, useRef, useState } from 'react';
import { theme, themeAlpha } from '../../theme';
import { t, useT } from '../../i18n/locale';
import { Icon } from '../icons';
import { VendorIcon } from './vendorIcons';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels } from '../../agent/capabilities';
import { applyAgentModelStatus } from '../../agent/model-selection';
import { FieldRow, ON, VendorPane, WARN, type FieldCtx } from './settingsVendorPane';
import {
  SETTINGS_CATEGORIES, buildPatch, categoryGroupStats, findGroup, groupConfigured,
  isModelField, modelValue, omitKey, savedMessage, vendorConfigured,
  type KeyStatusResponse, type SettingsCategory, type SettingsField, type SettingsGroup,
  type SettingsVendorPage, type StagedValues as Values,
} from './settingsSchema';

// Global settings modal, three columns: left = "Classification → Ability" two-level collapsible tree (ability row = status point + name);
// Medium = list of manufacturers under the current capability (generating four capabilities with a "Default Vendor" route select at the top);
// Right = Select the manufacturer's configuration page (header = icon + name + configuration status, body = fields).
// The key value only flows to the dev server via POST /api/keys (stored in memory + .env.local, already gitignore),
// Server-side injection; GET only returns Boolean for secret and never backfills. The model/routing field is a non-secret configuration and the current value is
// Echoed via GET's models channel.
// values semantics: field name appearing in values = temporary changes; '' = explicit temporary clearing (sent when saving,
// The backend treats the empty string as deleting the key and deleting the row from .env.local, which means "returning to default" for the model field). Temporary baseline:
// Model field = current value of the server, the rest = '' (the echoed value is not temporarily stored, only the actual changes are entered into the values);
// values are shared globally by field name and the switching tree nodes are not cleared (MINIMAX_* instant synchronization across capability pages).
// The right column (vendor configuration page + field rendering + test connection) is in settingsVendorPane.tsx.
const CLOSE_CONFIRM_MS = 2000;
const TREE_WIDTH = 200;
const VENDOR_COL_WIDTH = 185;

// ── hooks ─────────────────────────────────────────────────────────────────

function useKeyStatus(): {
  status: KeyStatusResponse | null;
  setStatus: (s: KeyStatusResponse) => void;
  loadError: string | null;
} {
  const [status, setStatus] = useState<KeyStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/keys')
      .then((r) => r.json() as Promise<KeyStatusResponse>)
      .then((d) => { if (alive) setStatus(d); })
      .catch(() => { if (alive) setLoadError(t('Unable to read configuration (dev Service not ready? )')); });
    return () => { alive = false; };
  }, []);
  return { status, setStatus, loadError };
}

function useSaveKeys(values: Values, onSaved: (next: KeyStatusResponse) => void): {
  save: () => Promise<void>; saving: boolean; msg: string | null; error: string | null;
} {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const patch = buildPatch(values);
    if (Object.keys(patch).length === 0) { setMsg(t('no changes')); return; }
    setSaving(true); setError(null); setMsg(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({})) as Partial<KeyStatusResponse> & { error?: string };
      if (!res.ok) throw new Error(body.error || t('Save failed ({n})', { n: res.status }));
      onSaved(body as KeyStatusResponse);
      setMsg(savedMessage());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return { save, saving, msg, error };
}

/** Prevent accidental shutdown:When there are unsaved changes,Mask / Esc First time only warning,2 Triggered again within seconds before it is truly closed. */
function useCloseGuard(dirty: boolean, onClose: () => void): { requestClose: () => void; warn: string | null } {
  const [warn, setWarn] = useState<string | null>(null);
  const armedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const requestClose = (): void => {
    if (!dirty || Date.now() - armedAt.current < CLOSE_CONFIRM_MS) { onClose(); return; }
    armedAt.current = Date.now();
    setWarn(t('If there are any unsaved changes, pressing Close again will discard them.'));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setWarn(null); armedAt.current = 0; }, CLOSE_CONFIRM_MS);
  };
  return { requestClose, warn };
}

function useEscape(handler: () => void): void {
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') ref.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useHover(): [boolean, { onMouseEnter: () => void; onMouseLeave: () => void }] {
  const [hovered, setHovered] = useState(false);
  return [hovered, { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }];
}

/** Left tree ability selected + Listed manufacturers selected;When changing abilities, the middle column is reset to the first one with the ability. */
function useTreeSelection(): {
  group: SettingsGroup; page: SettingsVendorPage;
  selectGroup: (key: string) => void; selectVendor: (key: string) => void;
} {
  const first = SETTINGS_CATEGORIES[0].groups[0];
  const [groupKey, setGroupKey] = useState<string>(first.key);
  const [vendorKey, setVendorKey] = useState<string>(first.vendors[0].key);
  const group = findGroup(groupKey);
  const page = group.vendors.find((v) => v.key === vendorKey) ?? group.vendors[0];
  const selectGroup = (key: string): void => {
    setGroupKey(key);
    setVendorKey(findGroup(key).vendors[0].key);
  };
  return { group, page, selectGroup, selectVendor: setVendorKey };
}

// ── Main component ───────────────────────────────────────────────────────────

/** After saving successfully, let agent side instant perception:caps / key Boolean / model routing / LLM Interfaces and models. */
function applySavedToAgent(next: KeyStatusResponse): void {
  applyLiveCaps(next.caps);
  applyLiveKeyStatus(next.keys);
  if (next.models) applyLiveModels(next.models);
  if (next.models) applyAgentModelStatus(next.keys, next.models);
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { status, setStatus, loadError } = useKeyStatus();
  const [values, setValues] = useState<Values>({});
  const [modelOptions, setModelOptions] = useState<Record<string, readonly string[]>>({});
  const { group, page, selectGroup, selectVendor } = useTreeSelection();
  const [reveal, setReveal] = useState(false);
  const { save, saving, msg, error } = useSaveKeys(values, (next) => {
    setStatus(next);
    applySavedToAgent(next);
    setValues({});
  });
  const dirty = Object.keys(values).length > 0;
  const { requestClose, warn } = useCloseGuard(dirty, onClose);
  useEscape(requestClose);

  // Temporary storage: If there is no change relative to the baseline (model field = current value of the server, the rest = ''), the temporary storage will be cancelled.
  const stage = (field: SettingsField, raw: string): void => {
    const baseline = isModelField(field) ? modelValue(status, field.name) : '';
    setValues((prev) => raw === baseline ? omitKey(prev, field.name) : { ...prev, [field.name]: raw });
  };
  const toggleClear = (name: string): void =>
    setValues((prev) => (prev[name] === '' ? omitKey(prev, name) : { ...prev, [name]: '' }));
  const ctx: FieldCtx = {
    status,
    values,
    reveal,
    onStage: stage,
    onToggleClear: toggleClear,
    modelOptions,
    onModelsDiscovered: (name, models) => {
      setModelOptions((previous) => ({ ...previous, [name]: [...new Set(models)] }));
    },
  };

  const shownError = error ?? loadError;
  const message = shownError ? { text: shownError, color: WARN }
    : warn ? { text: warn, color: theme.gold }
      : msg ? { text: msg, color: ON } : null;

  return (
    <div style={overlay} onMouseDown={requestClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <header style={head}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: theme.accent, display: 'inline-flex' }}><Icon name="sliders" size={15} /></span>
            <b style={{ fontSize: 14 }}>{t('settings · API key')}</b>
          </div>
          <button onClick={onClose} title={t('close')} style={iconBtn}><Icon name="x" size={15} /></button>
        </header>
        <div style={bodyRow}>
          <CapabilityTree status={status} activeGroup={group.key} onSelect={selectGroup} />
          <VendorList group={group} activeVendor={page.key} onSelectVendor={selectVendor} ctx={ctx} />
          <VendorPane page={page} hint={group.hint} ctx={ctx} />
        </div>
        <FooterBar reveal={reveal} onReveal={setReveal} message={message}
          dirty={dirty} saving={saving} onClose={onClose} onSave={() => { void save(); }} />
      </div>
    </div>
  );
}

// ── Left column (categories can be folded → abilities can be selected) ─────────────────────────────────────

function CapabilityTree({ status, activeGroup, onSelect }: {
  status: KeyStatusResponse | null; activeGroup: string; onSelect: (key: string) => void;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <nav style={sidebar}>
      <div style={treeScroll}>
        {SETTINGS_CATEGORIES.map((cat) => (
          <TreeCategory key={cat.key} category={cat} status={status} open={!collapsed.has(cat.key)}
            activeGroup={activeGroup} onToggle={() => toggle(cat.key)} onSelect={onSelect} />
        ))}
      </div>
      <p style={sidebarNote}>
        {t('The key is only saved on this machine')} <code style={code}>.env.local</code>{t('(Already gitignore), injected by the server,')}<b>{t('Not entering the browser.')}</b>
      </p>
    </nav>
  );
}

interface TreeCategoryProps {
  category: SettingsCategory; status: KeyStatusResponse | null; open: boolean;
  activeGroup: string; onToggle: () => void; onSelect: (key: string) => void;
}

function TreeCategory({ category, status, open, activeGroup, onToggle, onSelect }: TreeCategoryProps) {
  const t = useT();
  const { done, total } = categoryGroupStats(status, category);
  return (
    <div>
      <button type="button" onClick={onToggle} title={open ? t('close') : t('Expand')} style={catRow}>
        <span style={{ ...chevronBox, transform: open ? 'none' : 'rotate(-90deg)' }}>
          <Icon name="chevronDown" size={12} />
        </span>
        <Icon name={category.icon} size={13} />
        <span style={navLabel}>{t(category.title)}</span>
        <span style={{ fontSize: 10, fontWeight: 400, color: done === total && total > 0 ? ON : theme.textDim }}>
          {done}/{total}
        </span>
      </button>
      {open && category.groups.map((g) => (
        <GroupRow key={g.key} title={g.title} on={groupConfigured(status, g)}
          active={g.key === activeGroup} onSelect={() => onSelect(g.key)} />
      ))}
    </div>
  );
}

function GroupRow({ title, on, active, onSelect }: {
  title: string; on: boolean; active: boolean; onSelect: () => void;
}) {
  const t = useT();
  const [hovered, hoverProps] = useHover();
  return (
    <button type="button" onClick={onSelect} {...hoverProps}
      style={{ ...navRowStyle(active, hovered), paddingLeft: 19 }}>
      <span style={dot(on)} />
      <span style={navLabel}>{t(title)}</span>
    </button>
  );
}

// ── Middle column (routing select + manufacturer list) ───────────────────────────────────────

function VendorList({ group, activeVendor, onSelectVendor, ctx }: {
  group: SettingsGroup; activeVendor: string; onSelectVendor: (key: string) => void; ctx: FieldCtx;
}) {
  return (
    <div style={vendorCol}>
      {group.route && <div style={routeBox}><FieldRow field={group.route} ctx={ctx} /></div>}
      {group.vendors.map((p) => (
        <VendorRow key={p.key} page={p} on={vendorConfigured(ctx.status, p)}
          active={p.key === activeVendor} onSelect={() => onSelectVendor(p.key)} />
      ))}
    </div>
  );
}

function VendorRow({ page, on, active, onSelect }: {
  page: SettingsVendorPage; on: boolean; active: boolean; onSelect: () => void;
}) {
  const t = useT();
  const [hovered, hoverProps] = useHover();
  return (
    <button type="button" onClick={onSelect} {...hoverProps} style={navRowStyle(active, hovered)}>
      <VendorIcon vendor={page.vendor} size={15} />
      <span style={navLabel}>{t(page.title)}</span>
      <span style={dot(on)} />
    </button>
  );
}

interface FooterBarProps {
  reveal: boolean; onReveal: (v: boolean) => void; message: { text: string; color: string } | null;
  dirty: boolean; saving: boolean; onClose: () => void; onSave: () => void;
}

function FooterBar({ reveal, onReveal, message, dirty, saving, onClose, onSave }: FooterBarProps) {
  const t = useT();
  const disabled = saving || !dirty;
  return (
    <footer style={foot}>
      <label style={revealLabel}>
        <input type="checkbox" checked={reveal} onChange={(e) => onReveal(e.target.checked)} />
        {t('Show clear text')}
      </label>
      <div style={{ ...footMsg, color: message?.color ?? ON }}>{message?.text ?? ''}</div>
      <button onClick={onClose} style={btnGhost}>{t('close')}</button>
      <button onClick={onSave} disabled={disabled}
        style={{ ...btnPrimary, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}>
        {saving ? t('Saving…') : t('save')}
      </button>
    </footer>
  );
}

// ── Style ───────────────────────────────────────────────────────────

/** Zuoshu ability line / Shared by all manufacturers in the list:Selected state accent Zuotiao + panelAlt bottom. */
function navRowStyle(active: boolean, hovered: boolean): React.CSSProperties {
  return {
    font: 'inherit', fontSize: 12, display: 'flex', alignItems: 'center', gap: 7,
    width: '100%', padding: '6px 9px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
    border: 'none', borderLeft: `2px solid ${active ? theme.accent : 'transparent'}`,
    background: active || hovered ? theme.panelAlt : 'transparent',
    color: active ? theme.text : theme.textDim,
  };
}

function dot(on: boolean): React.CSSProperties {
  return { width: 7, height: 7, borderRadius: '50%', background: on ? ON : theme.borderLight, flex: '0 0 auto' };
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: themeAlpha.shadow(0.62), display: 'grid', placeItems: 'center',
  zIndex: 200, padding: 24, fontFamily: 'system-ui, -apple-system, sans-serif',
};
const panel: React.CSSProperties = {
  width: 'min(940px, 100%)', height: 'min(640px, 86vh)', display: 'flex', flexDirection: 'column',
    background: theme.panel, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 6,
  boxShadow: `0 24px 64px ${themeAlpha.shadow(0.5)}`, overflow: 'hidden',
};
const head: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px 13px 20px', borderBottom: `0.5px solid ${theme.border}`,
};
const bodyRow: React.CSSProperties = { display: 'flex', flex: 1, minHeight: 0 };
const sidebar: React.CSSProperties = {
  width: TREE_WIDTH, flex: '0 0 auto', display: 'flex', flexDirection: 'column',
  borderRight: `0.5px solid ${theme.border}`, overflow: 'hidden',
};
const treeScroll: React.CSSProperties = {
  flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px',
};
const catRow: React.CSSProperties = {
  font: 'inherit', fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
  width: '100%', padding: '7px 9px 7px 7px', borderRadius: 6, cursor: 'pointer',
  border: 'none', background: 'transparent', color: theme.text,
};
const chevronBox: React.CSSProperties = { display: 'inline-flex', color: theme.textDim, transition: 'transform 0.15s', flex: '0 0 auto' };
const navLabel: React.CSSProperties = {
  flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const sidebarNote: React.CSSProperties = {
  margin: 0, padding: '10px 12px', fontSize: 10.5, lineHeight: 1.6, color: theme.textDim, borderTop: `0.5px solid ${theme.border}`,
};
const vendorCol: React.CSSProperties = {
  width: VENDOR_COL_WIDTH, flex: '0 0 auto', minHeight: 0, overflowY: 'auto',
  display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px', borderRight: `0.5px solid ${theme.border}`,
};
const routeBox: React.CSSProperties = { padding: '0 2px 10px', marginBottom: 6, borderBottom: `0.5px solid ${theme.border}` };
const foot: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 12px 20px', borderTop: `0.5px solid ${theme.border}`, background: theme.panel,
};
const footMsg: React.CSSProperties = {
  flex: 1, minWidth: 0, textAlign: 'right', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const revealLabel: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.textDim, cursor: 'pointer', userSelect: 'none',
};
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 4, borderRadius: 5, display: 'inline-flex' };
  const btnGhost: React.CSSProperties = { font: 'inherit', fontSize: 12.5, background: 'transparent', color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '6px 13px', cursor: 'pointer' };
  const btnPrimary: React.CSSProperties = { font: 'inherit', fontSize: 12.5, fontWeight: 600, background: theme.accent, color: theme.onAccent, border: 'none', borderRadius: 4, padding: '6px 16px' };
const code: React.CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: 10, background: theme.panelAlt, padding: '1px 4px', borderRadius: 4 };
