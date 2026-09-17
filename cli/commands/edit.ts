// `occ edit` — several tool calls, one atomic commit.
//
// A video edit is rarely one tool call: retarget the canvas, place clips, add a
// watermark. Running each in its own session would commit intermediate states a
// user never asked for (and, per the MCP session contract, each commit staleness
// would invalidate the next session). `--ops` runs the whole list inside one draft
// and commits once, or discards everything.
import { readFileSync } from 'node:fs';
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { UsageError } from '../errors.ts';
import { printJson, writeStdout } from '../output.ts';
import { runToolSession } from '../session.ts';
import { resolveProject } from '../store.ts';
import { parseToolOps } from '../tool-catalog.ts';
import { GLOBAL_FLAGS, projectReference } from './common.ts';

const FLAGS = [...GLOBAL_FLAGS, 'ops', 'apply', 'summary'] as const;

export async function runEditCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);
  const raw = flagText(commandLine, 'ops');
  if (raw === undefined) {
    throw new UsageError('edit needs --ops \'[{"tool":"set_aspect_ratio","args":{"ratio":"9:16"}}]\' (or --ops @ops.json)');
  }
  const ops = parseToolOps(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw);
  const apply = flagBoolean(commandLine, 'apply');
  const summary = flagText(commandLine, 'summary');
  const project = await resolveProject(projectReference(commandLine));
  const outcome = await runToolSession(project.id, ops, {
    apply,
    ...(summary ? { summary } : {}),
  });
  if (json) {
    printJson({
      projectId: project.id,
      applied: outcome.applied,
      ops: outcome.executions,
      terminal: outcome.terminal,
    });
    return;
  }
  for (const execution of outcome.executions) {
    writeStdout(`${execution.tool}: ${JSON.stringify(execution.result)}`);
  }
  writeStdout(outcome.applied
    ? `committed ${ops.length} operation(s) to ${project.name} (${project.id})`
    : `draft discarded — ${project.name} unchanged. Add --apply to commit.`);
}
