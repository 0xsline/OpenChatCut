import { isAbsolute, basename, join } from 'node:path';

/** Resolve only a direct child of a trusted export directory. */
export function exportRevealCandidate(directory: string, filename: unknown): string | null {
  if (!isAbsolute(directory) || typeof filename !== 'string' || !filename) return null;
  if (basename(filename) !== filename || filename === '.' || filename === '..') return null;
  return join(directory, filename);
}

export interface ExportRevealTarget {
  readonly directory: string;
  readonly candidate: string | null;
}

/** Bind a reveal request to the opaque destination identity stored on its history row. */
export async function resolveExportRevealTarget(
  destinationId: unknown,
  filename: unknown,
  resolveDestination: (destinationId: string) => Promise<string | null>,
): Promise<ExportRevealTarget | null> {
  if (typeof destinationId !== 'string' || !destinationId) return null;
  const directory = await resolveDestination(destinationId);
  if (!directory) return null;
  return { directory, candidate: exportRevealCandidate(directory, filename) };
}
