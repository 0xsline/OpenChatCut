// Resolve timeline sources to the files an NLE should link, for one FCPXML
// export. `<mediaDir>/<name>` is only right for managed copies: an in-place
// reference (desktop file/folder/watched-folder/agent-path import) has no file
// there, just .references/<name>.json pointing at the user's original.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportMediaSource, ExportMediaSourceMap } from '../shared/export-media-sources.ts';
import { isSafeUploadName, uploadNameOfSource, uploadReadDirs } from './media-dir.ts';
import {
  MEDIA_REFERENCE_DIRECTORY,
  recordedMediaReferenceSource,
  resolveMediaReference,
} from './media-references.ts';

/**
 * Working copies written beside a reference, named from the reference's stem:
 * the compatibility transcode (`<stem>.normalized.mp4`, from normalize-media and
 * directory import) and the transparent-MOV proxy (`<stem>.alpha.webm`).
 */
const DERIVED_SUFFIXES = ['.normalized.mp4', '.alpha.webm'] as const;

type ReferenceListing = (directory: string) => readonly string[];

/** Reference names recorded in one upload directory, read once per export. */
function cachedReferenceListing(): ReferenceListing {
  const cache = new Map<string, readonly string[]>();
  return (directory) => {
    const cached = cache.get(directory);
    if (cached) return cached;
    let entries: string[] = [];
    try {
      entries = readdirSync(join(directory, MEDIA_REFERENCE_DIRECTORY));
    } catch {
      // No references in this directory.
    }
    const names = entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter((name) => isSafeUploadName(name));
    cache.set(directory, names);
    return names;
  };
}

/** Current location of a reference's source, else where it was recorded (offline). */
function referenceSource(directory: string, name: string): string | null {
  return resolveMediaReference(directory, name) ?? recordedMediaReferenceSource(directory, name);
}

/** The original behind a derived working copy, when exactly one reference owns its stem. */
function derivedOriginal(
  name: string,
  directories: readonly string[],
  listing: ReferenceListing,
): string | null {
  const suffix = DERIVED_SUFFIXES.find((candidate) => name.length > candidate.length && name.endsWith(candidate));
  if (!suffix) return null;
  const stem = name.slice(0, -suffix.length);
  const owners = directories.flatMap((directory) => listing(directory)
    .filter((reference) => reference === stem || reference.startsWith(`${stem}.`))
    .map((reference) => ({ directory, reference })));
  if (new Set(owners.map((owner) => owner.reference)).size !== 1) return null;
  for (const owner of owners) {
    const source = referenceSource(owner.directory, owner.reference);
    if (source) return source;
  }
  return null;
}

/** Where one `/media/uploads/<name>` source lives on disk, in upload read order. */
export function resolveExportMediaSource(
  source: string,
  directories: readonly string[],
  listing: ReferenceListing = cachedReferenceListing(),
): ExportMediaSource | null {
  const name = uploadNameOfSource(source);
  if (!name) return null;
  for (const directory of directories) {
    const local = join(directory, name);
    if (existsSync(local)) {
      const originalPath = derivedOriginal(name, directories, listing);
      return originalPath ? { path: local, originalPath } : { path: local };
    }
    const referenced = resolveMediaReference(directory, name);
    if (referenced) return { path: referenced, originalPath: referenced };
  }
  // A reference whose source moved still names the original, which an NLE
  // can offer to relink; the upload name itself never existed as a file.
  for (const directory of directories) {
    const recorded = recordedMediaReferenceSource(directory, name);
    if (recorded) return { path: recorded, originalPath: recorded };
  }
  return null;
}

/** Resolve every distinct source; unresolvable ones are left out. */
export function resolveExportMediaSources(
  sources: readonly string[],
  directories: readonly string[] = uploadReadDirs(),
): ExportMediaSourceMap {
  const listing = cachedReferenceListing();
  const resolved: Record<string, ExportMediaSource> = {};
  for (const source of new Set(sources)) {
    const located = resolveExportMediaSource(source, directories, listing);
    if (located) resolved[source] = located;
  }
  return resolved;
}
