// `occ timeline ...` — read timelines and their clips.
import { flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson, renderTable, writeStdout } from '../output.ts';
import { readProjectDoc, resolveProject } from '../store.ts';
import { activeTimelineOf, itemRows, timelineRows } from '../summary.ts';
import { GLOBAL_FLAGS, projectReference, subLine } from './common.ts';

const FLAGS = [...GLOBAL_FLAGS, 'track', 'timeline'] as const;

export async function runTimelineCommand(
  positionals: readonly string[],
  commandLine: CommandLine,
  json: boolean,
): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);
  const [subcommand, ...rest] = positionals;
  const line = subLine(commandLine, rest);
  switch (subcommand) {
    case 'show':
      return showCommand(line, json);
    case 'items':
      return itemsCommand(line, commandLine, json);
    case undefined:
      throw new UsageError('timeline needs a subcommand: show | items');
    default:
      throw new UsageError(`unknown timeline subcommand "${subcommand}"`);
  }
}

async function showCommand(line: CommandLine, json: boolean): Promise<void> {
  const project = await resolveProject(projectReference(line));
  const doc = await readProjectDoc(project.id);
  const timelines = timelineRows(doc);
  if (json) {
    printJson({ projectId: project.id, activeTimelineId: doc.activeTimelineId, timelines });
    return;
  }
  writeStdout(renderTable(
    ['TIMELINE', 'NAME', 'FPS', 'SIZE', 'CLIPS', 'DURATION', 'TRACKS'],
    timelines.map((timeline) => [
      `${timeline.id}${timeline.active ? ' *' : ''}`,
      timeline.name,
      String(timeline.fps),
      `${timeline.width}x${timeline.height}`,
      String(timeline.itemCount),
      timeline.duration,
      timeline.trackSummary,
    ]),
  ));
}

async function itemsCommand(line: CommandLine, commandLine: CommandLine, json: boolean): Promise<void> {
  const project = await resolveProject(projectReference(line));
  const doc = await readProjectDoc(project.id);
  const timelineId = flagText(commandLine, 'timeline');
  const timeline = timelineId
    ? doc.timelines.find((candidate) => candidate.id === timelineId)
    : activeTimelineOf(doc);
  if (!timeline) {
    throw new CliError(`Project ${project.id} has no timeline ${timelineId}.\nTimelines:\n${
      doc.timelines.map((candidate) => `  ${candidate.id}  ${candidate.name}`).join('\n')}`);
  }
  const track = flagText(commandLine, 'track');
  const items = itemRows(timeline, track);
  if (json) {
    printJson({ projectId: project.id, timelineId: timeline.id, fps: timeline.fps, items });
    return;
  }
  if (items.length === 0) {
    writeStdout(`No clips${track ? ` on track ${track}` : ''} in ${timeline.id} (${timeline.name}).`);
    return;
  }
  writeStdout(renderTable(
    ['CLIP', 'TRACK', 'KIND', 'NAME', 'START', 'FRAMES', 'DURATION', 'SOURCE'],
    items.map((item) => [
      item.id,
      item.track,
      item.kind,
      item.name,
      String(item.startFrame),
      String(item.durationFrames),
      item.duration,
      item.source,
    ]),
  ));
}
