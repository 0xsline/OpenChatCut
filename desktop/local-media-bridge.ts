import { basename, isAbsolute } from 'node:path';
import type { LocalMediaImport } from './local-media-import.ts';

export const LOCAL_MEDIA_IMPORT_CHANNEL = 'openchatcut:import-local-media';

interface LocalMediaFile {
  readonly name: string;
}

export interface LocalMediaPreloadDependencies<TFile extends LocalMediaFile> {
  getPathForFile(file: TFile): string;
  invoke(
    channel: typeof LOCAL_MEDIA_IMPORT_CHANNEL,
    sourcePath: string,
    originalName: string,
  ): Promise<LocalMediaImport>;
}

/** Resolve an Electron File to its native path before crossing the IPC boundary. */
export async function importLocalMediaFromFile<TFile extends LocalMediaFile>(
  file: TFile,
  dependencies: LocalMediaPreloadDependencies<TFile>,
): Promise<LocalMediaImport | null> {
  let sourcePath = '';
  try {
    sourcePath = dependencies.getPathForFile(file);
  } catch {
    // Clipboard-created blobs have no native path and retain the browser fallback.
    return null;
  }
  if (!sourcePath) return null;
  return dependencies.invoke(LOCAL_MEDIA_IMPORT_CHANNEL, sourcePath, file.name);
}

export type LocalMediaImporter = (
  sourcePath: string,
  originalName: string,
) => Promise<LocalMediaImport>;

export type LocalMediaImportHandler = (
  event: unknown,
  ...args: unknown[]
) => Promise<LocalMediaImport>;

/** Validate the untrusted IPC payload before handing it to the filesystem importer. */
export function createLocalMediaImportHandler(importMedia: LocalMediaImporter): LocalMediaImportHandler {
  return async (_event, ...args) => {
    const [sourcePath, originalName] = args;
    if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath)) {
      throw new Error('local media source must be an absolute path');
    }
    if (typeof originalName !== 'string' || !originalName || basename(originalName) !== originalName) {
      throw new Error('invalid local media filename');
    }
    return importMedia(sourcePath, originalName);
  };
}
