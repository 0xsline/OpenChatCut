export const DESKTOP_NATIVE_INFERENCE_KEY = 'cc.desktopNativeInference';
export const DESKTOP_NATIVE_INFERENCE_CHANGE_EVENT = 'cc:desktop-native-inference-change';

interface InferencePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function preferenceStorage(): InferencePreferenceStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function desktopNativeInferenceEnabled(
  storage: InferencePreferenceStorage | undefined = preferenceStorage(),
): boolean {
  try {
    return storage?.getItem(DESKTOP_NATIVE_INFERENCE_KEY) === '1';
  } catch {
    return false;
  }
}

async function applyDesktopNativeInferenceEnabled(enabled: boolean): Promise<void> {
  const bridge = typeof window === 'undefined' ? undefined : window.openChatCutDesktop?.inference;
  if (typeof bridge?.setEnabled === 'function') await bridge.setEnabled(enabled);
}

export async function syncDesktopNativeInferenceEnabled(): Promise<boolean> {
  const enabled = desktopNativeInferenceEnabled();
  await applyDesktopNativeInferenceEnabled(enabled);
  return enabled;
}

export async function setDesktopNativeInferenceEnabled(
  enabled: boolean,
  storage: InferencePreferenceStorage | undefined = preferenceStorage(),
): Promise<void> {
  await applyDesktopNativeInferenceEnabled(enabled);
  try {
    storage?.setItem(DESKTOP_NATIVE_INFERENCE_KEY, enabled ? '1' : '0');
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(DESKTOP_NATIVE_INFERENCE_CHANGE_EVENT));
  } catch {
    // The default remains disabled when browser storage is unavailable.
  }
}
