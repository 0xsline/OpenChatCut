// Tiny app-wide toast bus (no React context). Timeline drop, Library audio-fx,
// and Inspector can all flash status without prop-drilling through Editor.

export interface AppToast {
  msg: string;
  error?: boolean;
  /** Auto-dismiss ms; 0 = sticky until next toast / dismiss. Default 3200. */
  ms?: number;
}

type Listener = (toast: AppToast | null) => void;

const listeners = new Set<Listener>();

export function showAppToast(msg: string, opts?: { error?: boolean; ms?: number }): void {
  const toast: AppToast = {
    msg,
    error: opts?.error,
    ms: opts?.ms ?? (opts?.error ? 6000 : 3200),
  };
  for (const l of listeners) l(toast);
}

export function clearAppToast(): void {
  for (const l of listeners) l(null);
}

export function subscribeAppToast(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
