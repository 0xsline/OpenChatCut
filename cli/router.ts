// Command routing. Nothing here may be imported before cli/profile.ts applied the
// profile override, which is why cli/main.ts imports this module dynamically:
// server/runtime-profile.ts freezes the active profile when it is first imported,
// and a static import chain from main.ts would freeze it too early.
import { flagBoolean, type CommandLine } from './args.ts';
import { UsageError } from './errors.ts';
import { runEditCommand } from './commands/edit.ts';
import { runItemCommand } from './commands/item.ts';
import { runMediaCommand } from './commands/media.ts';
import { runProjectCommand } from './commands/project.ts';
import { runRenderCommand } from './commands/render.ts';
import { runTimelineCommand } from './commands/timeline.ts';
import { runToolsCommand } from './commands/tools.ts';
import { runWhereCommand } from './commands/where.ts';
import { subLine } from './commands/common.ts';

export async function runCommand(commandLine: CommandLine): Promise<void> {
  const json = flagBoolean(commandLine, 'json');
  const [group, ...positionals] = commandLine.positionals;
  switch (group) {
    case 'project':
      return runProjectCommand(positionals, commandLine, json);
    case 'timeline':
      return runTimelineCommand(positionals, commandLine, json);
    case 'tools':
      return runToolsCommand(positionals, commandLine, json);
    case 'edit':
      return runEditCommand(subLine(commandLine, positionals), json);
    case 'item':
      return runItemCommand(positionals, commandLine, json);
    case 'media':
      return runMediaCommand(positionals, commandLine, json);
    case 'render':
      return runRenderCommand(subLine(commandLine, positionals), json);
    case 'where':
      return runWhereCommand(commandLine, json);
    case undefined:
      throw new UsageError('missing command');
    default:
      throw new UsageError(`unknown command "${group}"`);
  }
}
