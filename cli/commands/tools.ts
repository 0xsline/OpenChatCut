// `occ tools ...` — inspect the surface and call one tool.
//   * `tools ls` lists what can run headless today, so the CLI never promises a
//     capability it lacks;
//   * `tools call` runs one tool inside a single atomic offline edit session. It
//     is the escape hatch that keeps the CLI from needing a hand-written command
//     per tool — and the way to use a tool the moment it is allowlisted.
// For several calls in one commit use `occ edit --ops`.
import { readFileSync } from 'node:fs';
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { UsageError } from '../errors.ts';
import { printJson, writeStdout } from '../output.ts';
import { resolveProject } from '../store.ts';
import { parseJsonObject, requireHeadlessTool, toolRows } from '../tool-catalog.ts';
import { GLOBAL_FLAGS, projectReference, requirePositional, subLine } from './common.ts';
import { runToolOps } from './run-op.ts';

const FLAGS = [...GLOBAL_FLAGS, 'all', 'args', 'apply', 'summary'] as const;

export async function runToolsCommand(
  positionals: readonly string[],
  commandLine: CommandLine,
  json: boolean,
): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);
  const [subcommand, ...rest] = positionals;
  const line = subLine(commandLine, rest);
  switch (subcommand) {
    case 'ls':
      return listCommand(commandLine, json);
    case 'call':
      return callCommand(line, commandLine, json);
    case undefined:
      throw new UsageError('tools needs a subcommand: ls | call');
    default:
      throw new UsageError(`unknown tools subcommand "${subcommand}"`);
  }
}

function listCommand(commandLine: CommandLine, json: boolean): void {
  const rows = toolRows(flagBoolean(commandLine, 'all'));
  if (json) {
    printJson(rows);
    return;
  }
  const width = Math.max(0, ...rows.map((row) => row.name.length));
  for (const row of rows) {
    writeStdout(`${row.name.padEnd(width)}  ${row.headless ? 'headless' : 'browser '}  ${row.description.slice(0, 90)}`);
  }
  writeStdout('');
  writeStdout(`${rows.length} tool(s). Browser-only tools need the editor open; run \`occ tools ls --all\` for the full surface.`);
}

function invocationArgs(commandLine: CommandLine): Record<string, unknown> {
  const raw = flagText(commandLine, 'args');
  if (raw === undefined) return {};
  return parseJsonObject(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw, '--args');
}

async function callCommand(line: CommandLine, commandLine: CommandLine, json: boolean): Promise<void> {
  const tool = requirePositional(line, 0, 'tool name');
  requireHeadlessTool(tool);
  const project = await resolveProject(projectReference(line, 1));
  const summary = flagText(commandLine, 'summary');
  await runToolOps({
    projectId: project.id,
    projectName: project.name,
    ops: [{ tool, args: invocationArgs(commandLine) }],
    apply: flagBoolean(commandLine, 'apply'),
    ...(summary ? { summary } : {}),
    json,
    label: tool,
  });
}
