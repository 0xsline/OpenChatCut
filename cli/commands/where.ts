// `occ where` — which library is this CLI talking to? The single most useful
// answer when a command seems to edit "nothing": dev profiles, a data-dir
// override, and the packaged app each point at a different library.
import { rejectUnknownFlags, type CommandLine } from '../args.ts';
import { printJson, writeStdout } from '../output.ts';
import { profileReport } from '../profile.ts';

export async function runWhereCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, ['json', 'data-dir', 'help']);
  const report = await profileReport();
  if (json) {
    printJson(report);
    return;
  }
  writeStdout(`profile      ${report.profileId} (${report.mode})`);
  writeStdout(`library      ${report.rootDir}`);
  writeStdout(`projects     ${report.projectStoreIndex}`);
  writeStdout(`media        ${report.mediaDir}`);
  writeStdout(`keystore     ${report.keystorePath}`);
}
