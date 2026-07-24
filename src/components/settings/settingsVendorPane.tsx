// Right column of the settings panel: Select the manufacturer's configuration page (header + field card + test connection row) and field rendering.
// Detached from SettingsDialog.tsx (500 line limit); the layout shell and left/center columns are still there.
// "Test connection" goes POST /api/keys/test: the unsaved temporary values ​​of this page are included as overrides.
// Sent to the server for detection (only effective this time, not dropped to disk), the key value will never appear in the response.
import { useState } from 'react';
import { theme, themeAlpha } from '../../theme';
import { useT } from '../../i18n/locale';
import { VendorIcon } from './vendorIcons';
import {
  fieldPlaceholder, isModelField, modelValue, selectOptionLabel, selectOptions, vendorConfigured,
  type KeyStatusResponse, type SettingsField, type SettingsVendorPage, type StagedValues as Values,
} from './settingsSchema';

export const ON = theme.success; // Status green → semantic token (graphite value ≈ original #4caf7d, light skin automatically changes to dark green)
export const WARN = '#f77';    // Error / clear alert (retain original panel error color)

/** Field rendering shared context:Server status + temporary storage + plaintext switch + temporary storage/Clear callback. */
export interface FieldCtx {
  status: KeyStatusResponse | null;
  values: Values;
  reveal: boolean;
  onStage: (field: SettingsField, raw: string) => void;
  onToggleClear: (name: string) => void;
  modelOptions: Record<string, readonly string[]>;
  onModelsDiscovered: (name: string, models: readonly string[]) => void;
}

// ──Manufacturer configuration page ───────────────────────────────────────────────────────

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
          <span style={{ fontSize: 11, color: on ? ON : theme.textDim }}>{on ? t('configured') : t('Not configured')}</span>
        </div>
        <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 3, paddingLeft: 26 }}>{t(hint)}</div>
      </div>
      <section style={fieldCardBox}>
        {page.note && <div style={pageNote}>{t(page.note)}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: page.note ? 9 : 0 }}>
          {page.fields.map((f) => <FieldRow key={f.name} field={f} ctx={ctx} />)}
        </div>
      </section>
      <TestConnectionRow page={page} ctx={ctx} />
    </div>
  );
}

// ──Test the connection──────────────────────────────────────────────────────

interface ProbeResponse { ok: boolean; message: string; latencyMs?: number; models?: string[]; }
interface ProbeShown { page: string; ok: boolean; message: string; }

/** Unsaved temporary values in fields on this page→detection overrides;The empty string represents the default value for this test. */
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
      if (!body || typeof body.message !== 'string') throw new Error(t('Test request failed ({n})', { n: res.status }));
      const suffix = staged && body.ok ? t('(Test according to current input, remember to save)') : '';
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
        {busy ? t('Testing…') : page.key.startsWith('llm/') ? t('Test and read the model') : t('test connection')}
      </button>
      {shown && (
        <span style={{ ...testMsg, color: shown.ok ? ON : WARN }} title={shown.message}>
          {shown.ok ? '✓ ' : '✗ '}{shown.message}
        </span>
      )}
      {!shown && !busy && (
        <span style={{ ...testMsg, color: theme.textDim }}>
          {page.key.startsWith('llm/')
            ? t('Verify the address and key, and read the models available for this interface')
            : t('Send a minimum request for verification Key Available with address')}
        </span>
      )}
    </div>
  );
}

// ──Field rendering ────────────────────────────────────────────────────────

export function FieldRow({ field, ctx }: { field: SettingsField; ctx: FieldCtx }) {
  const t = useT();
  const { status, reveal, onStage, onToggleClear } = ctx;
  // value: undefined = no temporary changes; '' = temporary cache clear / return to default; the rest = temporary new values.
  const value = ctx.values[field.name];
  const st = status?.keys[field.name];
  const configured = Boolean(st?.configured);
  const stagedClear = value === '' && field.kind !== 'toggle';
  // The model/routing field echoes the current value of the server; the secret/base url is never backfilled.
  const shown = value ?? (isModelField(field) ? modelValue(status, field.name) : '');
  // Select uses the "default" option to clear; toggle's off/on itself is set/clear.
  const clearable = configured && field.kind !== 'select' && field.kind !== 'toggle';
  const discovered = field.discoverableModel ? ctx.modelOptions[field.name] ?? [] : [];
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={fieldHead}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          {t(field.label)}
          {configured && <span style={sourceTag}>{st?.source === 'env' ? '.env.local' : t('This setting')}</span>}
        </span>
        {clearable && (
          <button type="button" onClick={(e) => { e.preventDefault(); onToggleClear(field.name); }}
            style={{ ...clearBtn, color: stagedClear ? WARN : theme.textDim }}>
            {stagedClear ? t('Cancel clear') : t('Clear')}
          </button>
        )}
      </span>
      {field.kind === 'toggle'
        ? <ToggleSwitch field={field} shown={shown} onStage={onStage} />
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
        aria-label={t('Select model')}
        title={t('Select model')}
        onChange={(event) => {
          if (event.target.value) onStage(field, event.target.value);
        }}
        style={{ ...select, width: 118, flex: '0 0 118px' }}
      >
        <option value="">{t('Select model')}</option>
        {[...new Set(models)].map((model) => <option key={model} value={model}>{model}</option>)}
      </select>
    </div>
  );
}

/** switch field:'' / Any non '0' = enable(Default),'0' = Deactivate. open = temporary storage ''(Clear keys and return to default),
 * close = temporary storage '0'——with buildPatch of "'' "Explicit Clear" semantics are naturally consistent,It will take effect after saving. */
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
      {on ? t('Enabled') : t('Deactivated')}
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
      setError(reason instanceof Error ? reason.message : t('Unable to open directory selector'));
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
          disabled={!picker || busy} title={!picker ? t('Directory selector only available on desktop') : t('Select material saving directory')}
          style={{ ...browseBtn, opacity: !picker || busy ? 0.55 : 1 }}>
          {busy ? t('Selecting…') : t('Select directory')}
        </button>
      </div>
      {!picker && <span style={fieldHint}>{t('The directory selector is only available on the desktop. Please enter the absolute path manually in the browser.')}</span>}
      {error && <span style={{ ...fieldHint, color: WARN }}>{error}</span>}
    </>
  );
}

function SelectInput({ field, status, shown, onStage }: {
  field: SettingsField; status: KeyStatusResponse | null; shown: string;
  onStage: (field: SettingsField, raw: string) => void;
}) {
  const opts = selectOptions(field);
  const unknown = shown !== '' && !opts.some((o) => o.value === shown);  // Manually changing the value of .env.local is also displayed faithfully
  return (
    <select value={shown} onChange={(e) => onStage(field, e.target.value)} style={select}>
      {unknown && <option value={shown}>{shown}</option>}
      {opts.map((o) => (
        <option key={o.value} value={o.value}>{selectOptionLabel(status, field, o)}</option>
      ))}
    </select>
  );
}

// ── Style ───────────────────────────────────────────────────────────

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
