const AUTO_ANALYSIS_KEY = 'cc.musicAutoAnalysis';

type Listener = () => void;

const listeners = new Set<Listener>();
let memoryValue = false;
let listeningForStorage = false;
let storageUnavailable = false;

function readStored(): string | null | undefined {
  if (storageUnavailable) return undefined;
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage.getItem(AUTO_ANALYSIS_KEY);
  } catch {
    storageUnavailable = true;
    return undefined;
  }
}

function notify(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* observers cannot break preference persistence */ }
  }
}

function onStorage(event: StorageEvent): void {
  if (event.key !== AUTO_ANALYSIS_KEY && event.key !== null) return;
  memoryValue = event.key === AUTO_ANALYSIS_KEY && event.newValue === '1';
  notify();
}

function ensureStorageListener(): void {
  if (listeningForStorage || typeof window === 'undefined') return;
  window.addEventListener('storage', onStorage);
  listeningForStorage = true;
}

/** Global, device-local opt-in. Missing or malformed storage always means disabled. */
export function getAutoMusicAnalysisEnabled(): boolean {
  const stored = readStored();
  if (stored !== undefined) {
    memoryValue = stored === '1';
    return memoryValue;
  }
  return memoryValue;
}

export function setAutoMusicAnalysisEnabled(enabled: boolean): void {
  const normalized = enabled === true;
  if (getAutoMusicAnalysisEnabled() === normalized) return;
  memoryValue = normalized;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(AUTO_ANALYSIS_KEY, normalized ? '1' : '0');
  } catch {
    // Node verifies, privacy mode, and exhausted quota retain the in-memory value.
    storageUnavailable = true;
  }
  notify();
}

export function subscribeAutoMusicAnalysis(listener: Listener): () => void {
  listeners.add(listener);
  ensureStorageListener();
  return () => listeners.delete(listener);
}
