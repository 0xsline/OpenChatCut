import { useEffect, useRef, useState } from 'react';
import { theme } from '../theme';
import { Icon } from './icons';
import { VendorIcon } from './vendorIcons';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels } from '../agent/capabilities';
import { setLlmModel } from '../agent/client';
import {
  SETTINGS_CATEGORIES, buildPatch, categoryGroupStats, fieldPlaceholder, findGroup, groupConfigured,
  isModelField, modelValue, omitKey, savedMessage, selectOptionLabel, selectOptions, vendorConfigured,
  type KeyStatusResponse, type SettingsCategory, type SettingsField, type SettingsGroup,
  type SettingsVendorPage, type StagedValues as Values,
} from './settingsSchema';

// 全局设置模态,三栏:左 =「分类 → 能力」两级可折叠树(能力行 = 状态点 + 名);
// 中 = 当前能力下的厂商列表(生成四能力顶部带「默认厂商」路由 select);
// 右 = 选中厂商的配置页(头 = 图标 + 名称 + 配置状态,体 = 字段)。
// 密钥值只经 POST /api/keys 流向 dev server(存内存 + .env.local,已 gitignore),
// 服务端注入;GET 对 secret 只回布尔,永不回填。模型 / 路由字段是非密配置,当前值
// 经 GET 的 models 通道回显。Clone-specific addition(源站无据,自定 — ChatCut 是
// 托管 SaaS 后端持钥,无用户密钥面板)。
// values 语义:字段名出现在 values 里 = 有暂存改动;'' = 显式暂存清除(保存时发送,
// 后端把空串视为删除该键并从 .env.local 删行,对模型字段即「回到默认」)。暂存基线:
// 模型字段 = 服务端当前值,其余 = ''(回显值不算暂存,只有真实改动进 values);
// values 按字段名全局共享且切换树节点不清空(MINIMAX_* 跨能力页即时同步)。
const ON = '#4caf7d';   // 状态绿(沿用原面板)
const WARN = '#f77';    // 错误 / 清除警示(沿用原面板错误色)
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
      .catch(() => { if (alive) setLoadError('无法读取配置（dev 服务未就绪？）'); });
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
    if (Object.keys(patch).length === 0) { setMsg('没有改动'); return; }
    setSaving(true); setError(null); setMsg(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({})) as Partial<KeyStatusResponse> & { error?: string };
      if (!res.ok) throw new Error(body.error || `保存失败 (${res.status})`);
      onSaved(body as KeyStatusResponse);
      setMsg(savedMessage(patch));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return { save, saving, msg, error };
}

/** 防误关:有未保存改动时,遮罩 / Esc 第一次只警示,2 秒内再次触发才真正关闭。 */
function useCloseGuard(dirty: boolean, onClose: () => void): { requestClose: () => void; warn: string | null } {
  const [warn, setWarn] = useState<string | null>(null);
  const armedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const requestClose = (): void => {
    if (!dirty || Date.now() - armedAt.current < CLOSE_CONFIRM_MS) { onClose(); return; }
    armedAt.current = Date.now();
    setWarn('有未保存改动，再按一次关闭将丢弃');
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

/** 左树能力选中 + 中列厂商选中;切能力时中列重置为该能力第一家。 */
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

// ── 主组件 ────────────────────────────────────────────────────────────────

/** 保存成功后让 agent 侧即时感知:caps / key 布尔(厂商粒度 manifest)/ 模型路由 / LLM 模型。 */
function applySavedToAgent(next: KeyStatusResponse): void {
  applyLiveCaps(next.caps);
  applyLiveKeyStatus(next.keys);
  if (next.models) applyLiveModels(next.models);
  if (next.models?.LLM_MODEL !== undefined) setLlmModel(next.models.LLM_MODEL);  // '' = 回默认
}

/** 字段渲染共享上下文:服务端状态 + 暂存 + 明文开关 + 暂存/清除回调。 */
interface FieldCtx {
  status: KeyStatusResponse | null;
  values: Values;
  reveal: boolean;
  onStage: (field: SettingsField, raw: string) => void;
  onToggleClear: (name: string) => void;
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { status, setStatus, loadError } = useKeyStatus();
  const [values, setValues] = useState<Values>({});
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

  // 暂存:相对基线(模型字段 = 服务端当前值,其余 = '')无变化即撤销暂存。
  const stage = (field: SettingsField, raw: string): void => {
    const baseline = isModelField(field) ? modelValue(status, field.name) : '';
    setValues((prev) => (raw === baseline ? omitKey(prev, field.name) : { ...prev, [field.name]: raw }));
  };
  const toggleClear = (name: string): void =>
    setValues((prev) => (prev[name] === '' ? omitKey(prev, name) : { ...prev, [name]: '' }));
  const ctx: FieldCtx = { status, values, reveal, onStage: stage, onToggleClear: toggleClear };

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
            <b style={{ fontSize: 14 }}>设置 · API 密钥</b>
          </div>
          <button onClick={onClose} title="关闭" style={iconBtn}><Icon name="x" size={15} /></button>
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

// ── 左栏(分类可折叠 → 能力可选中) ───────────────────────────────────────

function CapabilityTree({ status, activeGroup, onSelect }: {
  status: KeyStatusResponse | null; activeGroup: string; onSelect: (key: string) => void;
}) {
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
        密钥仅存本机 <code style={code}>.env.local</code>（已 gitignore），经服务端注入，<b>不进浏览器</b>。
      </p>
    </nav>
  );
}

interface TreeCategoryProps {
  category: SettingsCategory; status: KeyStatusResponse | null; open: boolean;
  activeGroup: string; onToggle: () => void; onSelect: (key: string) => void;
}

function TreeCategory({ category, status, open, activeGroup, onToggle, onSelect }: TreeCategoryProps) {
  const { done, total } = categoryGroupStats(status, category);
  return (
    <div>
      <button type="button" onClick={onToggle} title={open ? '收起' : '展开'} style={catRow}>
        <span style={{ ...chevronBox, transform: open ? 'none' : 'rotate(-90deg)' }}>
          <Icon name="chevronDown" size={12} />
        </span>
        <Icon name={category.icon} size={13} />
        <span style={navLabel}>{category.title}</span>
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
  const [hovered, hoverProps] = useHover();
  return (
    <button type="button" onClick={onSelect} {...hoverProps}
      style={{ ...navRowStyle(active, hovered), paddingLeft: 19 }}>
      <span style={dot(on)} />
      <span style={navLabel}>{title}</span>
    </button>
  );
}

// ── 中栏(路由 select + 厂商列表) ─────────────────────────────────────────

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
  const [hovered, hoverProps] = useHover();
  return (
    <button type="button" onClick={onSelect} {...hoverProps} style={navRowStyle(active, hovered)}>
      <VendorIcon vendor={page.vendor} size={15} />
      <span style={navLabel}>{page.title}</span>
      <span style={dot(on)} />
    </button>
  );
}

// ── 右栏(厂商配置页:头 + 字段卡) ────────────────────────────────────────

function VendorPane({ page, hint, ctx }: {
  page: SettingsVendorPage; hint: string; ctx: FieldCtx;
}) {
  const on = vendorConfigured(ctx.status, page);
  return (
    <div style={pane}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <VendorIcon vendor={page.vendor} size={18} />
          <b style={{ fontSize: 13 }}>{page.title}</b>
          <span style={{ fontSize: 11, color: on ? ON : theme.textDim }}>{on ? '已配置' : '未配置'}</span>
        </div>
        <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 3, paddingLeft: 26 }}>{hint}</div>
      </div>
      <section style={fieldCardBox}>
        {page.note && <div style={pageNote}>{page.note}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: page.note ? 9 : 0 }}>
          {page.fields.map((f) => <FieldRow key={f.name} field={f} ctx={ctx} />)}
        </div>
      </section>
    </div>
  );
}

function FieldRow({ field, ctx }: { field: SettingsField; ctx: FieldCtx }) {
  const { status, reveal, onStage, onToggleClear } = ctx;
  // value: undefined = 无暂存改动;'' = 暂存清除 / 回默认;其余 = 暂存新值。
  const value = ctx.values[field.name];
  const st = status?.keys[field.name];
  const configured = Boolean(st?.configured);
  const stagedClear = value === '';
  // 模型 / 路由字段回显服务端当前值;secret / base url 永不回填。
  const shown = value ?? (isModelField(field) ? modelValue(status, field.name) : '');
  const clearable = configured && field.kind !== 'select';  // select 用「默认」选项即清除
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={fieldHead}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          {field.label}
          {configured && <span style={sourceTag}>{st?.source === 'env' ? '.env.local' : '本次设置'}</span>}
        </span>
        {clearable && (
          <button type="button" onClick={(e) => { e.preventDefault(); onToggleClear(field.name); }}
            style={{ ...clearBtn, color: stagedClear ? WARN : theme.textDim }}>
            {stagedClear ? '取消清除' : '清除'}
          </button>
        )}
      </span>
      {field.kind === 'select'
        ? <SelectInput field={field} status={status} shown={shown} onStage={onStage} />
        : <TextInput field={field} shown={shown} reveal={reveal} configured={configured}
            stagedClear={stagedClear} onStage={onStage} />}
      {field.note && <span style={{ fontSize: 10.5, color: theme.textDim }}>{field.note}</span>}
    </label>
  );
}

interface TextInputProps {
  field: SettingsField; shown: string; reveal: boolean; configured: boolean; stagedClear: boolean;
  onStage: (field: SettingsField, raw: string) => void;
}

function TextInput({ field, shown, reveal, configured, stagedClear, onStage }: TextInputProps) {
  const listId = field.kind === 'text' && field.options ? `cc-dl-${field.name}` : undefined;
  return (
    <>
      <input
        type={field.kind === 'secret' && !reveal ? 'password' : 'text'}
        autoComplete="off" spellCheck={false} list={listId}
        value={shown}
        onChange={(e) => onStage(field, e.target.value)}
        placeholder={fieldPlaceholder(field, configured, stagedClear)}
        style={stagedClear ? { ...input, border: `1px solid ${WARN}` } : input}
      />
      {listId && (
        <datalist id={listId}>
          {field.options?.map((o) => <option key={o.value} value={o.value} />)}
        </datalist>
      )}
    </>
  );
}

function SelectInput({ field, status, shown, onStage }: {
  field: SettingsField; status: KeyStatusResponse | null; shown: string;
  onStage: (field: SettingsField, raw: string) => void;
}) {
  const opts = selectOptions(field);
  const unknown = shown !== '' && !opts.some((o) => o.value === shown);  // 手改 .env.local 的值也如实显示
  return (
    <select value={shown} onChange={(e) => onStage(field, e.target.value)} style={select}>
      {unknown && <option value={shown}>{shown}</option>}
      {opts.map((o) => (
        <option key={o.value} value={o.value}>{selectOptionLabel(status, field, o)}</option>
      ))}
    </select>
  );
}

interface FooterBarProps {
  reveal: boolean; onReveal: (v: boolean) => void; message: { text: string; color: string } | null;
  dirty: boolean; saving: boolean; onClose: () => void; onSave: () => void;
}

function FooterBar({ reveal, onReveal, message, dirty, saving, onClose, onSave }: FooterBarProps) {
  const disabled = saving || !dirty;
  return (
    <footer style={foot}>
      <label style={revealLabel}>
        <input type="checkbox" checked={reveal} onChange={(e) => onReveal(e.target.checked)} />
        显示明文
      </label>
      <div style={{ ...footMsg, color: message?.color ?? ON }}>{message?.text ?? ''}</div>
      <button onClick={onClose} style={btnGhost}>关闭</button>
      <button onClick={onSave} disabled={disabled}
        style={{ ...btnPrimary, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}>
        {saving ? '保存中…' : '保存'}
      </button>
    </footer>
  );
}

// ── 样式 ─────────────────────────────────────────────────────────────────

/** 左树能力行 / 中列厂商行共用:选中态 accent 左条 + panelAlt 底。 */
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
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.62)', display: 'grid', placeItems: 'center',
  zIndex: 200, padding: 24, fontFamily: 'system-ui, -apple-system, sans-serif',
};
const panel: React.CSSProperties = {
  width: 'min(940px, 100%)', height: 'min(640px, 86vh)', display: 'flex', flexDirection: 'column',
  background: theme.panel, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 12,
  boxShadow: '0 24px 64px rgba(0,0,0,0.5)', overflow: 'hidden',
};
const head: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px 13px 20px', borderBottom: `1px solid ${theme.border}`,
};
const bodyRow: React.CSSProperties = { display: 'flex', flex: 1, minHeight: 0 };
const sidebar: React.CSSProperties = {
  width: TREE_WIDTH, flex: '0 0 auto', display: 'flex', flexDirection: 'column',
  borderRight: `1px solid ${theme.border}`, overflow: 'hidden',
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
  margin: 0, padding: '10px 12px', fontSize: 10.5, lineHeight: 1.6, color: theme.textDim, borderTop: `1px solid ${theme.border}`,
};
const vendorCol: React.CSSProperties = {
  width: VENDOR_COL_WIDTH, flex: '0 0 auto', minHeight: 0, overflowY: 'auto',
  display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px', borderRight: `1px solid ${theme.border}`,
};
const routeBox: React.CSSProperties = { padding: '0 2px 10px', marginBottom: 6, borderBottom: `1px solid ${theme.border}` };
const pane: React.CSSProperties = {
  flex: 1, minWidth: 0, overflowY: 'auto', padding: '14px 20px 16px', display: 'flex', flexDirection: 'column', gap: 12,
};
const fieldCardBox: React.CSSProperties = { background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 9, padding: '11px 13px' };
const pageNote: React.CSSProperties = { fontSize: 10.5, color: theme.textDim };
const fieldHead: React.CSSProperties = {
  fontSize: 11.5, color: theme.text, display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between',
};
const input: React.CSSProperties = {
  font: 'inherit', fontSize: 12.5, background: theme.panelAlt, color: theme.text,
  border: `1px solid ${theme.border}`, borderRadius: 6, padding: '6px 9px', width: '100%', outline: 'none',
};
const select: React.CSSProperties = { ...input, cursor: 'pointer', colorScheme: 'dark' };
const sourceTag: React.CSSProperties = { fontSize: 10, color: theme.textDim, border: `1px solid ${theme.border}`, borderRadius: 4, padding: '0 5px' };
const clearBtn: React.CSSProperties = {
  font: 'inherit', fontSize: 10.5, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', flex: '0 0 auto', textDecoration: 'underline',
};
const foot: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 12px 20px', borderTop: `1px solid ${theme.border}`, background: theme.panel,
};
const footMsg: React.CSSProperties = {
  flex: 1, minWidth: 0, textAlign: 'right', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const revealLabel: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.textDim, cursor: 'pointer', userSelect: 'none',
};
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 4, borderRadius: 5, display: 'inline-flex' };
const btnGhost: React.CSSProperties = { font: 'inherit', fontSize: 12.5, background: 'transparent', color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 7, padding: '6px 13px', cursor: 'pointer' };
const btnPrimary: React.CSSProperties = { font: 'inherit', fontSize: 12.5, fontWeight: 600, background: theme.accent, color: '#fff', border: 'none', borderRadius: 7, padding: '6px 16px' };
const code: React.CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: 10, background: theme.panelAlt, padding: '1px 4px', borderRadius: 4 };
