import type { ProjectStoreRequest } from './project-store-transport.ts';

const VALID_KEY = /^(?!__proto__$)(?!prototype$)(?!constructor$)[a-zA-Z0-9:_-]{1,200}$/;
const MAX_ENTRY_COUNT = 20_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function isProjectStoreKey(value: unknown): value is string {
  return typeof value === 'string' && VALID_KEY.test(value);
}

export function isProjectStoreEntries(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length <= MAX_ENTRY_COUNT
    && Object.keys(value).every(isProjectStoreKey);
}

export function isProjectStoreRequest(value: unknown): value is ProjectStoreRequest {
  if (!isRecord(value) || typeof value.operation !== 'string') return false;
  if (value.operation === 'snapshot') return Object.keys(value).length === 1;
  if (value.operation === 'entry' || value.operation === 'delete') {
    return Object.keys(value).length === 2 && isProjectStoreKey(value.key);
  }
  if (value.operation === 'merge') {
    return Object.keys(value).length === 2 && isProjectStoreEntries(value.entries);
  }
  if (value.operation === 'set') {
    return Object.keys(value).length === 3 && isProjectStoreKey(value.key) && Object.hasOwn(value, 'value');
  }
  return false;
}
