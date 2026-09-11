// Device-local opt-in for VAD-backed silence removal.
//
// The capability used to be gated only by the build-time
// VITE_ENABLE_VAD_SILENCE_REMOVAL flag, so released binaries carried the
// bundled Silero model as unreachable bytes. The build flag stays the default
// (existing opt-in builds keep their behaviour) and this stored preference
// lets a user turn the capability on or off at runtime. Only the two written
// values are trusted; anything else means "not chosen" and defers to the
// build default, which is disabled.
export const VAD_SILENCE_REMOVAL_KEY = 'cc.vadSilenceRemoval';
export const VAD_SILENCE_REMOVAL_CHANGE_EVENT = 'cc:vad-silence-removal-change';

interface VadPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Stored tri-state: '1' enabled, '0' disabled, undefined not chosen.
 * The literals feed the same truthiness normalizer as the build flag, so
 * vadSilenceRemovalEnabled stays the single place that decides what is true.
 */
export function storedVadSilenceRemoval(
  storage?: VadPreferenceStorage,
): '1' | '0' | undefined {
  try {
    const stored = (storage ?? globalThis.localStorage)?.getItem(VAD_SILENCE_REMOVAL_KEY);
    return stored === '1' || stored === '0' ? stored : undefined;
  } catch {
    // Private mode and disabled storage mean "not chosen".
    return undefined;
  }
}

/**
 * The single gate for VAD-backed silence removal. A stored choice wins in both
 * directions; without one the build flag decides, so a build shipped with
 * VITE_ENABLE_VAD_SILENCE_REMOVAL keeps its behaviour and every other build
 * stays disabled until the user opts in.
 */
export function vadSilenceRemovalEnabled(
  storage?: VadPreferenceStorage,
  buildFlag: unknown = import.meta.env?.VITE_ENABLE_VAD_SILENCE_REMOVAL,
): boolean {
  const value = storedVadSilenceRemoval(storage) ?? buildFlag;
  return value === '1' || value === true || value === 'true';
}

export function setVadSilenceRemovalPreference(
  enabled: boolean,
  storage?: VadPreferenceStorage,
): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(VAD_SILENCE_REMOVAL_KEY, enabled === true ? '1' : '0');
  } catch {
    // An unwritable store keeps the build default; a preference write never throws.
  }
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(VAD_SILENCE_REMOVAL_CHANGE_EVENT));
    }
  } catch {
    // Observers must never break the preference write.
  }
}
