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
    const terminal = options.apply
      ? await runtime.execute('review_edit_session', {
        editSessionId,
        ...(options.summary ? { summary: options.summary } : {}),
      })
      : await runtime.execute('discard_edit_session', { editSessionId });
    return { applied: options.apply, executions, terminal };
  } finally {
    await runtime.dispose();
  }
}
