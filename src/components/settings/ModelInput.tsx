// Model text input, picker, and the retirement warning shared by provider pages.
import { useT } from '../../i18n/locale';
import { isRetiredModel, retirementFor } from '../../../shared/model-retirements';
import { fieldPlaceholder, type SettingsField } from './settingsSchema';
import { WARN, input, select } from './settingsVendorPane.styles';

interface TextInputProps {
  field: SettingsField; shown: string; reveal: boolean; configured: boolean; stagedClear: boolean;
  onStage: (field: SettingsField, raw: string) => void;
}

export function TextInput({ field, shown, reveal, configured, stagedClear, onStage }: TextInputProps) {
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

/** A saved model the provider has shut down (or will shut down) is warned about, never rewritten. */
export function RetirementHint({ model }: { readonly model: string }) {
  const t = useT();
  const retirement = retirementFor(model);
  if (!retirement) return null;
  return (
    <span style={{ fontSize: 10.5, color: WARN }}>
      {isRetiredModel(model)
        ? t('该模型已于 {date} 停用', { date: retirement.retiredAt })
        : t('该模型将于 {date} 停用', { date: retirement.retiredAt })}
      {retirement.replacement && <> {t('建议改用 {model}', { model: retirement.replacement })}</>}
    </span>
  );
}

export function ModelInput({ field, shown, models, reveal, loading, configured, stagedClear, onStage }: {
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
        {[...new Set(models)].map((model) => <option key={model} value={model}>{model}</option>)}      </select>
    </div>
  );
}
