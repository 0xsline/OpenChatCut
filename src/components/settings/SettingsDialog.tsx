import { useEffect, useRef, useState } from 'react';
import { theme, themeAlpha } from '../../theme';
import { t, useT } from '../../i18n/locale';
import { Icon } from '../icons';
import { VendorIcon } from './vendorIcons';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels } from '../../agent/capabilities';
import { applyAgentModelStatus } from '../../agent/model-selection';
import { FieldRow, ON, VendorPane, WARN, type FieldCtx } from './settingsVendorPane';
import {
  getSettingsCategories, buildPatch, categoryGroupStats, findGroup, groupConfigured,
  isModelField, modelValue, omitKey, savedMessage, vendorConfigured,
  type KeyStatusResponse, type SettingsCategory, type SettingsField, type SettingsGroup,
  type SettingsVendorPage, type StagedValues as Values,
} from './settingsSchema';
import {
  API_FORMAT_OPTIONS,
  LLM_CUSTOM_PROVIDERS_KEY,
  apiFormatToProtocol,
  listCustomLlmProviders,
  llmProviderConfigNames,
  normalizeApiFormat,
  parseCustomLlmProvidersJson,
  serializeCustomLlmProviders,
  setCustomLlmProviders,
  slugifyProviderId,
  type ProviderApiFormat,
} from '../../../shared/llm-providers';

// 全局设置模态,三栏:左 =「分类 → 能力」两级可折叠树(能力行 = 状态点 + 名);
// 中 = 当前能力下的厂商列表(生成四能力顶部带「默认厂商」路由 select);
// 右 = 选中厂商的配置页(头 = 图标 + 名称 + 配置状态,体 = 字段)。
// 密钥值只经 POST /api/keys 流向 dev server(存内存 + .env.local,已 gitignore),
// 服务端注入;GET 对 secret 只回布尔,永不回填。模型 / 路由字段是非密配置,当前值
// 经 GET 的 models 通道回显。
// values 语义:字段名出现在 values 里 = 有暂存改动;'' = 显式暂存清除(保存时发送,
// 后端把空串视为删除该键并从 .env.local 删行,对模型字段即「回到默认」)。暂存基线:
// 模型字段 = 服务端当前值,其余 = ''(回显值不算暂存,只有真实改动进 values);
// values 按字段名全局共享且切换树节点不清空(MINIMAX_* 跨能力页即时同步)。
// 右栏(厂商配置页 + 字段渲染 + 测试连接)在 settingsVendorPane.tsx。
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
    const pull = (): void => {
      fetch('/api/keys')
        .then((r) => r.json() as Promise<KeyStatusResponse>)
        .then((d) => { if (alive) setStatus(d); })
        .catch(() => { if (alive) setLoadError(t('无法读取配置（dev 服务未就绪？）')); });
    };
    pull();
    // Poll every 4s while the dialog is open so the rotatable key-pool indicators
    // (active key / cooldown countdowns) update live. values (staged edits) are
    // separate state, so polling never disturbs in-flight user edits.
    const timer = window.setInterval(pull, 4000);
    return () => { alive = false; window.clearInterval(timer); };
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

/** 防误关:有未保存改动时,遮罩 / Esc 第一次只警示,2 秒内再次触发才真正关闭。 */
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

/** 左树能力选中 + 中列厂商选中;切能力时中列重置为该能力第一家。 */
function useTreeSelection(): {
  group: SettingsGroup; page: SettingsVendorPage;
  selectGroup: (key: string) => void; selectVendor: (key: string) => void;
  bumpVendors: () => void;
} {
  const first = getSettingsCategories()[0]!.groups[0]!;
  const [groupKey, setGroupKey] = useState<string>(first.key);
  const [vendorKey, setVendorKey] = useState<string>(first.vendors[0]!.key);
  const [, setCatalogTick] = useState(0);
  const group = findGroup(groupKey);
  const page = group.vendors.find((v) => v.key === vendorKey) ?? group.vendors[0]!;
  const selectGroup = (key: string): void => {
    setGroupKey(key);
    setVendorKey(findGroup(key).vendors[0]!.key);
  };
  const bumpVendors = (): void => setCatalogTick((n) => n + 1);
  return { group, page, selectGroup, selectVendor: setVendorKey, bumpVendors };
}

// ── 主组件 ────────────────────────────────────────────────────────────────

/** 保存成功后让 agent 侧即时感知:caps / key 布尔 / 模型路由 / LLM 接口与模型。 */
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
  const { group, page, selectGroup, selectVendor, bumpVendors } = useTreeSelection();
  const [reveal, setReveal] = useState(false);
  const [addingProvider, setAddingProvider] = useState(false);
  const { save, saving, msg, error } = useSaveKeys(values, (next) => {
    if (next.models?.[LLM_CUSTOM_PROVIDERS_KEY] !== undefined) {
      setCustomLlmProviders(parseCustomLlmProvidersJson(next.models[LLM_CUSTOM_PROVIDERS_KEY]));
      bumpVendors();
    }
    setStatus(next);
    applySavedToAgent(next);
    setValues({});
  });
  const dirty = Object.keys(values).length > 0;
  const { requestClose, warn } = useCloseGuard(dirty, onClose);
  useEscape(requestClose);

  // Hydrate custom providers when status loads
  useEffect(() => {
    const raw = status?.models?.[LLM_CUSTOM_PROVIDERS_KEY];
    if (typeof raw === 'string') {
      setCustomLlmProviders(parseCustomLlmProvidersJson(raw));
      bumpVendors();
    }
  }, [status?.models?.[LLM_CUSTOM_PROVIDERS_KEY]]);

  // 暂存:相对基线(模型字段 = 服务端当前值,其余 = '')无变化即撤销暂存。
  // multi 池字段:raw 是 {rm,add} mutasi JSON;'' = 无变更(撤销)。
  const stage = (field: SettingsField, raw: string): void => {
    if (field.multi) {
      setValues((prev) => raw === '' ? omitKey(prev, field.name) : { ...prev, [field.name]: raw });
      return;
    }
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
            <b style={{ fontSize: 14 }}>{t('设置 · API 密钥')}</b>
          </div>
          <button onClick={onClose} title={t('关闭')} style={iconBtn}><Icon name="x" size={15} /></button>
        </header>
        <div style={bodyRow}>
          <CapabilityTree status={status} activeGroup={group.key} onSelect={selectGroup} />
          <VendorList
            group={group}
            activeVendor={page.key}
            onSelectVendor={(key) => { setAddingProvider(false); selectVendor(key); }}
            ctx={ctx}
            onAddProvider={group.key === 'llm' ? () => setAddingProvider(true) : undefined}
          />
          {addingProvider && group.key === 'llm' ? (
            <AddProviderPane
              onCancel={() => setAddingProvider(false)}
              onCreated={async (created) => {
                // Refresh catalog, select new vendor page, seed staged fields
                bumpVendors();
                selectVendor(`llm/${created.id}`);
                setAddingProvider(false);
                const names = llmProviderConfigNames(created.id);
                setValues((prev) => ({
                  ...prev,
                  [names.baseUrl]: created.baseUrl,
                  [names.model]: created.defaultModel,
                  ...(created.apiKey ? { [names.apiKey]: created.apiKey } : {}),
                }));
                // Reload status so custom catalog is visible after save path
                try {
                  const res = await fetch('/api/keys');
                  const body = await res.json() as KeyStatusResponse;
                  setStatus(body);
                  applySavedToAgent(body);
                } catch { /* ignore */ }
              }}
            />
          ) : (
            <VendorPane page={page} hint={group.hint} ctx={ctx} />
          )}
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
        {getSettingsCategories().map((cat) => (
          <TreeCategory key={cat.key} category={cat} status={status} open={!collapsed.has(cat.key)}
            activeGroup={activeGroup} onToggle={() => toggle(cat.key)} onSelect={onSelect} />
        ))}
      </div>
      <p style={sidebarNote}>
        {t('密钥仅存本机')} <code style={code}>.env.local</code>{t('（已 gitignore），经服务端注入，')}<b>{t('不进浏览器。')}</b>
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

// ── 中栏(路由 select + 厂商列表) ─────────────────────────────────────────

function VendorList({ group, activeVendor, onSelectVendor, ctx, onAddProvider }: {
  group: SettingsGroup;
  activeVendor: string;
  onSelectVendor: (key: string) => void;
  ctx: FieldCtx;
  onAddProvider?: () => void;
}) {
  const t = useT();
  return (
    <div style={vendorCol}>
      {group.route && <div style={routeBox}><FieldRow field={group.route} ctx={ctx} /></div>}
      {onAddProvider && (
        <button
          type="button"
          onClick={onAddProvider}
          title={t('添加自定义厂商')}
          style={{
            font: 'inherit', fontSize: 12, display: 'flex', alignItems: 'center', gap: 7,
            width: '100%', padding: '6px 9px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
            border: `0.5px dashed ${theme.border}`, background: 'transparent', color: theme.textDim, marginBottom: 4,
          }}
        >
          <Icon name="plus" size={14} />
          <span style={navLabel}>{t('添加厂商')}</span>
        </button>
      )}
      {group.vendors.map((p) => (
        <VendorRow key={p.key} page={p} on={vendorConfigured(ctx.status, p)}
          active={p.key === activeVendor} onSelect={() => onSelectVendor(p.key)} />
      ))}
    </div>
  );
}

/** ZCode-style custom provider form → writes LLM_CUSTOM_PROVIDERS + keys into .env.local */
function AddProviderPane({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (created: {
    id: string;
    label: string;
    baseUrl: string;
    defaultModel: string;
    apiKey: string;
    apiFormat: ProviderApiFormat;
  }) => void | Promise<void>;
}) {
  const t = useT();
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.example.com/v1');
  // Same 3 formats as ZCode / 9arghCompany provider settings
  const [apiFormat, setApiFormat] = useState<ProviderApiFormat>('chat_completions');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (): Promise<void> => {
    setError('');
    const name = label.trim();
    const url = baseUrl.trim().replace(/\/+$/, '');
    const modelId = model.trim() || 'default';
    if (!name || !url) {
      setError(t('请填写名称和 API URL'));
      return;
    }
    const id = slugifyProviderId(name.startsWith('custom-') ? name : `custom-${name}`);
    if (!id) {
      setError(t('名称无效'));
      return;
    }
    setBusy(true);
    try {
      const existing = listCustomLlmProviders();
      if (existing.some((p) => p.id === id)) {
        setError(t('该厂商已存在'));
        setBusy(false);
        return;
      }
      const format = normalizeApiFormat(apiFormat);
      const nextList = [
        ...existing,
        {
          id,
          label: name,
          apiFormat: format,
          protocol: apiFormatToProtocol(format),
          baseUrl: url,
          defaultModel: modelId,
        },
      ];
      const names = llmProviderConfigNames(id);
      const patch: Record<string, string> = {
        [LLM_CUSTOM_PROVIDERS_KEY]: serializeCustomLlmProviders(nextList),
        [names.baseUrl]: url,
        [names.model]: modelId,
        LLM_PROVIDER: id,
      };
      if (apiKey.trim()) patch[names.apiKey] = apiKey.trim();

      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({})) as { error?: string; models?: Record<string, string> };
      if (!res.ok) throw new Error(body.error || t('保存失败 ({n})', { n: res.status }));

      setCustomLlmProviders(parseCustomLlmProvidersJson(body.models?.[LLM_CUSTOM_PROVIDERS_KEY]
        ?? serializeCustomLlmProviders(nextList)));

      await onCreated({
        id,
        label: name,
        baseUrl: url,
        defaultModel: modelId,
        apiKey: apiKey.trim(),
        apiFormat: format,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const fieldStyle: React.CSSProperties = {
    font: 'inherit', fontSize: 12, padding: '7px 9px', borderRadius: 6,
    border: `0.5px solid ${theme.border}`, background: theme.panelAlt, color: theme.text, width: '100%', boxSizing: 'border-box',
  };

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <b style={{ fontSize: 13 }}>{t('添加自定义厂商')}</b>
        <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 4 }}>
          {t('ZCode 风格：名称 + Base URL + API format + 模型 + Key。保存后写入')} <code>.env.local</code>
        </div>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11.5 }}>{t('显示名称')}</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My Gateway" style={fieldStyle} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11.5 }}>API URL / Base URL</span>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" style={fieldStyle} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11.5 }}>{t('API format')}</span>
        <select
          value={apiFormat}
          onChange={(e) => setApiFormat(e.target.value as ProviderApiFormat)}
          style={fieldStyle}
        >
          {API_FORMAT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <span style={{ fontSize: 10.5, color: theme.textDim }}>
          {apiFormat === 'anthropic_messages' && t('走 /messages（Grok / Claude 网关常用）')}
          {apiFormat === 'chat_completions' && t('走 /chat/completions（多数兼容网关）')}
          {apiFormat === 'responses' && t('走 /responses（OpenAI Responses API）')}
        </span>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11.5 }}>{t('默认模型 ID')}</span>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="qwen3.7-plus / grok-4.5 / gpt-5.4" style={fieldStyle} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11.5 }}>API Key</span>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" style={fieldStyle} />
      </label>
      {error && <div style={{ fontSize: 11.5, color: WARN }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <button type="button" onClick={onCancel} style={btnGhost}>{t('取消')}</button>
        <button type="button" disabled={busy} onClick={() => { void submit(); }}
          style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>
          {busy ? t('保存中…') : t('保存到 .env.local')}
        </button>
      </div>
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
      <div style={{ ...footMsg, color: message?.color ?? ON }}>{message?.text ?? ''}</div>
      <button onClick={onClose} style={btnGhost}>{t('关闭')}</button>
      <button onClick={onSave} disabled={disabled}
        style={{ ...btnPrimary, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}>
        {saving ? t('保存中…') : t('保存')}
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
