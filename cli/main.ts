// `occ` — OpenChatCut command line. Runs against the local project library with
// no app, no browser and no MCP session in the loop; writes still go through the
// same offline edit-session contract the app and external agents use.
import { flagText, parseCommandLine } from './args.ts';
import { CliError, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError } from './errors.ts';
import { writeStderr, writeStdout } from './output.ts';
import { applyGlobalOptions } from './profile.ts';

const USAGE = `occ — OpenChatCut command line

Usage
  occ project list [--all] [--json]
  occ project show [<project>] [--doc] [--json]
  occ project new <name> [--size 1920x1080] [--fps 30] [--json]
  occ timeline show [<project>] [--json]
  occ timeline items [<project>] [--track <track id>] [--timeline <id>] [--json]
  occ tools ls [--all] [--json]
  occ tools call <tool> [--args '<json>' | --args @file.json] [--apply] [--json]
  occ edit --ops '[{"tool":"set_aspect_ratio","args":{"ratio":"9:16"}}]' [--apply] [--json]
  occ where [--json]

Global flags
  --project <id|prefix|name>   project to act on (default: most recently updated)
  --data-dir <path>            use a specific OpenChatCut library instead of the active profile
  --json                       machine-readable output on stdout
  --help                       this text

Writes
  Only \`occ tools call --apply\` writes. It opens one offline edit session, commits
  atomically through the same revision check the app uses, and snapshots a pre-edit
  version, so every committed command is undoable from the app's version history.
  Without --apply the draft is discarded and the project is left untouched.

Projects
  <project> accepts a full id, a unique id prefix, or a unique name.`;

function reportError(error: unknown): number {
  if (error instanceof UsageError) {
    writeStderr(error.message);
    writeStderr('Run `occ --help` for usage.');
    return EXIT_USAGE;
  }
  if (error instanceof CliError) {
    writeStderr(error.message);
    return EXIT_FAILURE;
  }
  if (error instanceof Error && error.name === 'ExternalEditorCallError') {
    writeStderr(error.message);
    return EXIT_FAILURE;
  }
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  writeStderr(`unexpected failure: ${message}`);
  return EXIT_FAILURE;
}

export async function run(argv: readonly string[]): Promise<number> {
  let commandLine;
  try {
    commandLine = parseCommandLine(argv);
  } catch (error) {
    return reportError(error);
  }

  if (commandLine.flags.has('help')) {
    writeStdout(USAGE);
    return EXIT_OK;
  }
  if (commandLine.positionals.length === 0) {
    writeStdout(USAGE);
    return EXIT_USAGE;
  }

  try {
    applyGlobalOptions({ dataDir: flagText(commandLine, 'data-dir') });
  } catch (error) {
    return reportError(error);
  }

  try {
    // Dynamic on purpose: static import would load server/runtime-profile.ts (and
    // therefore freeze the profile) before --data-dir was applied above.
    const { runCommand } = await import('./router.ts');
    await runCommand(commandLine);
    return EXIT_OK;
  } catch (error) {
    return reportError(error);
  }
}

process.exitCode = await run(process.argv.slice(2));
