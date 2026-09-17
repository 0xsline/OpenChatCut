// One shape for every writing command: run the ops inside a single offline edit
// session, then report either the commit or the discarded draft. Keeping this in
// one place is what makes `--apply` mean the same thing in `tools call`,
// `edit --ops`, and the `item` sugar commands.
import type { ToolOp } from '../tool-catalog.ts';
import { printJson, writeStdout } from '../output.ts';
import { runToolSession } from '../session.ts';

export interface ToolOpRun {
  readonly projectId: string;
  readonly projectName: string;
  readonly ops: readonly ToolOp[];
  readonly apply: boolean;
  readonly summary?: string;
  readonly json: boolean;
  /** Human label for the commit line, e.g. "move clip". */
  readonly label: string;
}

export async function runToolOps(run: ToolOpRun): Promise<void> {
  const outcome = await runToolSession(run.projectId, run.ops, {
    apply: run.apply,
    ...(run.summary ? { summary: run.summary } : {}),
  });
  if (run.json) {
    printJson({
      projectId: run.projectId,
      applied: outcome.applied,
      noChanges: outcome.noChanges,
      ops: outcome.executions,
      terminal: outcome.terminal,
    });
    return;
  }
  for (const execution of outcome.executions) {
    writeStdout(`${execution.tool}: ${JSON.stringify(execution.result)}`);
  }
  if (outcome.noChanges) {
    writeStdout(`nothing to commit — ${run.projectName} unchanged (the operation staged no changes).`);
    return;
  }
  writeStdout(outcome.applied
    ? `committed ${run.label} to ${run.projectName} (${run.projectId})`
    : `draft discarded — ${run.projectName} unchanged. Add --apply to commit.`);
}
