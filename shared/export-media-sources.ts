// Export-time disk locations for timeline media served from /media/uploads.
//
// Desktop folder, watched-folder and agent-path imports are in-place
// references: the server keeps each source path in .references/<name>.json and
// the renderer's project state never holds it (shared/directory-import.ts
// rejects raw paths at the preload boundary). An NLE interchange file has to
// name those paths, so the server resolves them for one export at a time
// instead of the project persisting them.

export const EXPORT_MEDIA_SOURCES_ROUTE = '/api/export-media-sources';

/** Distinct sources per request; far above what one timeline references. */
export const MAX_EXPORT_MEDIA_SOURCES = 4096;

/** Longest path accepted back from the server (Windows extended-length limit). */
const MAX_PATH_LENGTH = 32_767;

/**
 * Where a media file's own timeline begins, exactly `value / timescale` seconds:
 * an embedded start timecode (frames × rate denominator over the rate numerator)
 * or a Broadcast WAV sample offset. NLEs conform clips against it.
 */
export interface ExportMediaStart {
  readonly value: number;
  readonly timescale: number;
  /** The embedded label, e.g. "10:00:00:00" or drop-frame "01:00:00;00"; absent for a BWF sample offset. */
  readonly timecode?: string;
  readonly dropFrame: boolean;
}

export interface ExportMediaSource {
  /** The file behind the upload name: a managed copy, or the external source of an in-place reference. */
  readonly path?: string;
  /** The camera original, when the upload is an in-place reference or a working copy derived from one. */
  readonly originalPath?: string;
  /** Embedded start of `path`, when it carries one. */
  readonly pathStart?: ExportMediaStart;
  /** Embedded start of the original; the working copy's stands in while the original is offline or unreadable. */
  readonly originalStart?: ExportMediaStart;
}

/** Keyed by the exact `src` string the timeline item carries. */
export type ExportMediaSourceMap = Readonly<Record<string, ExportMediaSource>>;

export interface ExportMediaSourcesRequest {
  readonly sources: readonly string[];
}

export interface ExportMediaSourcesResponse {
  readonly ok: true;
  readonly sources: ExportMediaSourceMap;
}

function isAbsoluteDiskPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 1
    && value.length <= MAX_PATH_LENGTH
    && !value.includes('\0')
    && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'));
}

function isExportMediaStart(value: unknown): value is ExportMediaStart {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const start = value as Record<string, unknown>;
  return Number.isSafeInteger(start.value) && (start.value as number) >= 0
    && Number.isSafeInteger(start.timescale) && (start.timescale as number) > 0
    && (start.timecode === undefined || (typeof start.timecode === 'string' && start.timecode.length <= 32))
    && typeof start.dropFrame === 'boolean';
}

function isExportMediaSource(value: unknown): value is ExportMediaSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { path, originalPath, pathStart, originalStart } = value as Record<string, unknown>;
  return (path === undefined || isAbsoluteDiskPath(path))
    && (originalPath === undefined || isAbsoluteDiskPath(originalPath))
    && (pathStart === undefined || isExportMediaStart(pathStart))
    && (originalStart === undefined || isExportMediaStart(originalStart));
}

export function isExportMediaSourceMap(value: unknown): value is ExportMediaSourceMap {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every(isExportMediaSource);
}
