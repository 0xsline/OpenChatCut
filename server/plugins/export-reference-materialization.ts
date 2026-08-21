import { mkdir, rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { ExportMediaReference } from '../../src/export/exportMediaPlan.ts';
import { isSafeUploadName } from '../media-dir.ts';

const EXPORT_REFERENCE_DIRECTORY = 'export-references';

export interface ExportReferenceMaterialization {
  readonly replacements: ReadonlyMap<string, string>;
  readonly localPaths: readonly string[];
}

function uploadName(source: string): string | null {
  const rawPathname = source.split(/[?#]/, 1)[0] ?? '';
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  const prefix = '/media/uploads/';
  if (!pathname.startsWith(prefix)) return null;
  const name = pathname.slice(prefix.length);
  return isSafeUploadName(name) ? name : null;
}

async function removeLinks(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

/** Expose external folders to the isolated Remotion bundle without copying media bytes. */
export async function materializeExportReferences(
  references: readonly ExportMediaReference[],
  uploadDirectory: string,
  resolveReference: (name: string) => string | null,
  signal?: AbortSignal,
): Promise<ExportReferenceMaterialization> {
  const replacements = new Map<string, string>();
  const localPaths: string[] = [];
  const root = join(uploadDirectory, EXPORT_REFERENCE_DIRECTORY);
  try {
    for (const reference of references) {
      signal?.throwIfAborted();
      if (replacements.has(reference.source)) continue;
      const name = uploadName(reference.source);
      const source = name ? resolveReference(name) : null;
      if (!source) continue;
      await mkdir(root, { recursive: true });
      const linkName = randomUUID();
      const linkPath = join(root, linkName);
      await symlink(dirname(source), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      localPaths.push(linkPath);
      replacements.set(
        reference.source,
        `/media/uploads/${EXPORT_REFERENCE_DIRECTORY}/${linkName}/${encodeURIComponent(basename(source))}`,
      );
    }
    signal?.throwIfAborted();
    return { replacements, localPaths };
  } catch (error) {
    await removeLinks(localPaths);
    throw error;
  }
}
