import { localDel, localGet, localKeys, localSet } from './sharedKvLocal';

export const MIGRATION_KEY = '__openchatcut_shared_store_v1__';
export const PENDING_KEYS_KEY = '__openchatcut_shared_pending_v1__';
export const locallyPendingKeys = new Set<string>();
export const isProjectDocumentKey = (key: string): boolean => /^project:[a-zA-Z0-9_-]{1,160}$/.test(key);

export async function loadPendingKeys(): Promise<void> {
  locallyPendingKeys.clear();
  const saved = await localGet<unknown>(PENDING_KEYS_KEY);
  if (!Array.isArray(saved)) return;
  for (const key of saved) {
    if (typeof key === 'string' && key !== MIGRATION_KEY && key !== PENDING_KEYS_KEY) {
      locallyPendingKeys.add(key);
    }
  }
}

export async function markPendingKey(key: string): Promise<void> {
  locallyPendingKeys.add(key);
  await localSet(PENDING_KEYS_KEY, [...locallyPendingKeys]);
}

export async function clearPendingKey(key: string): Promise<void> {
  locallyPendingKeys.delete(key);
  if (locallyPendingKeys.size) await localSet(PENDING_KEYS_KEY, [...locallyPendingKeys]);
  else await localDel(PENDING_KEYS_KEY);
}

export async function localEntries(): Promise<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};
  for (const key of await localKeys()) {
    if (key !== MIGRATION_KEY && key !== PENDING_KEYS_KEY) entries[key] = await localGet(key);
  }
  return entries;
}

/** Project bodies must be acknowledged individually; a successful merge can skip them. */
export async function acknowledgePendingKeys(
  submitted: Record<string, unknown>,
  accepted: Record<string, unknown>,
  recovered: ReadonlySet<string>,
): Promise<void> {
  for (const key of [...locallyPendingKeys]) {
    if (!Object.hasOwn(submitted, key)) continue;
    if (isProjectDocumentKey(key) && !recovered.has(key)
      && !sameStoredValue(submitted[key], accepted[key])) continue;
    await clearPendingKey(key);
  }
}

export function storedJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
}

export function sameStoredValue(left: unknown, right: unknown): boolean {
  return storedJson(left) === storedJson(right);
}
