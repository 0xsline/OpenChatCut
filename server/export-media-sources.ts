// Resolve timeline sources to the files an NLE should link, and where each
// file's own timeline starts, for one FCPXML export. `<mediaDir>/<name>` is
// only right for managed copies: an in-place reference (desktop file/folder/
// watched-folder/agent-path import) has no file there, just
// .references/<name>.json pointing at the user's original.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ExportMediaSource,
  ExportMediaSourceMap,
  ExportMediaStart,
} from '../shared/export-media-sources.ts';
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

/**
 * A file's embedded start, null when it has none; rejects when the file cannot
 * be read. Production passes media-timecode.ts's ffprobe reader.
 */
export type StartProbe = (path: string) => Promise<ExportMediaStart | null>;
/** As StartProbe, with undefined for a file that could not be read in time. */
type RequestStartProbe = (path: string) => Promise<ExportMediaStart | null | undefined>;

const PROBE_CONCURRENCY = 4;
/** Past this, remaining files export without a start rather than stall the export. */
const PROBE_BUDGET_MS = 20_000;

/** One probe per file per request, a few at a time, within the request's budget. */
function requestStartProbe(probe: StartProbe): RequestStartProbe {
  const cache = new Map<string, Promise<ExportMediaStart | null | undefined>>();
  const waiting: Array<() => void> = [];
  const deadline = Date.now() + PROBE_BUDGET_MS;
  let active = 0;
  const acquire = async (): Promise<void> => {
    if (active < PROBE_CONCURRENCY) {
      active += 1;
      return;
    }
    // release() hands its slot straight to the next waiter.
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  const run = async (path: string): Promise<ExportMediaStart | null | undefined> => {
    await acquire();
    try {
      return Date.now() > deadline ? undefined : await probe(path);
    } catch {
      return undefined;
    } finally {
      release();
    }
  };
  return (path) => {
    const cached = cache.get(path);
    if (cached) return cached;
    const pending = run(path);
    cache.set(path, pending);
    return pending;
  };
}

/**
 * Attach embedded starts. The original's own start when it can be read; an
 * offline or unreadable original is described by its working copy, because
 * normalization and plain copies keep the timecode track.
 */
async function withStarts(location: ExportMediaSource, probe: RequestStartProbe): Promise<ExportMediaSource> {
  const { path, originalPath } = location;
  const [pathStart, ownStart] = await Promise.all([
    path && existsSync(path) ? probe(path) : undefined,
    originalPath && originalPath !== path && existsSync(originalPath) ? probe(originalPath) : undefined,
  ]);
  const originalStart = ownStart === undefined ? pathStart : ownStart;
  return {
    ...location,
    ...(pathStart ? { pathStart } : {}),
    ...(originalPath && originalStart ? { originalStart } : {}),
  };
}

/** Resolve every distinct source and its start; unresolvable ones are left out. */
export async function resolveExportMediaSources(
  sources: readonly string[],
  probe: StartProbe,
  directories: readonly string[] = uploadReadDirs(),
): Promise<ExportMediaSourceMap> {
  const listing = cachedReferenceListing();
  const startOf = requestStartProbe(probe);
  const located = [...new Set(sources)].flatMap((source) => {
    const location = resolveExportMediaSource(source, directories, listing);
    return location ? [[source, location] as const] : [];
  });
  return Object.fromEntries(await Promise.all(located.map(
    async ([source, location]) => [source, await withStarts(location, startOf)] as const,
  )));
}
