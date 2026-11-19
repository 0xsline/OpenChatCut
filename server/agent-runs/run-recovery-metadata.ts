import type { ServerRun } from './store-types';
import type { readRunRecoveryProjection } from './run-recovery-runtime';

/**
 * A cursor that fell out of the replay window cannot be repaired by moving it:
 * the events it skipped are gone, and replaying nothing would make the UI show
 * a run as if it had just started. Instead the server states the display
 * baseline it can vouch for — the confirmed tool outcomes, the last committed
 * event id, and the recovery revision they belong to — and the browser installs
 * that baseline before it may subscribe again.
 */
export function withRecoveryBaseline(
  run: ServerRun,
  window: { readonly firstEventId: number; readonly lastEventId: number },
  recovery: ReturnType<typeof readRunRecoveryProjection>,
): (NonNullable<ReturnType<typeof readRunRecoveryProjection>> & {
  readonly replayBase?: {
    readonly firstEventId: number;
    readonly lastEventId: number;
    readonly revision: number;
    readonly resetsCursor: boolean;
    readonly terminalText: string | null;
  };
}) | null {
  if (!recovery) return null;
  // text-end stores lengths. Only publish a text segment if all of its
  // deltas survived retention; a suffix would look like a complete answer.
  let segment: string | null = null;
  let text: string | null = null;
  for (const event of run.events) {
    if (event.type === 'text-start') segment = '';
    if (segment === null) continue;
    const data = event.data as { text?: string; characterCount?: number } | null;
    if (event.type === 'text-delta' && typeof data?.text === 'string') segment += data.text;
    if (event.type === 'text-end') {
      text = segment.length === data?.characterCount ? segment : null;
      segment = null;
    }
  }
  return {
    ...recovery,
    replayBase: {
      firstEventId: window.firstEventId,
      lastEventId: window.lastEventId,
      revision: recovery.revision,
      // Anything at or before firstEventId-1 is unreplayable, so the browser
      // must adopt the baseline rather than ask for a cursor it cannot get.
      resetsCursor: true,
      terminalText: text,
    },
  };
}
