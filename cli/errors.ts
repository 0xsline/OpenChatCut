// Failure taxonomy for `occ`. The exit code is part of the CLI's contract for
// scripts, so it lives next to the error types rather than in the printer.

/** Expected failure with a message written for a human: one line, exit 1. */
export class CliError extends Error {}

/** Bad invocation (unknown flag or command, missing argument): usage, exit 2. */
export class UsageError extends CliError {}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
