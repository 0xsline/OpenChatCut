import type { TimelineState } from '../editor/types';

// Minimal IndexedDB key-value store for the current project, so a reload doesn't
// lose the timeline. One DB, one store, one key — no dependency needed. This is
// the local-first stand-in for the source's Rocicorp Zero + IndexedDB layer;
// when multi-project lands, KEY becomes the project id.
const DB_NAME = 'chatcut-clone';
const STORE = 'kv';
const KEY = 'project';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Validate at the boundary — persisted data is untrusted (stale/corrupt/other tab).
function isTimelineState(v: unknown): v is TimelineState {
  return !!v && typeof v === 'object'
    && Array.isArray((v as { items?: unknown }).items)
    && typeof (v as { fps?: unknown }).fps === 'number';
}

export async function loadProject(): Promise<TimelineState | null> {
  try {
    const db = await openDb();
    const value = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return isTimelineState(value) ? value : null;
  } catch {
    return null; // no IndexedDB (private mode / SSR): start fresh
  }
}

export async function saveProject(state: TimelineState): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore persist failures; the session still works in-memory */
  }
}

export async function clearProject(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}
