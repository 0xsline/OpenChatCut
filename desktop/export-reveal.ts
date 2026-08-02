import { isAbsolute, basename, join } from 'node:path';

/** Resolve only a direct child of a trusted export directory. */
export function exportRevealCandidate(directory: string, filename: unknown): string | null {
  if (!isAbsolute(directory) || typeof filename !== 'string' || !filename) return null;
  if (basename(filename) !== filename || filename === '.' || filename === '..') return null;
  return join(directory, filename);
}
