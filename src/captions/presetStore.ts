import type { CaptionStyleOverride } from './styles';
import type { CaptionTemplate, CaptionPacing } from './types';

// User-saved caption style presets (edit_captions preset_save/apply/list/rename/
// delete). A tiny IndexedDB store of its own (isolated from the project DB so there's no
// schema-version coordination), keyed by preset id. Falls back to an in-memory Map when
// IndexedDB is unavailable (node checks / headless) so the agent actions stay testable.
const DB_NAME = 'openchatcut-captions';
const STORE = 'presets';
const memory = new Map<string, CaptionPreset>();
const hasIdb = (): boolean => typeof indexedDB !== 'undefined';

/** A saved caption look: the template + style overrides + pacing the user styled. */
export interface CaptionPreset {
  id: string;
  name: string;
  template?: CaptionTemplate;
  styleOverride?: Partial<CaptionStyleOverride>;
  pacing?: CaptionPacing;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listCaptionPresets(): Promise<CaptionPreset[]> {
  if (!hasIdb()) return [...memory.values()].sort((a, b) => a.createdAt - b.createdAt);
  const db = await openDb();
  const presets = await new Promise<CaptionPreset[]>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as CaptionPreset[]);
    req.onerror = () => reject(req.error);
  });
  return presets.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveCaptionPreset(preset: CaptionPreset): Promise<void> {
  if (!hasIdb()) { memory.set(preset.id, preset); return; }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(preset);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteCaptionPreset(id: string): Promise<void> {
  if (!hasIdb()) { memory.delete(id); return; }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Resolve a preset by exact id, id prefix, or exact name (undefined if none). */
export async function resolveCaptionPreset(idOrName: string): Promise<CaptionPreset | undefined> {
  const q = idOrName.trim();
  if (!q) return undefined;
  const all = await listCaptionPresets();
  return all.find((p) => p.id === q) ?? all.find((p) => p.id.startsWith(q)) ?? all.find((p) => p.name === q);
}

/** Test helper: wipe the in-memory fallback (no-op when IDB is real). */
export function __resetCaptionPresetMemory(): void {
  memory.clear();
}
