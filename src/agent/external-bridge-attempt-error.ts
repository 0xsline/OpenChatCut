import { EditorBridgeRequestError } from './external-bridge-registration';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** How many consecutive stale-409 reloads a page may attempt before giving up
 *  and falling back to a plain message. Guards against an infinite reload loop
 *  when the server keeps holding a stale editor registration for this project
 *  (e.g. an earlier page closed without unregistering) — reloading cannot
 *  clear that state, so it must not loop forever. */
const STALE_RELOAD_BUDGET = 3;
let staleReloadCount = 0;

/** Report a bridge-attempt failure and return whether its credential must refresh. */
export function handleExternalBridgeAttemptError(
  error: unknown,
  signal: AbortSignal,
  onError: (message: string | null) => void,
): boolean {
  const staleRegistration = error instanceof EditorBridgeRequestError
    && error.operation === 'registration'
    && error.status === 409;
  if (staleRegistration) {
    if (staleReloadCount < STALE_RELOAD_BUDGET) {
      staleReloadCount += 1;
      onError('The project changed after this browser loaded it. Reloading the authoritative revision.');
      window.location.reload();
    } else if (!signal.aborted) {
      onError('This project is already open in another editor session; reload is suppressed to avoid a reload loop.');
    }
    return false;
  }
  if (!signal.aborted) onError(errorMessage(error));
  return error instanceof EditorBridgeRequestError && error.status === 401;
}

export function resetExternalBridgeAttemptStateForTests(): void {
  staleReloadCount = 0;
}
