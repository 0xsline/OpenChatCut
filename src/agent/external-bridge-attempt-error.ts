import { EditorBridgeRequestError } from './external-bridge-registration';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Report bridge conflicts without navigating away from the editor. A page reload can trigger
 * the browser's beforeunload guard while autosave is pending, and reloading cannot clear a
 * persisted editor-registration conflict. */
export function handleExternalBridgeAttemptError(
  error: unknown,
  signal: AbortSignal,
  onError: (message: string | null) => void,
): boolean {
  // HTTP 409 = the editor registration/poll lost its lease (another window took
  // over, or a transient registration mismatch in a single window). runBridge
  // retries and re-registers within ~1s, so surfacing a blocking "close the
  // other window" message on a single 409 only produces an alarming flash.
  // Swallow 409 and let the retry loop recover silently.
  if (error instanceof EditorBridgeRequestError && error.status === 409) {
    return false;
  }
  if (!signal.aborted) onError(errorMessage(error));
  return error instanceof EditorBridgeRequestError && error.status === 401;
}

