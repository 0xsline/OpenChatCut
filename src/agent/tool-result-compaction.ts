import { agentArtifactRefOf, artifactPlaceholder } from './runtime-artifact';

const MODEL_RESULT_MAX_CHARS = 16_000;
const FIRST_PASS_ARRAY_ITEMS = 40;
const FIRST_PASS_STRING_CHARS = 4_000;
const FINAL_PASS_ARRAY_ITEMS = 12;
const FINAL_PASS_STRING_CHARS = 1_000;
const MAX_OBJECT_FIELDS = 80;

type JsonRecord = Record<string, unknown>;

interface Limits {
  readonly arrayItems: number;
  readonly stringChars: number;
}

function compactValue(value: unknown, limits: Limits, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    if (value.length <= limits.stringChars) return value;
    return `${value.slice(0, limits.stringChars)}\n…[${value.length - limits.stringChars} chars omitted]`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular value omitted]';
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, limits.arrayItems).map((item) => compactValue(item, limits, seen));
    return value.length <= limits.arrayItems
      ? items
      : [...items, { omittedItems: value.length - limits.arrayItems }];
  }

  const result: JsonRecord = {};
  const entries = Object.entries(value).slice(0, MAX_OBJECT_FIELDS);
  for (const [key, item] of entries) result[key] = compactValue(item, limits, seen);
  if (Object.keys(value).length > entries.length) {
    result.omittedFields = Object.keys(value).length - entries.length;
  }
  return result;
}

function withTruncationNotice(value: unknown, originalChars: number): unknown {
  const notice = {
    truncatedForModel: true,
    originalChars,
    detailHint: 'Use tool filters, frame range, item/asset id, or pagination to reread only the needed detail.',
  };
  if (Array.isArray(value)) return { items: value, ...notice };
  if (value && typeof value === 'object') return { ...value, ...notice };
  return { value, ...notice };
}

function jsonText(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

function jsonLength(value: unknown): number {
  return jsonText(value)?.length ?? Number.POSITIVE_INFINITY;
}

/** Keep model-visible tool history bounded while the UI retains the complete execution result. */
export function compactToolResultForModel(value: unknown): unknown {
  const artifactRef = agentArtifactRefOf(value);
  if (artifactRef) return artifactPlaceholder(artifactRef);
  const originalText = jsonText(value);
  if (originalText !== null && originalText.length <= MODEL_RESULT_MAX_CHARS) return value;

  const firstPass = compactValue(value, {
    arrayItems: FIRST_PASS_ARRAY_ITEMS,
    stringChars: FIRST_PASS_STRING_CHARS,
  }, new WeakSet());
  const candidate = withTruncationNotice(firstPass, originalText?.length ?? 0);
  if (jsonLength(candidate) <= MODEL_RESULT_MAX_CHARS) return candidate;

  const finalPass = compactValue(value, {
    arrayItems: FINAL_PASS_ARRAY_ITEMS,
    stringChars: FINAL_PASS_STRING_CHARS,
  }, new WeakSet());
  const finalCandidate = withTruncationNotice(finalPass, originalText?.length ?? 0);
  if (jsonLength(finalCandidate) <= MODEL_RESULT_MAX_CHARS) return finalCandidate;
  return {
    truncatedForModel: true,
    originalChars: originalText?.length ?? 0,
    preview: (jsonText(finalPass) ?? String(finalPass)).slice(0, MODEL_RESULT_MAX_CHARS - 1_000),
    detailHint: 'Result exceeded the model limit. Reread with a narrow filter, id, frame range, or page.',
  };
}

/** Preserve binary image payloads for multimodal Codex transport; compact only accompanying metadata. */
export function compactToolResultForTransport(value: unknown, preserveImages: boolean): unknown {
  if (!preserveImages || !value || typeof value !== 'object' || Array.isArray(value)
      || !('__images' in value)) return compactToolResultForModel(value);
  const { __images } = value as JsonRecord;
  const artifactRef = agentArtifactRefOf(value);
  const compacted = artifactRef
    ? artifactPlaceholder(artifactRef)
    : compactToolResultForModel(Object.fromEntries(
      Object.entries(value as JsonRecord).filter(([key]) => key !== '__images'),
    ));
  const safeMetadata = compacted && typeof compacted === 'object' && !Array.isArray(compacted)
    ? compacted as JsonRecord
    : { value: compacted };
  return { ...safeMetadata, __images };
}
