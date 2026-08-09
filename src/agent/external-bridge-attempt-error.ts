import { EditorBridgeRequestError } from './external-bridge-registration';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

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
    onError('The project changed after this browser loaded it. Reloading the authoritative revision.');
    window.location.reload();
  }
  if (!signal.aborted && !staleRegistration) onError(errorMessage(error));
  return error instanceof EditorBridgeRequestError && error.status === 401;
}
