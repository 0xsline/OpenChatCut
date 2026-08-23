// Provider configuration page, field rendering, and connection tests.
import { useState } from 'react';
import { theme, themeAlpha } from '../../theme';
import { t, useT } from '../../i18n/locale';
import { VendorIcon } from './vendorIcons';
import { Icon } from '../icons';
import { CodexAccountCard } from './CodexAccountCard';
import type { CodexAgentModel } from '../../../shared/codex-agent';
import type { CodexSettingsController } from './useCodexSettings';
import { shouldRenderModelPicker } from './codexReasoning';
import { llmProviderConfigNames, normalizeLlmProvider } from '../../../shared/llm-providers';
import { MODEL_CAPABILITY_OVERRIDES_KEY } from '../../../shared/model-capabilities';
import { ModelCapabilityEditor } from './ModelCapabilityEditor';
import { XaiOauthVendorPane } from './XaiOauthVendorPane';
import { VisionModelPane } from './VisionModelPane';
import { LocalAsrPane } from './LocalAsrPane';
import { LocalModelPackPane } from './LocalModelPackPane';
import { SemanticModelPackPane } from './SemanticModelPackPane';
import { SettingsNoteAction } from './SettingsNoteAction.tsx';
import {
  fieldPlaceholder, isModelField, modelValue, selectOptionLabel, selectOptions, vendorConfigured,
  type KeyStatusResponse, type SelectOption, type SettingsField, type SettingsVendorPage,
  type StagedValues as Values,
} from './settingsSchema';
import {
  browseBtn, clearBtn, fieldCardBox, fieldHead, fieldHint, input, ON, pageNote,
  pane, select, sourceTag, testBtn, testMsg, testRow, WARN,
} from './settingsVendorPane.styles';
export { ON, WARN } from './settingsVendorPane.styles';

/** Field rendering shared context: server status + temporary storage + plain text switch + temporary storage/clear callback. */
export interface FieldCtx {
  status: KeyStatusResponse | null;
  values: Values;
  reveal: boolean;
  onStage: (field: SettingsField, raw: string) => void;
  onToggleClear: (field: SettingsField) => void;
  modelOptions: Record<string, readonly string[]>;
  onModelsDiscovered: (name: string, models: readonly string[]) => void;
  codex: CodexSettingsController;
  /** Re-read /api/keys and push the result to the agent runtime (used by connection-style pages after login/logout). */
  refreshStatus: () => Promise<void>;
}
const CAPABILITY_OVERRIDE_FIELD: SettingsField = {
  name: MODEL_CAPABILITY_OVERRIDES_KEY, label: '模型能力', kind: 'text', defaultLabel: '',
};

function capabilityOverridesValue(ctx: FieldCtx): string {
  return ctx.values[MODEL_CAPABILITY_OVERRIDES_KEY]
    ?? modelValue(ctx.status, MODEL_CAPABILITY_OVERRIDES_KEY);
}

function apiModelId(page: SettingsVendorPage, ctx: FieldCtx): string {
  const names = llmProviderConfigNames(page.vendor);
  const field = page.fields.find((candidate) => candidate.name === names.model);
  return (ctx.values[names.model] ?? modelValue(ctx.status, names.model)) || field?.defaultLabel || '';
}

// ──Provider configuration page ────────────────────────────────────────────────────────

export function VendorPane({ page, hint, ctx }: {
  page: SettingsVendorPage; hint: string; ctx: FieldCtx;
}) {
  const t = useT();
  if (page.connection === 'codex') return <CodexVendorPane page={page} hint={hint} ctx={ctx} />;
  if (page.connection === 'xai-oauth') return <XaiOauthVendorPane page={page} hint={hint} ctx={ctx} />;
  if (page.key === 'llm/vision') return <VisionModelPane />;
  if (page.kind === 'local-models') return <LocalModelsPane page={page} fields={page.fields} ctx={ctx} />;
  const on = vendorConfigured(ctx.status, page, ctx.codex.status);
  return (
    <div style={pane}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <VendorIcon vendor={page.vendor} size={18} />
          <b style={{ fontSize: 13 }}>{t(page.title)}</b>
          <span style={{ fontSize: 11, color: on ? ON : theme.textDim }}>{on ? t('已配置') : t('未配置')}</span>
        </div>
        <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 3, paddingLeft: 26 }}>{t(hint)}</div>
      </div>
      <section style={fieldCardBox}>
        {page.note && <div style={pageNote}>{t(page.note)}</div>}
        {page.noteAction && <SettingsNoteAction config={page.noteAction} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: page.note ? 9 : 0 }}>
          {page.fields.map((f) => <FieldRow key={f.name} field={f} ctx={ctx} />)}
        </div>
        {page.key.startsWith('llm/') && (
          <ModelCapabilityEditor backend="api" provider={normalizeLlmProvider(page.vendor)}
            modelId={apiModelId(page, ctx)} rawOverrides={capabilityOverridesValue(ctx)}
            onChange={(value) => ctx.onStage(CAPABILITY_OVERRIDE_FIELD, value)} />
        )}
      </section>
      <TestConnectionRow page={page} ctx={ctx} />
    </div>
  );
}

function CodexVendorPane({ page, hint, ctx }: {
  page: SettingsVendorPage; hint: string; ctx: FieldCtx;
}) {
  const t = useT();
  const status = ctx.codex.status;
  const statusLabel = !status ? t('状态未知')
    : !status.installed ? t('CLI 未安装')
      : status.loginPending || ctx.codex.login ? t('登录中')
        : status.account?.type === 'chatgpt' ? t('已登录')
          : status.account ? t('API Key 模式')
            : status.error || ctx.codex.error ? t('连接异常') : t('未登录');
  const on = vendorConfigured(ctx.status, page, status);
  const capabilityModelId = (ctx.values.CODEX_MODEL ?? modelValue(ctx.status, 'CODEX_MODEL'))
    || ctx.codex.models.find((model) => model.isDefault)?.id
    || '';
  return (
    <div style={pane}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <VendorIcon vendor={page.vendor} size={18} />
          <b style={{ fontSize: 13 }}>{t(page.title)}</b>
          <span style={{ fontSize: 11, color: on ? ON : theme.textDim }}>{statusLabel}</span>
        </div>
        <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 3, paddingLeft: 26 }}>{t(hint)}</div>
      </div>
      <CodexAccountCard controller={ctx.codex} />
      <section style={fieldCardBox}>
        {page.note && <div style={pageNote}>{t(page.note)}</div>}
        {page.noteAction && <SettingsNoteAction config={page.noteAction} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: page.note ? 9 : 0 }}>
          {page.fields.map((field) => <FieldRow key={field.name} field={field} ctx={ctx} />)}
        </div>
        {capabilityModelId && (
          <ModelCapabilityEditor backend="codex" provider="openai"
            modelId={capabilityModelId}
            rawOverrides={capabilityOverridesValue(ctx)}
            onChange={(value) => ctx.onStage(CAPABILITY_OVERRIDE_FIELD, value)} />
        )}
      </section>
    </div>
  );
}

function LocalModelsPane({ page, fields, ctx }: {
  page: SettingsVendorPage; fields: readonly SettingsField[]; ctx: FieldCtx;
}) {
  const t = useT();
  const title = page.key === 'local/asr' ? '本地转写' : page.key === 'local/music/packs' ? '节拍与音乐分析' : '画面语义搜索';
  return (
    <div style={pane}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {page.icon ? <Icon name={page.icon} size={18} /> : <VendorIcon vendor={page.vendor} size={18} />}
          <b style={{ fontSize: 13 }}>{t(title)}</b>
        </div>
        <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 3, paddingLeft: 26 }}>
          {t('本地模型按需安装，索引、转写和分析都在本机完成。')}
        </div>
      </div>
      {page.key === 'local/asr' && <LocalAsrPane fields={fields} ctx={ctx} />}
      {page.key === 'local/music/packs' && <LocalModelPackPane
        packIds={['rhythm-lite', 'music-semantics-lite']}
        title="节拍与音乐分析模型"
        description="模型不会自动安装。安装后，节拍与音乐语义分析只在本机运行。" />}
      {page.key === 'local/semantic/setup' && <SemanticModelPackPane />}
    </div>
  );
}


// ── Test connection ───────────────────────────────────────────────────────

interface ProbeRequestResult { body: ProbeResponse; staged: boolean; }
interface ProbeResponse { ok: boolean; message: string; latencyMs?: number; models?: string[]; }
interface ProbeShown { page: string; ok: boolean; message: string; }

/** Unsaved temporary values in the fields on this page → detect overrides; the empty string represents the default value for this test. */
function stagedOverrides(page: SettingsVendorPage, values: Values): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const f of page.fields) {
    const v = values[f.name];
    if (v !== undefined) overrides[f.name] = v.trim();
  }
  return overrides;
}

async function requestProbe(page: SettingsVendorPage, ctx: FieldCtx, translate: typeof t): Promise<ProbeRequestResult> {
  const overrides = stagedOverrides(page, ctx.values);
  if (page.kind === 'settings' && page.fields[0]) {
    const field = page.fields[0];
    const effectiveValue = ctx.values[field.name] ?? modelValue(ctx.status, field.name);
    if (effectiveValue?.trim()) overrides[field.name] = effectiveValue.trim();
    else delete overrides[field.name];
  }
  const staged = Object.keys(ctx.values).some((name) => page.fields.some((field) => field.name === name));
  const res = await fetch('/api/keys/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: page.key, overrides }),
  });
  const body = await res.json().catch(() => null) as ProbeResponse | null;
  if (!body || typeof body.message !== 'string') throw new Error(translate('测试请求失败 ({n})', { n: res.status }));
  return { body, staged };
}

export function TestConnectionRow({ page, ctx }: { page: SettingsVendorPage; ctx: FieldCtx }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeShown | null>(null);
  const shown = result && result.page === page.key ? result : null;

  const test = async (): Promise<void> => {
    setBusy(true); setResult(null);
    try {
      const { body, staged } = await requestProbe(page, ctx, t);
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

  const discoversModels = page.fields.some((field) => field.discoverableModel);
  const isProxy = page.key === 'agent/proxy';
  return (
    <div style={testRow}>
      <button type="button" onClick={() => { void test(); }} disabled={busy}
        style={{ ...testBtn, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}>
        {busy ? t('测试中…') : discoversModels ? t('测试并读取模型') : isProxy ? t('测试代理连接') : t('测试连接')}
      </button>
      {shown && (
        <span style={{ ...testMsg, color: shown.ok ? ON : WARN }} title={shown.message}>
          {shown.ok ? '✓ ' : '✗ '}{shown.message}
        </span>
      )}
      {!shown && !busy && (
        <span style={{ ...testMsg, color: theme.textDim }}>
          {discoversModels
            ? t('验证地址与密钥，并读取该接口可用的模型')
            : isProxy ? t('使用当前代理地址访问外网探测端点') : t('发一条最小请求验证 Key 与地址可用')}
        </span>
      )}
    </div>
  );
}

// ──Field rendering ────────────────────────────────────────────────────────

function selectedCodexModel(ctx: FieldCtx): CodexAgentModel | undefined {
  const selectedId = ctx.values.CODEX_MODEL ?? modelValue(ctx.status, 'CODEX_MODEL');
  return ctx.codex.models.find((model) => model.id === selectedId)
    ?? (selectedId ? undefined : ctx.codex.models.find((model) => model.isDefault));
}

function codexReasoningOptions(
  ctx: FieldCtx,
  formatDefault: (effort?: string) => string,
): readonly SelectOption[] {
  const model = selectedCodexModel(ctx);
  return [
    { value: '', label: formatDefault(model?.defaultReasoningEffort ?? undefined) },
    ...(model?.supportedReasoningEfforts.map((option) => ({
      value: option.reasoningEffort,
      label: option.reasoningEffort,
    })) ?? []),
  ];
}


export function FieldRow({ field, ctx }: { field: SettingsField; ctx: FieldCtx }) {
  const t = useT();
  const { status, reveal, onStage, onToggleClear } = ctx;
  // value: undefined = no temporary changes; '' = temporary cache clear / return to default; the rest = temporary new values.
  const value = ctx.values[field.name];
  const st = status?.keys[field.name];
  const configured = Boolean(st?.configured);
  const stagedClear = value === '' && field.kind !== 'toggle';
  // Model / routing field echoes the current value of the server; secret / base url will never be backfilled.
  const shown = value ?? (isModelField(field) ? modelValue(status, field.name) : '');
  // Select uses the "default" option to clear; toggle's off/on itself is set/clear.
  const clearable = configured && field.kind !== 'select' && field.kind !== 'toggle';
  const discovered = field.name === 'CODEX_MODEL'
    ? ctx.codex.models.map((model) => model.id)
    : field.discoverableModel ? ctx.modelOptions[field.name] ?? [] : [];
  const options = field.name === 'CODEX_REASONING_EFFORT'
    ? codexReasoningOptions(ctx, (effort) => effort
      ? t('模型默认（{name}）', { name: effort })
      : t('模型默认'))
    : undefined;
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={fieldHead}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          {t(field.label)}
          {configured && <span style={sourceTag}>{st?.source === 'env' ? '.env.local' : t('本次设置')}</span>}
        </span>
        {clearable && (
          <button type="button" onClick={(e) => { e.preventDefault(); onToggleClear(field); }}
            style={{ ...clearBtn, color: stagedClear ? WARN : theme.textDim }}>
            {stagedClear ? t('取消清除') : t('清除')}
          </button>
        )}
      </span>
      {field.kind === 'toggle'
        ? <ToggleSwitch field={field} shown={shown} onStage={onStage} />
        : shouldRenderModelPicker(field, discovered.length)
          ? <ModelInput field={field} shown={shown} models={discovered} reveal={reveal}
              loading={field.name === 'CODEX_MODEL' && ctx.codex.modelBusy}
              configured={configured} stagedClear={stagedClear} onStage={onStage} />
          : field.kind === 'select'
          ? <SelectInput field={field} status={status} shown={shown} options={options} onStage={onStage} />
          : field.kind === 'directory'
            ? <DirectoryInput field={field} shown={shown} stagedClear={stagedClear} onStage={onStage} />
            : <TextInput field={field} shown={shown} reveal={reveal} configured={configured}
                stagedClear={stagedClear} onStage={onStage} />}
      {field.note && <span style={{ fontSize: 10.5, color: theme.textDim }}>{t(field.note)}</span>}
    </label>
  );
}

function ModelInput({ field, shown, models, reveal, loading, configured, stagedClear, onStage }: {
  field: SettingsField;
  shown: string;
  models: readonly string[];
  reveal: boolean;
  loading?: boolean;
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
        disabled={models.length === 0}
        aria-busy={loading === true}
        onChange={(event) => {
          if (event.target.value) onStage(field, event.target.value);
        }}
        style={{ ...select, width: 118, flex: '0 0 118px' }}
      >
        <option value="">{loading ? t('读取中…') : t('选择模型')}</option>
        {[...new Set(models)].map((model) => <option key={model} value={model}>{model}</option>)}
      </select>
    </div>
  );
}

/** Switch field:''/Anything other than '0' = enabled (default), '0' = disabled. On = temporary storage ''(clear key to return to default),
 * Off = Temporary storage '0' - The semantics are naturally consistent with the "'' explicit clear" of buildPatch, and it will take effect immediately after saving. */
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
  const displayValue = stagedClear ? shown : shown || field.defaultValue || '';
  return (
    <>
      <input
        type={field.kind === 'secret' && !reveal ? 'password' : 'text'}
        autoComplete="off" spellCheck={false} list={listId}
        value={displayValue}
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

function SelectInput({ field, status, shown, options, onStage }: {
  field: SettingsField; status: KeyStatusResponse | null; shown: string;
  options?: readonly SelectOption[];
  onStage: (field: SettingsField, raw: string) => void;
}) {
  const opts = options ?? selectOptions(field);
  const unknown = shown !== '' && !opts.some((o) => o.value === shown);  // Manually changing the value of.env.local is also displayed faithfully
  return (
    <select value={shown} onChange={(e) => onStage(field, e.target.value)} style={select}>
      {unknown && <option value={shown}>{shown}</option>}
      {opts.map((o) => (
        <option key={o.value} value={o.value}>{selectOptionLabel(status, field, o)}</option>
      ))}
    </select>
  );
}
