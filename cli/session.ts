// The CLI's only write path: an offline edit session, which is the exact contract
// MCP external agents already use (server/external-agent/offline-runtime.ts).
//
// Consequences worth knowing before editing this file:
//  * the draft is committed atomically at review, so a failed command leaves the
//    project untouched (no half-applied timeline);
//  * the commit is revision-checked against the store, so a concurrent write wins
//    with an error instead of being overwritten;
//  * the commit path snapshots a pre-edit version, so every `--apply` is undoable
//    from the app's version history;
//  * ownership is claimed while the session lives, so an open editor blocks the
//    write instead of racing it.
import { OfflineExternalEditRuntime } from '../server/external-agent/offline-runtime.ts';
import { CliError } from './errors.ts';

export const CLI_CLIENT_NAME = 'occ CLI';

export interface ToolInvocation {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolExecution {
  readonly tool: string;
  readonly result: unknown;
}

export interface SessionOutcome {
  readonly applied: boolean;
  readonly executions: readonly ToolExecution[];
  readonly terminal: unknown;
  /** The ops ran but staged nothing (for example every imported file was already
   *  in the pool), so there was nothing to commit and the draft was discarded. */
  readonly noChanges: boolean;
}

function editorUrl(projectId: string): string {
  const base = (process.env.OPENCHATCUT_EDITOR_URL ?? 'http://localhost:5199').replace(/\/+$/, '');
  return `${base}/#/editor/${encodeURIComponent(projectId)}`;
}

function editSessionIdOf(begun: unknown): string {
  const id = begun && typeof begun === 'object' && 'editSessionId' in begun
    ? begun.editSessionId
    : undefined;
  if (typeof id !== 'string' || !id) {
    throw new CliError('The edit session did not return an id; nothing was written.');
  }
  return id;
}

async function operationCount(runtime: OfflineExternalEditRuntime, editSessionId: string): Promise<number> {
  const info = await runtime.execute('get_edit_session', { editSessionId });
  const count = info !== null && typeof info === 'object' && 'operationCount' in info
    ? info.operationCount
    : undefined;
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

/**
 * Run tool invocations inside one draft. `apply: false` discards the draft after
 * running — the caller gets to show what would change while the project stays
 * byte-identical.
 */
export async function runToolSession(
  projectId: string,
  invocations: readonly ToolInvocation[],
  options: { readonly apply: boolean; readonly summary?: string },
): Promise<SessionOutcome> {
  const runtime = await OfflineExternalEditRuntime.create(projectId, editorUrl(projectId));
  try {
    const begun = await runtime.execute('begin_edit_session', {
      clientName: CLI_CLIENT_NAME,
      approvalMode: 'auto',
    });
    const editSessionId = editSessionIdOf(begun);
    const executions: ToolExecution[] = [];
    for (const invocation of invocations) {
      executions.push({
        tool: invocation.tool,
        result: await runtime.execute(invocation.tool, { ...invocation.args, editSessionId }),
      });
    }
    // A commit needs staged changes; an operation that legitimately changes nothing
    // (all imported files were duplicates, an idempotent re-run) must not fail. Ask
    // the session what it staged and discard instead of reviewing an empty draft.
    const staged = options.apply ? await operationCount(runtime, editSessionId) : 0;
    if (options.apply && staged === 0) {
      const terminal = await runtime.execute('discard_edit_session', { editSessionId });
      return { applied: false, executions, terminal, noChanges: true };
    }
    const terminal = options.apply
      ? await runtime.execute('review_edit_session', {
        editSessionId,
        ...(options.summary ? { summary: options.summary } : {}),
      })
      : await runtime.execute('discard_edit_session', { editSessionId });
    return { applied: options.apply, executions, terminal, noChanges: false };
  } finally {
    await runtime.dispose();
  }
}
