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

export interface ExportMediaSource {
  /** The file behind the upload name: a managed copy, or the external source of an in-place reference. */
  readonly path?: string;
  /** The camera original, when the upload is an in-place reference or a working copy derived from one. */
  readonly originalPath?: string;
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

function isExportMediaSource(value: unknown): value is ExportMediaSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { path, originalPath } = value as Record<string, unknown>;
  return (path === undefined || isAbsoluteDiskPath(path))
    && (originalPath === undefined || isAbsoluteDiskPath(originalPath));
}

export function isExportMediaSourceMap(value: unknown): value is ExportMediaSourceMap {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every(isExportMediaSource);
}
