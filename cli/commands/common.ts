// Shared plumbing for the command modules: project selection and flag checking.
import { flagText, GLOBAL_FLAGS, type CommandLine } from '../args.ts';
import { UsageError } from '../errors.ts';

export { GLOBAL_FLAGS };

/** A command's own view of the line: positionals after its own name. */
export function subLine(commandLine: CommandLine, positionals: readonly string[]): CommandLine {
  return { positionals, flags: commandLine.flags };
}

/** `<project>` positional wins over `--project`; both may be omitted (newest project). */
export function projectReference(commandLine: CommandLine, index = 0): string | undefined {
  return commandLine.positionals[index] ?? flagText(commandLine, 'project');
}

export function requirePositional(commandLine: CommandLine, index: number, label: string): string {
  const value = commandLine.positionals[index];
  if (value === undefined || !value.trim()) {
    throw new UsageError(`missing ${label}`);
  }
  return value;
}

/** `1920x1080` / `1080p` / `2160p` → [width, height]. */
export function parseSize(input: string): [number, number] {
  const shorthand = /^(\d{3,4})p$/i.exec(input.trim());
  if (shorthand) {
    const height = Number(shorthand[1]);
    const width = Math.round((height * 16) / 9 / 2) * 2;
    return [width, height];
  }
  const pair = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(input.trim());
  if (!pair) throw new UsageError(`--size expects WIDTHxHEIGHT (for example 1920x1080), got "${input}"`);
  return [Number(pair[1]), Number(pair[2])];
}

export function positiveInteger(input: string, flag: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--${flag} expects a positive integer, got "${input}"`);
  }
  return value;
}
