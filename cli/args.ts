// Argument parsing for `occ`. Deliberately tiny: subcommands plus long flags,
// no positional flag values and no short-flag clusters. Every command declares
// the flags it accepts (see rejectUnknownFlags) so a typo fails loudly instead
// of being silently ignored — the failure mode a hand-rolled parser usually has.
import { UsageError } from './errors.ts';

export interface CommandLine {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

const FLAG_PREFIX = '--';

export function parseCommandLine(argv: readonly string[]): CommandLine {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) break;
    if (token === FLAG_PREFIX) {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith(FLAG_PREFIX)) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(FLAG_PREFIX.length);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && next !== FLAG_PREFIX && !next.startsWith(FLAG_PREFIX)) {
      flags.set(body, next);
      index += 1;
      continue;
    }
    flags.set(body, true);
  }
  return { positionals, flags };
}

export function flagText(commandLine: CommandLine, name: string): string | undefined {
  const value = commandLine.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new UsageError(`--${name} needs a value`);
  return value;
}

export function flagBoolean(commandLine: CommandLine, name: string): boolean {
  const value = commandLine.flags.get(name);
  if (value === undefined) return false;
  if (value === true || value === 'true') return true;
  if (value === 'false') return false;
  throw new UsageError(`--${name} takes no value`);
}

export function rejectUnknownFlags(commandLine: CommandLine, allowed: readonly string[]): void {
  const known = new Set(allowed);
  const unknown = [...commandLine.flags.keys()].filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new UsageError(`unknown flag ${unknown.map((name) => `--${name}`).join(', ')}`);
  }
}

export function positional(commandLine: CommandLine, index: number, label: string): string {
  const value = commandLine.positionals[index];
  if (value === undefined || !value.trim()) throw new UsageError(`missing ${label}`);
  return value;
}

/** Flags every command accepts, so each command's own list can stay short. */
export const GLOBAL_FLAGS = ['json', 'data-dir', 'help', 'project'] as const;
