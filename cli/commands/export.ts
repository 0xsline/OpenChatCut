// `occ export ...` — hand the project to another editor.
//
// jianying builds a CapCut/JianYing draft through the same exporter the app uses
// (server/external-agent/jianying-export.ts drives capcut-cli; CAPCUT_CLI
// overrides the binary). Nothing here changes the project: the draft is written
// outside it, so the session stages nothing and reports no commit.
import { flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { UsageError } from '../errors.ts';
import { resolveProject } from '../store.ts';
import type { ToolOp } from '../tool-catalog.ts';
import { GLOBAL_FLAGS, projectReference, subLine } from './common.ts';
import { runToolOps } from './run-op.ts';

const FLAGS = [...GLOBAL_FLAGS, 'draft-name', 'out-dir'] as const;

export async function runExportCommand(
  positionals: readonly string[],
  commandLine: CommandLine,
  json: boolean,
): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);
  const [subcommand, ...rest] = positionals;
  const line = subLine(commandLine, rest);
  switch (subcommand) {
    case 'jianying':
      return jianyingCommand(line, commandLine, json);
    case undefined:
      throw new UsageError('export needs a target: jianying');
    default:
      throw new UsageError(`unknown export target "${subcommand}" (try: jianying)`);
  }
}

async function jianyingCommand(line: CommandLine, commandLine: CommandLine, json: boolean): Promise<void> {
  const project = await resolveProject(projectReference(line));
  const draftName = flagText(commandLine, 'draft-name');
  const outDir = flagText(commandLine, 'out-dir');
  const args: Record<string, unknown> = {
    ...(draftName ? { draftName } : {}),
    ...(outDir ? { draftsDir: outDir } : {}),
  };
  const op: ToolOp = { tool: 'export_jianying_draft', args };
  await runToolOps({
    projectId: project.id,
    projectName: project.name,
    ops: [op],
    apply: true,
    json,
    label: 'jianying draft export',
  });
}
