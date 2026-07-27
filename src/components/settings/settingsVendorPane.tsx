// 设置面板右栏:选中厂商的配置页(头 + 字段卡 + 测试连接行)与字段渲染件。
// 从 SettingsDialog.tsx 拆出(500 行上限);布局壳与左/中栏仍在那边。
// 「测试连接」走 POST /api/keys/test:把本页未保存的暂存值作为 overrides 一并
// 送去服务端探测(仅本次生效,不落盘),密钥值永远不会出现在响应里。
import { useEffect, useRef, useState } from 'react';
import { theme, themeAlpha } from '../../theme';
import { useT } from '../../i18n/locale';
import { VendorIcon } from './vendorIcons';
import {
  fieldPlaceholder, isModelField, modelValue, selectOptionLabel, selectOptions, vendorConfigured,
  type KeySlotStatus, type KeyStatusResponse, type PoolStatus, type SettingsField,
  type SettingsVendorPage, type StagedValues as Values,
} from './settingsSchema';

export const ON = theme.success; // 状态绿 → 语义令牌(石墨值≈原 #4caf7d,浅肤自动换深绿)
export const WARN = '#f77';    // 错误 / 清除警示(沿用原面板错误色)

/** 字段渲染共享上下文:服务端状态 + 暂存 + 明文开关 + 暂存/清除回调。 */
export interface FieldCtx {
  status: KeyStatusResponse | null;
  values: Values;
  reveal: boolean;
  onStage: (field: SettingsField, raw: string) => void;
  onToggleClear: (name: string) => void;
  modelOptions: Record<string, readonly string[]>;
  onModelsDiscovered: (name: string, models: readonly string[]) => void;
}

// ── 厂商配置页 ────────────────────────────────────────────────────────────

export function VendorPane({ page, hint, ctx }: {
  page: SettingsVendorPage; hint: string; ctx: FieldCtx;
}) {
  const t = useT();
  const on = vendorConfigured(ctx.status, page);
  return (
    <div style={pane}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <VendorIcon vendor={page.vendor} size={18} />
          <b style={{ fontSize: 13 }}>{t(page.title)}</b>
          {/* kikivoice has no key field (cookie-free); its configured state is shown by the
              KikiConnectButton badge below, so hide this key-based "configured/not" tag here. */}
          {page.key !== 'voice/kikivoice' && (
            <span style={{ fontSize: 11, color: on ? ON : theme.textDim }}>{on ? t('已配置') : t('未配置')}</span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 3, paddingLeft: 26 }}>{t(hint)}</div>
      </div>
      <section style={fieldCardBox}>
        {page.note && <div style={pageNote}>{t(page.note)}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: page.note ? 9 : 0 }}>
          {page.key === 'voice/kikivoice' && <KikiConnectButton />}
          {page.fields.map((f) => <FieldRow key={f.name} field={f} ctx={ctx} />)}
        </div>
      </section>
      {/* kikivoice is cookie-free (no API key); connection state is shown by KikiConnectButton's
          badge above, so the generic "test connection" row — which probes an API key — is hidden. */}
      {page.key !== 'voice/kikivoice' && <TestConnectionRow page={page} ctx={ctx} />}
    </div>
  );
}

// ── 测试连接 ─────────────────────────────────────────────────────────────

interface ProbeResponse { ok: boolean; message: string; latencyMs?: number; models?: string[]; }
interface ProbeShown { page: string; ok: boolean; message: string; }

/** 本页字段里未保存的暂存值→探测 overrides；空串代表本次测试按默认值。 */
function stagedOverrides(page: SettingsVendorPage, values: Values): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const f of page.fields) {
    const v = values[f.name];
    if (v !== undefined) overrides[f.name] = v.trim();
  }
  return overrides;
}

function TestConnectionRow({ page, ctx }: { page: SettingsVendorPage; ctx: FieldCtx }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeShown | null>(null);
  const shown = result && result.page === page.key ? result : null;

  const test = async (): Promise<void> => {
    setBusy(true); setResult(null);
    const overrides = stagedOverrides(page, ctx.values);
    const staged = Object.keys(overrides).length > 0;
    try {
      const res = await fetch('/api/keys/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: page.key, overrides }),
      });
      const body = await res.json().catch(() => null) as ProbeResponse | null;
      if (!body || typeof body.message !== 'string') throw new Error(t('测试请求失败 ({n})', { n: res.status }));
      const suffix = staged && body.ok ? t('（按当前输入测试，记得保存）') : '';
      setResult({ page: page.key, ok: body.ok, message: body.message + suffix });
      const modelField = page.fields.find((field) => field.discoverableModel);
      if (body.ok && modelField && Array.isArray(body.models)) {
        ctx.onModelsDiscovered(modelField.name, body.models);
      }
    } catch (err) {
      setResult({ page: page.key, ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={testRow}>
      <button type="button" onClick={() => { void test(); }} disabled={busy}
        style={{ ...testBtn, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}>
        {busy ? t('测试中…') : page.key.startsWith('llm/') ? t('测试并读取模型') : t('测试连接')}
      </button>
      {shown && (
        <span style={{ ...testMsg, color: shown.ok ? ON : WARN }} title={shown.message}>
          {shown.ok ? '✓ ' : '✗ '}{shown.message}
        </span>
      )}
      {!shown && !busy && (
        <span style={{ ...testMsg, color: theme.textDim }}>
          {page.key.startsWith('llm/')
            ? t('验证地址与密钥，并读取该接口可用的模型')
            : t('发一条最小请求验证 Key 与地址可用')}
        </span>
      )}
    </div>
  );
}

// ── 字段渲染 ─────────────────────────────────────────────────────────────

export function FieldRow({ field, ctx }: { field: SettingsField; ctx: FieldCtx }) {
  const t = useT();
  const { status, reveal, onStage, onToggleClear } = ctx;
  // value: undefined = 无暂存改动;'' = 暂存清除 / 回默认;其余 = 暂存新值。
  const value = ctx.values[field.name];
  const st = status?.keys[field.name];
  // multi 池字段的「已配置」看 keyPools 计数(兼容 legacy 单 key 回退),其余看 keys 布尔。
  const configured = field.multi
    ? Boolean(status?.keyPools?.[field.providerId ?? '']?.count)
    : Boolean(st?.configured);
  const stagedClear = value === '' && field.kind !== 'toggle' && !field.multi;
  // 模型 / 路由字段回显服务端当前值;secret / base url 永不回填。
  const shown = value ?? (isModelField(field) ? modelValue(status, field.name) : '');
  // select 用「默认」选项即清除;toggle 的关/开本身就是设/清;multi 池有自己的增删按钮。
  const clearable = configured && field.kind !== 'select' && field.kind !== 'toggle' && !field.multi;
  const discovered = field.discoverableModel ? ctx.modelOptions[field.name] ?? [] : [];
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={fieldHead}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          {t(field.label)}
          {configured && !field.multi && <span style={sourceTag}>{st?.source === 'env' ? '.env.local' : t('本次设置')}</span>}
        </span>
        {clearable && (
          <button type="button" onClick={(e) => { e.preventDefault(); onToggleClear(field.name); }}
            style={{ ...clearBtn, color: stagedClear ? WARN : theme.textDim }}>
            {stagedClear ? t('取消清除') : t('清除')}
          </button>
        )}
      </span>
      {field.kind === 'toggle'
        ? <ToggleSwitch field={field} shown={shown} onStage={onStage} />
        : field.multi
          ? <KeyPoolField field={field} ctx={ctx} />
          : field.discoverableModel && discovered.length > 0
            ? <ModelInput field={field} shown={shown} models={discovered} reveal={reveal}
                configured={configured} stagedClear={stagedClear} onStage={onStage} />
            : field.kind === 'select'
            ? <SelectInput field={field} status={status} shown={shown} onStage={onStage} />
            : field.kind === 'directory'
              ? <DirectoryInput field={field} shown={shown} stagedClear={stagedClear} onStage={onStage} />
              : <TextInput field={field} shown={shown} reveal={reveal} configured={configured}
                  stagedClear={stagedClear} onStage={onStage} />}
      {field.note && <span style={{ fontSize: 10.5, color: theme.textDim }}>{t(field.note)}</span>}
    </label>
  );
}

function ModelInput({ field, shown, models, reveal, configured, stagedClear, onStage }: {
  field: SettingsField;
  shown: string;
  models: readonly string[];
  reveal: boolean;
  configured: boolean;
  stagedClear: boolean;
  onStage: (field: SettingsField, raw: string) => void;
}) {
  const t = useT();
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 7 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <TextInput field={field} shown={shown} reveal={reveal} configured={configured}
          stagedClear={stagedClear} onStage={onStage} />
      </div>
      <select
        value=""
        aria-label={t('选择模型')}
        title={t('选择模型')}
        onChange={(event) => {
          if (event.target.value) onStage(field, event.target.value);
        }}
        style={{ ...select, width: 118, flex: '0 0 118px' }}
      >
        <option value="">{t('选择模型')}</option>
        {[...new Set(models)].map((model) => <option key={model} value={model}>{model}</option>)}
      </select>
    </div>
  );
}

/** 开关字段:'' / 任意非 '0' = 启用(默认),'0' = 停用。开 = 暂存 ''(清键回默认),
 * 关 = 暂存 '0'——与 buildPatch 的「'' 显式清除」语义天然一致,保存即生效。 */
function ToggleSwitch({ field, shown, onStage }: {
  field: SettingsField; shown: string;
  onStage: (field: SettingsField, raw: string) => void;
}) {
  const t = useT();
  const on = shown !== '0';
  return (
    <button
      type="button" role="switch" aria-checked={on}
      onClick={(e) => { e.preventDefault(); onStage(field, on ? '0' : ''); }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
        font: 'inherit', fontSize: 11.5, color: on ? ON : theme.textDim,
        background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
      }}
    >
      <span aria-hidden style={{
        width: 30, height: 17, borderRadius: 999, position: 'relative', flexShrink: 0,
        background: on ? ON : theme.border, transition: 'background .18s ease',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: on ? 15 : 2, width: 13, height: 13,
          borderRadius: '50%', background: theme.textStrong, transition: 'left .18s ease',
          boxShadow: `0 1px 3px ${themeAlpha.shadow(0.4)}`,
        }} />
      </span>
      {on ? t('已启用') : t('已停用')}
    </button>
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
        style={stagedClear ? { ...input, border: `0.5px solid ${WARN}` } : input}
      />
      {listId && (
        <datalist id={listId}>
          {field.options?.map((o) => <option key={o.value} value={o.value} />)}
        </datalist>
      )}
    </>
  );
}

function DirectoryInput({ field, shown, stagedClear, onStage }: {
  field: SettingsField; shown: string; stagedClear: boolean;
  onStage: (field: SettingsField, raw: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = window.openChatCutDesktop?.selectDirectory;
  const pick = async (): Promise<void> => {
    if (!picker) return;
    setBusy(true); setError(null);
    try {
      const selected = await picker(shown || undefined);
      if (selected) onStage(field, selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('无法打开目录选择器'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 7 }}>
        <input type="text" autoComplete="off" spellCheck={false} value={shown}
          onChange={(e) => onStage(field, e.target.value)}
          placeholder={fieldPlaceholder(field, false, stagedClear)}
          style={{ ...(stagedClear ? { ...input, border: `0.5px solid ${WARN}` } : input), minWidth: 0 }} />
        <button type="button" onClick={(e) => { e.preventDefault(); void pick(); }}
          disabled={!picker || busy} title={!picker ? t('目录选择器仅桌面端可用') : t('选择素材保存目录')}
          style={{ ...browseBtn, opacity: !picker || busy ? 0.55 : 1 }}>
          {busy ? t('选择中…') : t('选择目录')}
        </button>
      </div>
      {!picker && <span style={fieldHint}>{t('目录选择器仅桌面端可用，浏览器中请手动输入绝对路径。')}</span>}
      {error && <span style={{ ...fieldHint, color: WARN }}>{error}</span>}
    </>
  );
}

// ── 多密钥轮换池 (Assets providers) ────────────────────────────────────────
// 密钥值永不回填浏览器:已存密钥只显示遮罩后缀 + 健康/激活状态,且不可原地编辑
// (要换只能删了重加)。编辑表达为对当前已存池的 {rm:[索引], add:[新值]} 变更,服务端
// 读自己的密钥应用后持久化。本地 added/removed 状态在暂存被清空(保存后)时复位。
function KeyPoolField({ field, ctx }: { field: SettingsField; ctx: FieldCtx }) {
  const t = useT();
  const providerId = field.providerId ?? '';
  const pool: PoolStatus | undefined = ctx.status?.keyPools?.[providerId];
  const existing: readonly KeySlotStatus[] = pool?.keys ?? [];
  const activeIndex = pool?.activeIndex ?? -1;

  const [removed, setRemoved] = useState<Set<number>>(() => new Set());
  const [added, setAdded] = useState<string[]>([]);
  const staged = ctx.values[field.name];
  const prevStaged = useRef<string | undefined>(staged);

  // 保存后暂存被清空 → 复位本地编辑态(新增/移除)。轮询只改 status、不动 values,故不触发。
  useEffect(() => {
    if (prevStaged.current !== undefined && staged === undefined) {
      setRemoved(new Set());
      setAdded([]);
    }
    prevStaged.current = staged;
  }, [staged]);

  const commit = (nextRemoved: Set<number>, nextAdded: string[]): void => {
    const rm = [...nextRemoved].filter((i) => i >= 0 && i < existing.length);
    const add = nextAdded.map((s) => s.trim()).filter(Boolean);
    const hasChange = rm.length > 0 || add.length > 0;
    // '' = 无变更(stage 的多路径视作撤销,不进 dirty);非空变更发 mutasi JSON。
    ctx.onStage(field, hasChange ? JSON.stringify({ rm, add }) : '');
  };
  const toggleRemove = (i: number): void => {
    const next = new Set(removed);
    if (next.has(i)) next.delete(i); else next.add(i);
    setRemoved(next);
    commit(next, added);
  };
  const setAddedAt = (i: number, v: string): void => {
    const next = added.slice(); next[i] = v;
    setAdded(next); commit(removed, next);
  };
  const removeAddedAt = (i: number): void => {
    const next = added.slice(); next.splice(i, 1);
    setAdded(next); commit(removed, next);
  };
  const addRow = (): void => {
    const next = [...added, ''];
    setAdded(next); commit(removed, next);
  };

  const usableCount = existing.length - removed.size + added.filter((a) => a.trim()).length;
  const activeSlot = activeIndex >= 0 ? existing[activeIndex] : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {existing.length === 0 && added.length === 0 && (
        <span style={{ fontSize: 11, color: theme.textDim }}>{t('未配置 · 点下方添加首个密钥')}</span>
      )}
      {existing.map((slot, i) => {
        const isRemoved = removed.has(i);
        const isActive = i === activeIndex;
        return (
          <div key={`k${i}`} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <input
              type="password" readOnly tabIndex={-1} value=""
              placeholder={isRemoved ? t('将移除') : (slot.suffix || t('密钥 {n}', { n: i + 1 }))}
              style={{ ...input, flex: 1, minWidth: 0, opacity: isRemoved ? 0.45 : 1,
                textDecoration: isRemoved ? 'line-through' : 'none' }}
            />
            <KeyStatusChip slot={slot} active={isActive} />
            <button type="button" onClick={(e) => { e.preventDefault(); toggleRemove(i); }}
              style={{ ...clearBtn, color: isRemoved ? ON : WARN, flex: '0 0 auto' }}>
              {isRemoved ? t('恢复') : t('移除')}
            </button>
          </div>
        );
      })}
      {added.map((val, i) => (
        <div key={`a${i}`} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input
            type="password" autoComplete="off" spellCheck={false} value={val}
            onChange={(e) => setAddedAt(i, e.target.value)}
            placeholder={t('输入新密钥')}
            style={{ ...input, flex: 1, minWidth: 0 }}
          />
          <span style={{ ...statusChipBase, color: theme.textDim, border: `0.5px solid ${theme.border}` }}>{t('新增')}</span>
          <button type="button" onClick={(e) => { e.preventDefault(); removeAddedAt(i); }}
            style={{ ...clearBtn, color: WARN, flex: '0 0 auto' }}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 1 }}>
        <button type="button" onClick={(e) => { e.preventDefault(); addRow(); }} style={addKeyBtn}>
          + {t('添加密钥')}
        </button>
        <span style={{ fontSize: 10.5, color: theme.textDim }}>
          {t('共 {n} 个可用密钥', { n: usableCount })}
          {activeSlot ? t(' · 激活 {suf}', { suf: activeSlot.suffix }) : ''}
        </span>
      </div>
    </div>
  );
}

function KeyStatusChip({ slot, active }: { slot: KeySlotStatus; active: boolean }) {
  const t = useT();
  let label: string; let color: string;
  // Health wins over "active": a key that is cooling / exhausted must show red
  // even if it sits at activeIndex (the just-rate-limited key is at activeIndex
  // but is NOT healthy). "active" only promotes a healthy key from 就绪 to 激活.
  if (slot.status === 'cooldown') { label = t('冷却 {n}s', { n: slot.cooldownSeconds }); color = WARN; }
  else if (slot.status === 'exhausted') { label = t('耗尽'); color = WARN; }
  else if (active) { label = t('激活'); color = ON; }
  else { label = t('就绪'); color = theme.textDim; }
  return <span style={{ ...statusChipBase, color, border: `0.5px solid ${color}`, flex: '0 0 auto' }}>{label}</span>;
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

// ── KikiVoice Connect (cookie-based; no key field) ─────────────────────────

interface KikiStatus { state: 'connected' | 'expired' | 'missing' | 'requires-desktop' | 'unknown'; authenticated: boolean | null }

function KikiConnectButton() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<KikiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kikiLogin = typeof window !== 'undefined' ? window.openChatCutDesktop?.kikiLogin : undefined;

  const refresh = async (): Promise<void> => {
    try {
      const r = await fetch('/api/kiki/status');
      if (r.ok) setStatus((await r.json()) as KikiStatus);
    } catch { /* transient — leave last status */ }
  };
  useEffect(() => { void refresh(); }, []);

  const connect = async (): Promise<void> => {
    if (!kikiLogin) { setError(t('KikiVoice requires the desktop app.')); return; }
    setBusy(true); setError(null);
    try {
      await kikiLogin();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const label = status?.state === 'connected' ? t('Connected')
    : status?.state === 'expired' ? t('Expired — click Connect again')
    : status?.state === 'missing' ? t('Not logged in')
    : status?.state === 'requires-desktop' ? t('Desktop app required')
    : status ? t('Unknown') : '';
  const color = status?.state === 'connected' ? ON : status?.state && status.state !== 'requires-desktop' ? WARN : theme.textDim;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <button type="button" onClick={(e) => { e.preventDefault(); void connect(); }}
          disabled={!kikiLogin || busy}
          style={{ ...browseBtn, opacity: !kikiLogin || busy ? 0.55 : 1 }}>
          {busy ? t('Connecting…') : t('Connect')}
        </button>
        {label && <span style={{ fontSize: 11, color }}>{label}</span>}
      </div>
      {!kikiLogin && <span style={fieldHint}>{t('Desktop only — click Connect; a window visits kikivoice.ai over your IP and auto-passes GeeTest (no login, anonymous).')}</span>}
      {error && <span style={{ ...fieldHint, color: WARN }}>{error}</span>}
    </>
  );
}

// ── 样式 ─────────────────────────────────────────────────────────────────

const pane: React.CSSProperties = {
  flex: 1, minWidth: 0, overflowY: 'auto', padding: '14px 20px 16px', display: 'flex', flexDirection: 'column', gap: 12,
};
  const fieldCardBox: React.CSSProperties = { background: theme.bg, border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '11px 13px' };
const pageNote: React.CSSProperties = { fontSize: 10.5, color: theme.textDim };
const fieldHead: React.CSSProperties = {
  fontSize: 11.5, color: theme.text, display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between',
};
const input: React.CSSProperties = {
  font: 'inherit', fontSize: 12.5, background: theme.panelAlt, color: theme.text,
  border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '6px 9px', width: '100%', outline: 'none',
};
const select: React.CSSProperties = { ...input, cursor: 'pointer', colorScheme: 'var(--cc-color-scheme)' };
const sourceTag: React.CSSProperties = { fontSize: 10, color: theme.textDim, border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '0 5px' };
const clearBtn: React.CSSProperties = {
  font: 'inherit', fontSize: 10.5, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', flex: '0 0 auto', textDecoration: 'underline',
};
const browseBtn: React.CSSProperties = {
  font: 'inherit', fontSize: 11.5, color: theme.text, background: theme.panelAlt,
  border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '6px 11px',
  cursor: 'pointer', flex: '0 0 auto', whiteSpace: 'nowrap',
};
const statusChipBase: React.CSSProperties = {
  fontSize: 10, borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap', background: theme.panelAlt,
};
const addKeyBtn: React.CSSProperties = {
  font: 'inherit', fontSize: 11, color: theme.text, background: 'transparent',
  border: `0.5px dashed ${theme.border}`, borderRadius: 6, padding: '5px 11px',
  cursor: 'pointer', flex: '0 0 auto', whiteSpace: 'nowrap',
};
const fieldHint: React.CSSProperties = { fontSize: 10.5, color: theme.textDim };
const testRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, minHeight: 26 };
const testBtn: React.CSSProperties = {
  font: 'inherit', fontSize: 11.5, background: 'transparent', color: theme.text,
  border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '4px 11px', flex: '0 0 auto',
};
const testMsg: React.CSSProperties = {
  flex: 1, minWidth: 0, fontSize: 11, lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box',
  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};
