import type { ModelMessage } from 'ai';

type Path = Array<string | number>;
type SpecialValue = { path: Path; type: 'bytes' | 'buffer' | 'url' };

/**
 * Provider metadata and tool-call/result parts retain their AI SDK shape.
 * JSON.stringify alone loses the type of URL, ArrayBuffer and Uint8Array
 * content. Keep their types outside user-controlled messages, so tool output
 * resembling a type annotation is always restored as plain data.
 */
export function encodeApiRecoveryMessages(messages: readonly ModelMessage[]): string {
  const special: SpecialValue[] = [];
  const ancestors = new Set<object>();
  function encode(value: unknown, path: Path): unknown {
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof URL) {
      special.push({ path, type: 'url' });
      return value.href;
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      special.push({ path, type: value instanceof Uint8Array ? 'bytes' : 'buffer' });
      const bytes = value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
      return bytes.toString('base64');
    }
    if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Invalid API recovery message content.');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((item, index) => encode(item, [...path, index]));
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error('Unsupported API recovery content type.');
      return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, encode(item, [...path, key])]));
    } finally {
      ancestors.delete(value);
    }
  }

  const data = encode(messages, []);
  return JSON.stringify(special.length ? { version: 1, data, special } : data);
}

export function decodeApiRecoveryMessages(serialized: string): ModelMessage[] {
  const wire = JSON.parse(serialized);
  if (Array.isArray(wire)) return wire;
  const invalid = () => new Error('Invalid API recovery message encoding.');
  if (wire?.version !== 1 || !Array.isArray(wire.data) || !Array.isArray(wire.special)) throw invalid();
  for (const entry of wire.special) {
    if (!entry || !Array.isArray(entry.path) || !entry.path.length
        || !entry.path.every((key: unknown) => typeof key === 'string'
          || (typeof key === 'number' && Number.isSafeInteger(key) && key >= 0))) throw invalid();
    let parent = wire.data;
    for (const key of entry.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw invalid();
      parent = parent[key];
    }
    const key = entry.path.at(-1);
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw invalid();
    const content = parent[key];
    if (typeof content !== 'string') throw invalid();
    if (entry.type === 'url') parent[key] = new URL(content);
    else if (entry.type === 'bytes' || entry.type === 'buffer') {
      const decoded = Buffer.from(content, 'base64');
      if (decoded.toString('base64') !== content) throw invalid();
      const bytes = Uint8Array.from(decoded);
      parent[key] = entry.type === 'buffer' ? bytes.buffer : bytes;
    } else throw invalid();
  }
  return wire.data;
}
