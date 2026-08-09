export interface AgentArtifactRef {
  readonly artifactId: string;
  readonly bodySha256: string;
  readonly originalChars: number;
  readonly storedBytes: number;
  readonly redacted: boolean;
  readonly binaryOmitted: boolean;
}
export interface SanitizedArtifactJson {
  readonly body: string;
  readonly originalChars: number;
  readonly storedBytes: number;
  readonly redacted: boolean;
  readonly binaryOmitted: boolean;
}
export interface PersistedAgentToolResult {
  readonly archived: true;
  readonly artifactRef: AgentArtifactRef;
  readonly preview: string;
  readonly privacyNote?: string;
}

export const AGENT_ARTIFACT_REF = Symbol('openchatcut.agent-artifact-ref');
const fallbackRefs = new WeakMap<object, AgentArtifactRef>();
const REDACTED = '[REDACTED]';
const BINARY_OMITTED = '[BINARY_OMITTED]';
const SECRET_KEY = /api[-_]?key|access[-_]?key|authorization|cookie|password|secret|credential|private[-_]?key|(?:^|[-_])token(?:$|[-_])|(?:access|refresh|auth|id)token$|^x-(?:amz|goog)-.+$/i;
const SIGNED_QUERY = /^(?:key|sig|signature|x-(?:amz|goog)-.+)$/i;
const AZURE_SAS_QUERY = /^(?:sig|se|sp|spr|sr|srt|ss|st|sv|sip|skoid|sktid|skt|ske|sks|skv)$/i;
const BINARY_KEY = /^(?:base64|blob|bytes|binary)$/i;

type SanitizedState = { redacted: boolean; binaryOmitted: boolean };
function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) || SIGNED_QUERY.test(key);
}

function redactUrlParams(params: URLSearchParams, state: SanitizedState): void {
  const keys = [...params.keys()];
  const signed = keys.some((key) => SIGNED_QUERY.test(key));
  const azureSas = keys.some((key) => /^sig$/i.test(key))
    && keys.some((key) => AZURE_SAS_QUERY.test(key) && !/^sig$/i.test(key));
  for (const key of keys) {
    if (isSecretKey(key)
        || (signed && /^expires$/i.test(key))
        || (azureSas && AZURE_SAS_QUERY.test(key))) {
      params.set(key, REDACTED);
      state.redacted = true;
    }
  }
}


function redactOneUrl(value: string, state: SanitizedState): string {
  if (/^data:/i.test(value)) {
    state.binaryOmitted = true;
    return BINARY_OMITTED;
  }
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      state.redacted = true;
    }
    redactUrlParams(parsed.searchParams, state);
    if (parsed.hash.includes('=')) {
      const fragment = new URLSearchParams(parsed.hash.slice(1));
      redactUrlParams(fragment, state);
      parsed.hash = fragment.toString();
    }
    return parsed.toString().replaceAll('%5BREDACTED%5D', REDACTED);
  } catch {
    return value;
  }
}
function redactUrl(value: string, state: SanitizedState): string {
  return value
    .replace(/data:[^,\s]+;base64,[a-z0-9+/=]+/gi, () => {
      state.binaryOmitted = true;
      return BINARY_OMITTED;
    })
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactOneUrl(url, state));
}
const TEXT_SECRET = String.raw`(?:(?:[a-z0-9]{1,32}[-_]){0,4}(?:token|api[-_ ]?key|access[-_ ]?key|authorization|cookie|password|secret|credential|private[-_ ]?key)|accessToken|refreshToken|authToken|idToken)`;
function redactTextSecrets(value: string, state: SanitizedState): string {
  let text = redactUrl(value, state);
  const patterns: ReadonlyArray<[RegExp, string]> = [
    [new RegExp(`(^|\\r?\\n)(\\s*${TEXT_SECRET}\\s*:\\s*)[^\\r\\n]*`, 'gi'), '$1$2[REDACTED]'],
    [new RegExp(`(["']?${TEXT_SECRET}["']?\\s*[:=]\\s*)(["'])[^"'\\r\\n]*\\2`, 'gi'), '$1$2[REDACTED]$2'],
    [new RegExp(`(\\b${TEXT_SECRET}\\b\\s*(?:=|:)\\s*)(?!["'])[^\\s,;}&#\\r\\n]+`, 'gi'), '$1[REDACTED]'],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  ];
  for (const [pattern, replacement] of patterns) {
    const next = text.replace(pattern, replacement);
    if (next !== text) state.redacted = true;
    text = next;
  }
  return text;
}


function sanitizeValue(
  value: unknown,
  state: SanitizedState,
  seen: WeakSet<object>,
  key = '',
): unknown {
  if (isSecretKey(key)) {
    state.redacted = true;
    return REDACTED;
  }
  if (typeof value === 'string') {
    if (/^data:/i.test(value)) {
      state.binaryOmitted = true;
      return BINARY_OMITTED;
    }
    if (BINARY_KEY.test(key) && value.length > 256) {
      state.binaryOmitted = true;
      return BINARY_OMITTED;
    }
    return redactTextSecrets(value, state);
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)
      || (typeof Blob !== 'undefined' && value instanceof Blob)) {
    state.binaryOmitted = true;
    return BINARY_OMITTED;
  }
  if (seen.has(value)) throw new Error('Artifact result is not JSON-serializable.');
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => sanitizeValue(item, state, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [entryKey, item] of Object.entries(value)) {
    result[entryKey] = sanitizeValue(item, state, seen, entryKey);
  }

  seen.delete(value);
  return result;
}
export function redactTextForAgentRuntime(value: string): string {
  const state: SanitizedState = { redacted: false, binaryOmitted: false };
  return sanitizeValue(value, state, new WeakSet()) as string;
}

/** Deterministic privacy projection. The original live/UI value is never mutated. */
export function sanitizeJsonForArtifact(value: unknown): SanitizedArtifactJson | null {
  let original: string | undefined;
  try { original = JSON.stringify(value); } catch { return null; }
  if (typeof original !== 'string') return null;
  const state: SanitizedState = { redacted: false, binaryOmitted: false };
  let body: string;
  try { body = JSON.stringify(sanitizeValue(value, state, new WeakSet())); } catch { return null; }
  return {
    body,
    originalChars: original.length,
    storedBytes: new TextEncoder().encode(body).byteLength,
    redacted: state.redacted,
    binaryOmitted: state.binaryOmitted,
  };
}

export function attachAgentArtifactRef<T>(value: T, ref: AgentArtifactRef): T {
  if (!value || typeof value !== 'object') return value;
  fallbackRefs.set(value, ref);
  if (Object.isExtensible(value)) {
    Object.defineProperty(value, AGENT_ARTIFACT_REF, {
      value: ref, enumerable: false, configurable: false,
    });
  }
  return value;
}
export function agentArtifactRefOf(value: unknown): AgentArtifactRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return (value as { [AGENT_ARTIFACT_REF]?: AgentArtifactRef })[AGENT_ARTIFACT_REF]
    ?? fallbackRefs.get(value);
}
export function artifactPlaceholder(ref: AgentArtifactRef): Record<string, unknown> {
  return {
    archived: true,
    artifactId: ref.artifactId,
    bodySha256: ref.bodySha256,
    originalChars: ref.originalChars,
    redacted: ref.redacted,
    binaryOmitted: ref.binaryOmitted,
    readHint: `Call read_agent_artifact with artifactId=${ref.artifactId}; use pointer/offset/limit for a narrow reread.`,
  };
}

function projectSanitizedArtifactRefs(source: unknown, sanitized: unknown): unknown {
  const ref = agentArtifactRefOf(source);
  if (ref) {
    let preview = '[archived result preview unavailable]';
    try {
      const body = JSON.stringify(sanitized);
      if (typeof body === 'string') preview = body.slice(0, 900);
    } catch {
      // The sanitizer already proved the outer result serializable. Keep the
      // fail-closed preview if a hostile nested value changes during save.
    }
    const privacy = [
      ref.redacted ? 'sensitive values redacted' : '',
      ref.binaryOmitted ? 'binary payload omitted' : '',
    ].filter(Boolean).join('; ');
    return {
      archived: true,
      artifactRef: ref,
      preview,
      ...(privacy ? { privacyNote: privacy } : {}),
    } satisfies PersistedAgentToolResult;
  }
  if (Array.isArray(source) && Array.isArray(sanitized)) {
    return sanitized.map((item, index) => projectSanitizedArtifactRefs(source[index], item));
  }
  if (!source || typeof source !== 'object'
      || !sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return sanitized;
  }
  return Object.fromEntries(Object.entries(sanitized).map(([key, item]) => [
    key,
    projectSanitizedArtifactRefs((source as Record<string, unknown>)[key], item),
  ]));
}


/**
 * Pure save-time projection: React/UI/provider state remains complete. Every
 * durable tool result is detached and sanitized, even when it is small or
 * deliberately exempt from artifact archival (for example load_skill).
 */
export function projectToolResultForPersistence(value: unknown): unknown {
  const sanitized = sanitizeJsonForArtifact(value);
  if (!sanitized) return '[tool result omitted: not safely serializable]';
  return projectSanitizedArtifactRefs(value, JSON.parse(sanitized.body) as unknown);
}
