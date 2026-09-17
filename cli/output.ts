// Output is stdout for data and stderr for diagnostics: piping `occ ... --json`
// into another tool must never pick up a hint line. `process.stdout.write` over
// console.* keeps the CLI's output path explicit and lint-clean.

export function writeStdout(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function writeStderr(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function printJson(value: unknown): void {
  writeStdout(JSON.stringify(value, null, 2));
}

export function renderTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((title, column) => Math.max(
    title.length,
    ...rows.map((row) => (row[column] ?? '').length),
  ));
  const renderRow = (row: readonly string[]): string => row
    .map((cell, column) => (cell ?? '').padEnd(widths[column] ?? 0))
    .join('  ')
    .trimEnd();
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  return [renderRow(header), divider, ...rows.map(renderRow)].join('\n');
}

/** Local wall-clock stamp; the CLI never prints raw epochs at a human. */
export function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '-';
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}

/** Frames are the editor's unit; seconds are what a human reads. */
export function formatDuration(frames: number, fps: number): string {
  if (!Number.isFinite(frames) || frames <= 0 || !Number.isFinite(fps) || fps <= 0) return '0s';
  const seconds = frames / fps;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${(seconds - minutes * 60).toFixed(0).padStart(2, '0')}s`;
}
