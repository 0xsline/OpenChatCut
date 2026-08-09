import { MODEL_CAPABILITY_OVERRIDES_KEY } from '../shared/model-capabilities.ts';

/** One .env line. dotenv-expand interpolates unescaped dollars, while dotenv
 * strips matching outer delimiters and treats an unquoted `#` as a comment. */
const ENCODED_VALUE_PREFIX = '__OPENCHATCUT_URI__:';
function envLine(name: string, value: string): string {
  const escaped = value.replace(/\$/g, '\\$');
  const fullyQuoted = escaped.length >= 2
    && ['"', "'", '`'].some((delimiter) => escaped.startsWith(delimiter) && escaped.endsWith(delimiter));
  if (!escaped.includes("#") && !fullyQuoted) return `${name}=${escaped}`;
  const candidates = ["'", '`', '"'];
  const delimiter = candidates.find((candidate) => (
    !escaped.includes(candidate) && (candidate !== '"' || !/\\[nr]/.test(escaped))
  ));
  if (delimiter) return `${name}=${delimiter}${escaped}${delimiter}`;
  if (name === MODEL_CAPABILITY_OVERRIDES_KEY) {
    return `${name}=${ENCODED_VALUE_PREFIX}${encodeURIComponent(value)}`;
  }
  throw new Error(`invalid value for ${name}: cannot persist losslessly in dotenv`);
}

/** Merge `patch` into a .env file's text: update lines whose key matches and append
 * genuinely-new keys while preserving comments, blanks, and unrelated vars.
 * Default-mode empty values remove keys. Isolated profiles retain `NAME=` tombstones
 * so a cleared inherited checkout/shell value cannot reappear after restart. */
export function mergeEnvText(
  existing: string,
  patch: Map<string, string>,
  preserveEmpty = false,
): string {
  const lines = existing.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (match && patch.has(match[1])) {
      seen.add(match[1]);
      const value = patch.get(match[1])!;
      if (value || preserveEmpty) out.push(envLine(match[1], value));
    } else {
      out.push(line);
    }
  }
  for (const [name, value] of patch) {
    if (!seen.has(name) && (value || preserveEmpty)) out.push(envLine(name, value));
  }
  return `${out.join("\n")}\n`;
}

/** Decode the explicit fallback used when no dotenv quote delimiter is lossless. */
export function decodePersistedEnvValue(value: string): string {
  if (!value.startsWith(ENCODED_VALUE_PREFIX)) return value;
  try {
    return decodeURIComponent(value.slice(ENCODED_VALUE_PREFIX.length));
  } catch {
    throw new Error('invalid encoded dotenv value');
  }
}

/** Parse the same dotenv subset emitted above for the Electron startup path. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const delimiter = value[0];
    if (value.length >= 2 && ['"', "'", '`'].includes(delimiter) && value.endsWith(delimiter)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf('#');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    value = value.replace(/\\\$/g, '$');
    if (value) out[match[1]] = value;
  }
  return out;
}
