// `occ item ...` — the everyday clip edits. Each subcommand maps 1:1 onto an
// allowlisted headless tool (move_item / set_item_timing / split_item /
// remove_item / duplicate_item), so the CLI adds ergonomics, not semantics.
// Without --apply the edit runs in a draft and is thrown away: `occ item move …
// --track V2` is also how you preview what the tool would do.
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { UsageError } from '../errors.ts';
import { readProjectDoc, resolveProject, type ProjectHandle } from '../store.ts';
import { resolveClipRef } from '../clip-ref.ts';
import type { ToolOp } from '../tool-catalog.ts';
import { GLOBAL_FLAGS, parseFrames, projectReference, requirePositional, subLine } from './common.ts';
import { runToolOps } from './run-op.ts';

const FLAGS = [
  ...GLOBAL_FLAGS,
  'track',
  'start',
  'duration',
  'fade-in',
  'fade-out',
  'ripple',
  'at',
  'apply',
  'summary',
] as const;

export async function runItemCommand(
  positionals: readonly string[],
  commandLine: CommandLine,
  json: boolean,
): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);
  const [subcommand, ...rest] = positionals;
  const line = subLine(commandLine, rest);
  switch (subcommand) {
    case 'move':
      return moveCommand(line, commandLine, json);
    case 'trim':
      return trimCommand(line, commandLine, json);
    case 'split':
      return splitCommand(line, commandLine, json);
    case 'rm':
    case 'remove':
      return removeCommand(line, commandLine, json);
    case 'dup':
    case 'duplicate':
      return duplicateCommand(line, commandLine, json);
    case undefined:
      throw new UsageError('item needs a subcommand: move | trim | split | rm | dup');
    default:
      throw new UsageError(`unknown item subcommand "${subcommand}"`);
  }
}

interface ClipTarget {
  readonly project: ProjectHandle;
  readonly itemId: string;
  readonly fps: number;
}

/** Resolve `<clip>` + `<project>` the same way in every subcommand. */
async function clipTarget(line: CommandLine): Promise<ClipTarget> {
  const reference = requirePositional(line, 0, 'clip id or name');
  const project = await resolveProject(projectReference(line, 1));
  const doc = await readProjectDoc(project.id);
  const { item, timeline } = resolveClipRef(doc, reference);
  return { project, itemId: item.id, fps: timeline.fps };
}

function commit(line: CommandLine, target: ClipTarget, json: boolean, ops: ToolOp[], label: string): Promise<void> {
  return runToolOps({
    projectId: target.project.id,
    projectName: target.project.name,
    ops,
    apply: flagBoolean(line, 'apply'),
    ...(flagText(line, 'summary') ? { summary: flagText(line, 'summary') } : {}),
    json,
    label,
  });
}

async function moveCommand(line: CommandLine, commandLine: CommandLine, json: boolean): Promise<void> {
  const target = await clipTarget(line);
  const args: Record<string, unknown> = { itemId: target.itemId };
  const track = flagText(commandLine, 'track');
  if (track) args.track = track;
  const start = flagText(commandLine, 'start');
  if (start !== undefined) args.startFrame = parseFrames(start, target.fps, 'start');
  if (track === undefined && start === undefined) {
    throw new UsageError('item move needs --track and/or --start');
  }
  await commit(line, target, json, [{ tool: 'move_item', args }], 'move clip');
}

async function trimCommand(line: CommandLine, commandLine: CommandLine, json: boolean): Promise<void> {
  const target = await clipTarget(line);
  const args: Record<string, unknown> = { itemId: target.itemId };
  const start = flagText(commandLine, 'start');
  if (start !== undefined) args.startFrame = parseFrames(start, target.fps, 'start');
  const duration = flagText(commandLine, 'duration');
  if (duration !== undefined) args.durationInFrames = parseFrames(duration, target.fps, 'duration');
  const fadeIn = flagText(commandLine, 'fade-in');
  if (fadeIn !== undefined) args.fadeInSeconds = Number(fadeIn);
  const fadeOut = flagText(commandLine, 'fade-out');
  if (fadeOut !== undefined) args.fadeOutSeconds = Number(fadeOut);
  if (flagBoolean(commandLine, 'ripple')) args.ripple = true;
  if (Object.keys(args).length === 1) {
    throw new UsageError('item trim needs --start, --duration, --fade-in or --fade-out');
  }
  await commit(line, target, json, [{ tool: 'set_item_timing', args }], 'retime clip');
}

async function splitCommand(line: CommandLine, commandLine: CommandLine, json: boolean): Promise<void> {
  const target = await clipTarget(line);
  const at = flagText(commandLine, 'at');
  if (at === undefined) throw new UsageError('item split needs --at <frame|4s>');
  await commit(line, target, json, [{
    tool: 'split_item',
    args: { itemId: target.itemId, atFrame: parseFrames(at, target.fps, 'at') },
  }], 'split clip');
}

async function removeCommand(line: CommandLine, commandLine: CommandLine, json: boolean): Promise<void> {
  const target = await clipTarget(line);
  const args: Record<string, unknown> = { itemId: target.itemId };
  if (flagBoolean(commandLine, 'ripple')) args.ripple = true;
  await commit(line, target, json, [{ tool: 'remove_item', args }], 'remove clip');
}

async function duplicateCommand(line: CommandLine, _commandLine: CommandLine, json: boolean): Promise<void> {
  const target = await clipTarget(line);
  await commit(line, target, json, [{ tool: 'duplicate_item', args: { itemId: target.itemId } }], 'duplicate clip');
}
