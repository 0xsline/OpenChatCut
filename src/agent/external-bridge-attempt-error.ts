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
  const staleRegistration = error instanceof EditorBridgeRequestError
    && error.operation === 'registration'
    && error.status === 409;
  if (staleRegistration) {
    if (!signal.aborted) {
      onError('工程已在其他窗口编辑或版本已变化，请关闭其他窗口后手动刷新页面。');
    }
    return false;
  }
  if (!signal.aborted) onError(errorMessage(error));
  return error instanceof EditorBridgeRequestError && error.status === 401;
}

