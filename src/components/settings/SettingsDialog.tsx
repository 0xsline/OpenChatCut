import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { theme, themeAlpha } from '../../theme';
import { t, useT } from '../../i18n/locale';
import { Icon } from '../icons';
import { VendorIcon } from './vendorIcons';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels } from '../../agent/capabilities';
import { applyAgentModelStatus } from '../../agent/model-selection';
import { FieldRow, ON, VendorPane, WARN, type FieldCtx } from './settingsVendorPane';
import { useCodexSettings } from './useCodexSettings';
import type { CodexAgentStatus } from '../../../shared/codex-agent';
import { stageFieldValue } from './codexReasoning';
import { SettingsVersionControl } from './SettingsVersionControl';
import {
  CURRENT_APP_VERSION,
  formatDisplayVersion,
  getUpstreamUpdateState,
  requestUpstreamUpdateCheck,
  subscribeUpstreamUpdate,
} from '../../ui/upstreamUpdate';
import {
  SETTINGS_CATEGORIES, buildPatch, categoryGroupStats, findGroup, groupConfigured,
  modelValue, omitKey, savedMessage, vendorConfigured,
  type KeyStatusResponse, type SettingsCategory, type SettingsField, type SettingsGroup,
  type SettingsVendorPage, type StagedValues as Values,
} from './settingsSchema';

// Global settings modal, three columns: left = "Classification → Capability" two-level collapsible tree (capability row = status indicator + name);
// Center = list of providers under the current capability (generating four capabilities with a "default provider" route select at the top);
// Right = Select the provider's configuration page (header = icon + name + configuration status, body = fields).
// The key value only flows to the dev server via POST /api/keys (stored in memory + .env.local, already gitignore),
// Server-side injection; GET only returns Boolean for secret, never backfills. The model/routing field is a non-secret configuration and the current value is
// Echoed through GET's models channel.
// values semantics: field name appearing in values = temporary changes; '' = explicit temporary clearing (sent when saving,
// The backend treats the empty string as deleting the key and deletes the row from .env.local, which means "return to default" for the model field). Temporary baseline:
// Model field = current value on the server, the rest = '' (the echoed value is not temporarily stored, only the actual changes are entered into the values);
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
      .catch(() => { if (alive) setLoadError(t('无法读取配置（dev 服务未就绪？）')); });
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
    if (Object.keys(patch).length === 0) { setMsg(t('没有改动')); return; }
    setSaving(true); setError(null); setMsg(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({})) as Partial<KeyStatusResponse> & { error?: string };
      if (!res.ok) throw new Error(body.error || t('保存失败 ({n})', { n: res.status }));
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

/** Anti-accidental closing: When there are unsaved changes, Mask/Esc will only warn you for the first time, and it will be truly closed when triggered again within 2 seconds. */
function useCloseGuard(dirty: boolean, onClose: () => void): { requestClose: () => void; warn: string | null } {
  const [warn, setWarn] = useState<string | null>(null);
  const armedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const requestClose = (): void => {
    if (!dirty || Date.now() - armedAt.current < CLOSE_CONFIRM_MS) { onClose(); return; }
    armedAt.current = Date.now();
    setWarn(t('有未保存改动，再按一次关闭将丢弃'));
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

/** The left tree capability is selected + the middle column provider is selected; when changing capabilities, the middle column is reset to the first provider with the capability. */
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

/** After successful saving, let the agent side immediately perceive: caps / key Boolean / model routing / LLM interface and model. */
function applySavedToAgent(next: KeyStatusResponse): void {
  applyLiveCaps(next.caps);
  applyLiveKeyStatus(next.keys);
  if (next.models) applyLiveModels(next.models);
  if (next.models) applyAgentModelStatus(next.keys, next.models);
}


function useFieldContext(
  status: KeyStatusResponse | null,
  values: Values,
  setValues: React.Dispatch<React.SetStateAction<Values>>,
  reveal: boolean,
): FieldCtx {
  const [modelOptions, setModelOptions] = useState<Record<string, readonly string[]>>({});
  const [autoClearedEffort, setAutoClearedEffort] = useState<string | null>(null);
  const codex = useCodexSettings(
    modelValue(status, 'CODEX_MODEL'),
    modelValue(status, 'CODEX_REASONING_EFFORT'),
  );
  const onStage = (field: SettingsField, raw: string): void => {
    const staged = stageFieldValue(values, field, raw, status, codex.models, autoClearedEffort);
    setValues(staged.values);
    setAutoClearedEffort(staged.autoClearedEffort);
  };
  useEffect(() => {
    if (!('CODEX_MODEL' in values) && !('CODEX_REASONING_EFFORT' in values)) {
      setAutoClearedEffort(null);
    }
  }, [values]);
  const onToggleClear = (field: SettingsField): void => {
    if (field.name === 'CODEX_MODEL') {
      onStage(field, values[field.name] === '' ? modelValue(status, field.name) : '');
      return;
    }
    setValues((previous) => previous[field.name] === ''
      ? omitKey(previous, field.name)
      : { ...previous, [field.name]: '' });
  };
  return {
    status, values, reveal, onStage, onToggleClear, modelOptions, codex,
    onModelsDiscovered: (name, models) => {
      setModelOptions((previous) => ({ ...previous, [name]: [...new Set(models)] }));
    },
  };
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const updateState = useSyncExternalStore(
    subscribeUpstreamUpdate,
    getUpstreamUpdateState,
    getUpstreamUpdateState,
  );
  const { status, setStatus, loadError } = useKeyStatus();
  const [values, setValues] = useState<Values>({});
  const { group, page, selectGroup, selectVendor } = useTreeSelection();
  const [reveal, setReveal] = useState(false);
  const ctx = useFieldContext(status, values, setValues, reveal);
  const { save, saving, msg, error } = useSaveKeys(values, (next) => {
    setStatus(next);
    applySavedToAgent(next);
    setValues({});
  });
  const dirty = Object.keys(values).length > 0;
  const { requestClose, warn } = useCloseGuard(dirty, onClose);
  useEscape(requestClose);

  const codexStatus = ctx.codex.status;

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
            <b style={{ fontSize: 14 }}>{t('设置 · API 密钥')}</b>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <SettingsVersionControl
              versionLabel={t('当前版本号：{version}', { version: formatDisplayVersion(CURRENT_APP_VERSION) })}
              checkLabel={t('检查更新')}
              checkingLabel={t('检查中…')}
              checking={updateState.phase === 'checking'}
              onCheck={() => { void requestUpstreamUpdateCheck('manual'); }}
            />
            <button type="button" onClick={requestClose} title={t('关闭')} style={iconBtn}><Icon name="x" size={15} /></button>
          </div>
        </header>
        <div style={bodyRow}>
          <CapabilityTree status={status} codexStatus={codexStatus} activeGroup={group.key} onSelect={selectGroup} />
          <VendorList group={group} activeVendor={page.key} onSelectVendor={selectVendor} ctx={ctx} />
          <VendorPane page={page} hint={group.hint} ctx={ctx} />
        </div>
        <FooterBar reveal={reveal} onReveal={setReveal} message={message}
          dirty={dirty} saving={saving} onClose={onClose} onSave={() => { void save(); }} />
      </div>
    </div>
  );
}

// ── Left column (categories can be folded → capabilities can be selected) ──────────────────────────────────────

function CapabilityTree({ status, codexStatus, activeGroup, onSelect }: {
  status: KeyStatusResponse | null; codexStatus: CodexAgentStatus | null;
  activeGroup: string; onSelect: (key: string) => void;
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
          <TreeCategory key={cat.key} category={cat} status={status} codexStatus={codexStatus}
            open={!collapsed.has(cat.key)} activeGroup={activeGroup}
            onToggle={() => toggle(cat.key)} onSelect={onSelect} />
        ))}
      </div>
      <p style={sidebarNote}>
        {t('密钥仅存本机')} <code style={code}>.env.local</code>{t('（已 gitignore），经服务端注入，')}<b>{t('不进浏览器。')}</b>
      </p>
    </nav>
  );
}

interface TreeCategoryProps {
  category: SettingsCategory; status: KeyStatusResponse | null; codexStatus: CodexAgentStatus | null;
  open: boolean; activeGroup: string; onToggle: () => void; onSelect: (key: string) => void;
}

function TreeCategory({ category, status, codexStatus, open, activeGroup, onToggle, onSelect }: TreeCategoryProps) {
  const t = useT();
  const { done, total } = categoryGroupStats(status, category, codexStatus);
  return (
    <div>
      <button type="button" onClick={onToggle} title={open ? t('收起') : t('展开')} style={catRow}>
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
        <GroupRow key={g.key} title={g.title} on={groupConfigured(status, g, codexStatus)}
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

// ── Middle column (route select + provider list) ────────────────────────────────────────

function VendorList({ group, activeVendor, onSelectVendor, ctx }: {
  group: SettingsGroup; activeVendor: string; onSelectVendor: (key: string) => void; ctx: FieldCtx;
}) {
  return (
    <div style={vendorCol}>
      {group.route && <div style={routeBox}><FieldRow field={group.route} ctx={ctx} /></div>}
      {group.vendors.map((p) => (
        <VendorRow key={p.key} page={p} on={vendorConfigured(ctx.status, p, ctx.codex.status)}
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
        {t('显示明文')}
      </label>
      <a href="/fonts/LICENSES.md" target="_blank" rel="noopener noreferrer" style={licenseLink}>
        {t('第三方字体许可')}
      </a>
      <div style={{ ...footMsg, color: message?.color ?? ON }}>{message?.text ?? ''}</div>
      <button type="button" onClick={onClose} style={btnGhost}>{t('关闭')}</button>
      <button type="button" onClick={onSave} disabled={disabled}
        style={{ ...btnPrimary, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}>
        {saving ? t('保存中…') : t('保存')}
      </button>
    </footer>
  );
}

// ── style ───────────────────────────────────────────────────────────

/** Shared by left tree capability row/middle column provider row: selected accent left bar + panelAlt bottom. */
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
const licenseLink: React.CSSProperties = {
  color: theme.textDim, fontSize: 11.5, textDecoration: 'underline', textUnderlineOffset: 2,
};
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 4, borderRadius: 5, display: 'inline-flex' };
  const btnGhost: React.CSSProperties = { font: 'inherit', fontSize: 12.5, background: 'transparent', color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '6px 13px', cursor: 'pointer' };
  const btnPrimary: React.CSSProperties = { font: 'inherit', fontSize: 12.5, fontWeight: 600, background: theme.accent, color: theme.onAccent, border: 'none', borderRadius: 4, padding: '6px 16px' };
const code: React.CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: 10, background: theme.panelAlt, padding: '1px 4px', borderRadius: 4 };
