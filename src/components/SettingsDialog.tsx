import { useEffect, useRef, useState } from 'react';
import { theme } from '../theme';
import { Icon } from './icons';
import { applyLiveCaps } from '../agent/capabilities';
import {
  SETTINGS_CATEGORIES, categoryConfiguredCount, fieldPlaceholder, groupConfigured,
  type KeyStatusResponse, type SettingsCategory, type SettingsField, type SettingsGroup,
} from './settingsSchema';

// 全局设置模态:左侧一级分类,右侧该分类下的能力组卡片。密钥值只经 POST /api/keys
// 流向 dev server(存内存 + .env.local,已 gitignore),服务端注入;GET 只回布尔,
// 因此本对话框永不回填任何服务端值。Clone-specific addition(源站无据,自定 —
// ChatCut 是托管 SaaS 后端持钥,无用户密钥面板)。
// values 语义:字段名出现在 values 里 = 有暂存改动;'' = 显式暂存清除(保存时发送,
// 后端把空串视为删除该键并从 .env.local 删行)。

const ON = '#4caf7d';   // 状态绿(沿用原面板)
const WARN = '#f77';    // 错误 / 清除警示(沿用原面板错误色)
const CLOSE_CONFIRM_MS = 2000;
const SIDEBAR_WIDTH = 176;

type Values = Record<string, string>;

function omitKey(obj: Values, name: string): Values {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== name));
}

/** '' 是显式清除,原样发送;非空值 trim 后发送;纯空白输入视为无改动(防误清)。 */
function buildPatch(values: Values): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const [name, raw] of Object.entries(values)) {
    if (raw === '') patch[name] = '';
    else if (raw.trim() !== '') patch[name] = raw.trim();
  }
  return patch;
}

function savedMessage(patch: Record<string, string>): string {
  const base = '已保存 · 工具即时生效，Agent 下一条消息即可感知';
  return 'LLM_BASE_URL' in patch ? `${base}（中转站地址需重启 dev server）` : base;
}

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

// ── 主组件 ────────────────────────────────────────────────────────────────

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { status, setStatus, loadError } = useKeyStatus();
  const [values, setValues] = useState<Values>({});
  const [activeCat, setActiveCat] = useState<string>(SETTINGS_CATEGORIES[0].key);
  const [reveal, setReveal] = useState(false);
  const { save, saving, msg, error } = useSaveKeys(values, (next) => {
    setStatus(next);
    applyLiveCaps(next.caps);
    setValues({});
  });
  const dirty = Object.keys(values).length > 0;
  const { requestClose, warn } = useCloseGuard(dirty, onClose);
  useEscape(requestClose);

  const stage = (name: string, raw: string): void =>
    setValues((prev) => (raw === '' ? omitKey(prev, name) : { ...prev, [name]: raw }));
  const toggleClear = (name: string): void =>
    setValues((prev) => (prev[name] === '' ? omitKey(prev, name) : { ...prev, [name]: '' }));

  const active = SETTINGS_CATEGORIES.find((c) => c.key === activeCat) ?? SETTINGS_CATEGORIES[0];
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
          <CategoryNav status={status} activeKey={activeCat} onSelect={setActiveCat} />
          <CategoryPane category={active} status={status} values={values} reveal={reveal}
            onStage={stage} onToggleClear={toggleClear} />
        </div>
        <FooterBar reveal={reveal} onReveal={setReveal} message={message}
          dirty={dirty} saving={saving} onClose={onClose} onSave={() => { void save(); }} />
      </div>
    </div>
  );
}

// ── 子组件 ────────────────────────────────────────────────────────────────

interface CategoryNavProps {
  status: KeyStatusResponse | null;
  activeKey: string;
  onSelect: (key: string) => void;
}

function CategoryNav({ status, activeKey, onSelect }: CategoryNavProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <nav style={sidebar}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px' }}>
        {SETTINGS_CATEGORIES.map((cat) => {
          const done = categoryConfiguredCount(status, cat);
          const total = cat.groups.length;
          return (
            <button key={cat.key} type="button" onClick={() => onSelect(cat.key)}
              onMouseEnter={() => setHovered(cat.key)} onMouseLeave={() => setHovered(null)}
              style={navItemStyle(cat.key === activeKey, hovered === cat.key)}>
              <Icon name={cat.icon} size={14} />
              <span style={navLabel}>{cat.title}</span>
              <span style={{ fontSize: 10, color: done === total && total > 0 ? ON : theme.textDim }}>{done}/{total}</span>
            </button>
          );
        })}
      </div>
      <p style={sidebarNote}>
        密钥仅存本机 <code style={code}>.env.local</code>（已 gitignore），经服务端注入，<b>不进浏览器</b>。
      </p>
    </nav>
  );
}

interface CategoryPaneProps {
  category: SettingsCategory;
  status: KeyStatusResponse | null;
  values: Values;
  reveal: boolean;
  onStage: (name: string, raw: string) => void;
  onToggleClear: (name: string) => void;
}

function CategoryPane({ category, status, values, reveal, onStage, onToggleClear }: CategoryPaneProps) {
  return (
    <div style={pane}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ color: theme.accent, display: 'inline-flex' }}><Icon name={category.icon} size={14} /></span>
        <b style={{ fontSize: 13 }}>{category.title}</b>
      </div>
      {category.groups.map((g) => (
        <GroupCard key={g.key} group={g} status={status} values={values} reveal={reveal}
          onStage={onStage} onToggleClear={onToggleClear} />
      ))}
    </div>
  );
}

interface GroupCardProps {
  group: SettingsGroup;
  status: KeyStatusResponse | null;
  values: Values;
  reveal: boolean;
  onStage: (name: string, raw: string) => void;
  onToggleClear: (name: string) => void;
}

function GroupCard({ group, status, values, reveal, onStage, onToggleClear }: GroupCardProps) {
  const on = groupConfigured(status, group);
  return (
    <section style={groupCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: on ? ON : theme.borderLight, flex: '0 0 auto' }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{group.title}</span>
        <span style={{ fontSize: 11, color: on ? ON : theme.textDim }}>{on ? '已配置' : '未配置'}</span>
      </div>
      <div style={{ fontSize: 11.5, color: theme.textDim, marginBottom: 8, paddingLeft: 15 }}>{group.hint}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingLeft: 15 }}>
        {group.fields.map((f) => {
          const st = status?.keys[f.name];
          return (
            <FieldRow key={f.name} field={f} configured={Boolean(st?.configured)} source={st?.source ?? 'none'}
              value={values[f.name]} reveal={reveal} onStage={onStage} onToggleClear={onToggleClear} />
          );
        })}
      </div>
    </section>
  );
}

interface FieldRowProps {
  field: SettingsField;
  configured: boolean;
  source: 'env' | 'runtime' | 'none';
  /** undefined = 无暂存改动;'' = 暂存清除;其余 = 暂存新值 */
  value: string | undefined;
  reveal: boolean;
  onStage: (name: string, raw: string) => void;
  onToggleClear: (name: string) => void;
}

function FieldRow({ field, configured, source, value, reveal, onStage, onToggleClear }: FieldRowProps) {
  const stagedClear = value === '';
  const inputType = field.kind === 'secret' && !reveal ? 'password' : 'text';
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={fieldHead}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          {field.label}
          {configured && <span style={sourceTag}>{source === 'env' ? '.env.local' : '本次设置'}</span>}
        </span>
        {configured && (
          <button type="button" onClick={(e) => { e.preventDefault(); onToggleClear(field.name); }}
            style={{ ...clearBtn, color: stagedClear ? WARN : theme.textDim }}>
            {stagedClear ? '取消清除' : '清除'}
          </button>
        )}
      </span>
      <input
        type={inputType} autoComplete="off" spellCheck={false}
        value={value ?? ''}
        onChange={(e) => onStage(field.name, e.target.value)}
        placeholder={fieldPlaceholder(field, configured, stagedClear)}
        style={stagedClear ? { ...input, border: `1px solid ${WARN}` } : input}
      />
      {field.note && <span style={{ fontSize: 10.5, color: theme.textDim }}>{field.note}</span>}
    </label>
  );
}

interface FooterBarProps {
  reveal: boolean;
  onReveal: (v: boolean) => void;
  message: { text: string; color: string } | null;
  dirty: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
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

function navItemStyle(active: boolean, hovered: boolean): React.CSSProperties {
  return {
    font: 'inherit', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', padding: '7px 9px', borderRadius: 6, cursor: 'pointer',
    border: 'none', borderLeft: `2px solid ${active ? theme.accent : 'transparent'}`,
    background: active || hovered ? theme.panelAlt : 'transparent',
    color: active ? theme.text : theme.textDim,
  };
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.62)', display: 'grid', placeItems: 'center',
  zIndex: 200, padding: 24, fontFamily: 'system-ui, -apple-system, sans-serif',
};
const panel: React.CSSProperties = {
  width: 'min(860px, 100%)', height: 'min(640px, 86vh)', display: 'flex', flexDirection: 'column',
  background: theme.panel, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 12,
  boxShadow: '0 24px 64px rgba(0,0,0,0.5)', overflow: 'hidden',
};
const head: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '13px 16px 13px 20px', borderBottom: `1px solid ${theme.border}`,
};
const bodyRow: React.CSSProperties = { display: 'flex', flex: 1, minHeight: 0 };
const sidebar: React.CSSProperties = {
  width: SIDEBAR_WIDTH, flex: '0 0 auto', display: 'flex', flexDirection: 'column',
  justifyContent: 'space-between', borderRight: `1px solid ${theme.border}`, overflow: 'hidden',
};
const navLabel: React.CSSProperties = {
  flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const sidebarNote: React.CSSProperties = {
  margin: 0, padding: '10px 12px', fontSize: 10.5, lineHeight: 1.6, color: theme.textDim,
  borderTop: `1px solid ${theme.border}`,
};
const pane: React.CSSProperties = {
  flex: 1, minWidth: 0, overflowY: 'auto', padding: '14px 20px 16px',
  display: 'flex', flexDirection: 'column', gap: 12,
};
const groupCard: React.CSSProperties = { background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 9, padding: '11px 13px' };
const fieldHead: React.CSSProperties = {
  fontSize: 11.5, color: theme.text, display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between',
};
const input: React.CSSProperties = {
  font: 'inherit', fontSize: 12.5, background: theme.panelAlt, color: theme.text,
  border: `1px solid ${theme.border}`, borderRadius: 6, padding: '6px 9px', width: '100%', outline: 'none',
};
const sourceTag: React.CSSProperties = { fontSize: 10, color: theme.textDim, border: `1px solid ${theme.border}`, borderRadius: 4, padding: '0 5px' };
const clearBtn: React.CSSProperties = {
  font: 'inherit', fontSize: 10.5, background: 'none', border: 'none', cursor: 'pointer',
  padding: '0 2px', flex: '0 0 auto', textDecoration: 'underline',
};
const foot: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 12px 20px', borderTop: `1px solid ${theme.border}`, background: theme.panel,
};
const footMsg: React.CSSProperties = {
  flex: 1, minWidth: 0, textAlign: 'right', fontSize: 11.5,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const revealLabel: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.textDim, cursor: 'pointer', userSelect: 'none',
};
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 4, borderRadius: 5, display: 'inline-flex' };
const btnGhost: React.CSSProperties = { font: 'inherit', fontSize: 12.5, background: 'transparent', color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 7, padding: '6px 13px', cursor: 'pointer' };
const btnPrimary: React.CSSProperties = { font: 'inherit', fontSize: 12.5, fontWeight: 600, background: theme.accent, color: '#fff', border: 'none', borderRadius: 7, padding: '6px 16px' };
const code: React.CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: 10, background: theme.panelAlt, padding: '1px 4px', borderRadius: 4 };
