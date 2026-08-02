import { useState } from 'react';
import type { LlmProvider } from '../../../shared/llm-providers';
import {
  findModelCapabilityOverride,
  parseModelCapabilityOverrides,
  resolveModelCapabilities,
  serializeModelCapabilityOverrides,
  updateModelCapabilityOverride,
  type ModelBackend,
  type ModelCapabilities,
  type ModelCapabilityOverride,
} from '../../../shared/model-capabilities';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';

interface ModelCapabilityEditorProps {
  readonly backend: ModelBackend;
  readonly provider: LlmProvider;
  readonly modelId: string;
  readonly rawOverrides: string;
  readonly onChange: (value: string) => void;
}

type OverridePatch = Parameters<typeof updateModelCapabilityOverride>[2];
type CapabilityBoolean = 'supportsTools' | 'supportsImages' | 'supportsReasoning';

function sourceLabel(source: string, estimated: boolean): string {
  if (source === 'settings-override') return '自定义 · 精确';
  if (source === 'catalog') return '模型目录 · 精确';
  return estimated ? '厂商回退 · 估算' : '厂商回退';
}

function resolvedSummary(capabilities: ModelCapabilities, translate: (key: string) => string): string {
  const context = capabilities.contextWindowTokens;
  const output = capabilities.maxOutputTokens;
  return `Context ${context.value.toLocaleString()} · Output ${output.value.toLocaleString()} · ${translate(sourceLabel(context.source, context.estimated))}`;
}

function parseRecords(raw: string): readonly ModelCapabilityOverride[] {
  try { return parseModelCapabilityOverrides(raw); } catch { return []; }
}

function BooleanOverride({ label, value, onChange }: {
  readonly label: string;
  readonly value: boolean | undefined;
  readonly onChange: (value: boolean | undefined) => void;
}) {
  const t = useT();
  return (
    <label style={fieldStyle}>
      <span>{t(label)}</span>
      <select value={value === undefined ? '' : String(value)}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}
        style={inputStyle}>
        <option value="">{t('继承模型目录')}</option>
        <option value="true">{t('支持')}</option>
        <option value="false">{t('不支持')}</option>
      </select>
    </label>
  );
}

function NumericOverride({ label, value, minimum, onCommit }: {
  readonly label: string;
  readonly value: number | undefined;
  readonly minimum: number;
  readonly onCommit: (value: number | undefined) => void;
}) {
  const t = useT();
  return (
    <label style={fieldStyle}>
      <span>{t(label)}</span>
      <input key={`${label}:${value ?? ''}`} type="number" min={minimum} max={4_000_000}
        defaultValue={value ?? ''} placeholder={t('继承模型目录')}
        onBlur={(event) => {
          const raw = event.target.value.trim();
          onCommit(raw ? Number(raw) : undefined);
        }} style={inputStyle} />
    </label>
  );
}

export function ModelCapabilityEditor({
  backend, provider, modelId, rawOverrides, onChange,
}: ModelCapabilityEditorProps) {
  const t = useT();
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const identity = { backend, provider, modelId: modelId.trim() } as const;
  const records = parseRecords(rawOverrides);
  const override = findModelCapabilityOverride(records, identity);
  const resolved = resolveModelCapabilities(identity, records);
  const update = (patch: OverridePatch): void => {
    try {
      const next = updateModelCapabilityOverride(records, identity, patch);
      onChange(next.length ? serializeModelCapabilityOverrides(next) : '');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const booleanUpdate = (field: CapabilityBoolean) => (value: boolean | undefined) => update({ [field]: value });
  return (
    <section style={boxStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <b style={{ fontSize: 11.5 }}>{t('模型能力')}</b>
          <div style={summaryStyle}>{modelId} · {resolvedSummary(resolved, t)}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0 }}>
          {override && <button type="button" onClick={() => update(Object.fromEntries(
            ['contextWindowTokens', 'maxOutputTokens', 'supportsTools', 'supportsImages', 'supportsReasoning', 'reasoningEfforts', 'defaultReasoningEffort']
              .map((field) => [field, undefined]),
          ))} style={clearStyle}>{t('清除覆盖')}</button>}
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}
            style={clearStyle}>{t(expanded ? '收起' : '展开')}</button>
        </div>
      </div>
      {expanded && <>
        <div style={gridStyle}>
          <NumericOverride label="上下文窗口（tokens）" value={override?.contextWindowTokens}
            minimum={4_096} onCommit={(value) => update({ contextWindowTokens: value })} />
          <NumericOverride label="最大输出（tokens）" value={override?.maxOutputTokens}
            minimum={1} onCommit={(value) => update({ maxOutputTokens: value })} />
          <BooleanOverride label="工具调用" value={override?.supportsTools} onChange={booleanUpdate('supportsTools')} />
          <BooleanOverride label="图片输入" value={override?.supportsImages} onChange={booleanUpdate('supportsImages')} />
          <BooleanOverride label="推理能力" value={override?.supportsReasoning} onChange={booleanUpdate('supportsReasoning')} />
        </div>
        {error && <div style={{ ...summaryStyle, color: theme.danger }}>{t(error)}</div>}
        <div style={summaryStyle}>{t('留空会使用内置模型目录；未知模型使用带估算标记的保守回退值。')}</div>
      </>}
    </section>
  );
}

const boxStyle: React.CSSProperties = {
  marginTop: 10, borderTop: `0.5px solid ${theme.border}`, paddingTop: 10,
};
const gridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 9,
};
const fieldStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10.5, color: theme.textDim,
};
const inputStyle: React.CSSProperties = {
  font: 'inherit', fontSize: 11.5, background: theme.panelAlt, color: theme.text,
  border: `0.5px solid ${theme.border}`, borderRadius: 5, padding: '5px 7px', minWidth: 0,
};
const summaryStyle: React.CSSProperties = { fontSize: 10, color: theme.textDim, marginTop: 3 };
const clearStyle: React.CSSProperties = {
  border: 0, background: 'transparent', color: theme.textDim, textDecoration: 'underline', cursor: 'pointer', fontSize: 10.5,
};
