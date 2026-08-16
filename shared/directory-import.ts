export type DirectoryImportMediaKind = 'video' | 'image' | 'audio' | 'gif' | 'svg';
export type DirectoryImportDisposition = 'reserved' | 'accepted' | 'duplicate' | 'rejected';

export interface DirectoryImportedFile {
  readonly importId: string;
  readonly name: string;
  readonly src: string;
  readonly storedName: string;
  readonly contentHash: string;
  readonly kind: DirectoryImportMediaKind;
  readonly size: number;
  readonly durationSeconds?: number;
  readonly sourceModifiedAt: number;
  readonly width?: number;
  readonly height?: number;
  readonly sourceFps?: number;
  readonly compatibilityNormalized?: true;
  readonly proxyKind?: 'alpha-webm';
}

/** Agent-initiated path import (issue #84): files or directories the agent
 * asks to import. knownHashes dedupes against the pool's existing content. */
export interface AgentPathImportRequest {
  readonly paths: readonly string[];
  readonly projectId: string;
  readonly knownHashes: readonly string[];
}

export interface AgentPathImportResult {
  readonly imported: ReadonlyArray<Omit<DirectoryImportedFile, 'importId'>>;
  readonly errors: readonly { path: string; error: string }[];
}

export interface DirectoryWatchStartResult {
  readonly watchId: string;
  readonly projectId: string;
  readonly directoryName: string;
  readonly files: readonly DirectoryImportedFile[];
}

export interface DirectoryImportEvent {
  readonly watchId: string;
  readonly projectId: string;
  readonly file: DirectoryImportedFile;
}

export const AGENT_PATH_IMPORT_CHANNEL = 'openchatcut:agent-path-import';

export const DIRECTORY_IMPORT_CHANNELS = {
  start: 'openchatcut:directory-import-start',
  activate: 'openchatcut:directory-import-activate',
  acknowledge: 'openchatcut:directory-import-acknowledge',
  stop: 'openchatcut:directory-import-stop',
  imported: 'openchatcut:directory-import-file',
} as const;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const MEDIA_KINDS: Record<DirectoryImportMediaKind, true> = {
  video: true,
  image: true,
  audio: true,
  gif: true,
  svg: true,
};


export function isDirectoryImportDisposition(value: unknown): value is DirectoryImportDisposition {
  return value === 'reserved' || value === 'accepted'
    || value === 'duplicate' || value === 'rejected';
}

export function isDirectoryImportOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function containsProjectIdControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isDirectoryImportProjectId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    && !containsProjectIdControlCharacter(value);
}

export function normalizeDirectoryImportHashes(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 20_000) return null;
  const hashes = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') return null;
    const normalized = candidate.trim().toLowerCase();
    if (!SHA256_HEX.test(normalized)) return null;
    hashes.add(normalized);
  }
  return [...hashes];
}
function isOptionalPositiveNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}
function isReadyDirectoryImport(file: Partial<DirectoryImportedFile>): boolean {
  if (file.kind === 'video') {
    return (file.compatibilityNormalized === true && file.proxyKind === undefined)
      || (file.compatibilityNormalized === undefined && file.proxyKind === 'alpha-webm');
  }
  return file.compatibilityNormalized === undefined && file.proxyKind === undefined;
}

function exposesRawDirectoryPath(value: object): boolean {
  return ['path', 'root', 'directoryPath', 'absolutePath', 'originalFilePath', 'relativePath']
    .some((key) => key in value);
}



export function isDirectoryImportedFile(value: unknown): value is DirectoryImportedFile {
  if (!value || typeof value !== 'object' || exposesRawDirectoryPath(value)) return false;
  const file = value as Partial<DirectoryImportedFile>;
  return isDirectoryImportOpaqueId(file.importId)
    && typeof file.name === 'string'
    && file.name.length > 0
    && file.name.length <= 512
    && typeof file.src === 'string'
    && /^\/media\/uploads\/[A-Za-z0-9._-]+$/.test(file.src)
    && typeof file.storedName === 'string'
    && /^[A-Za-z0-9._-]+$/.test(file.storedName)
    && typeof file.contentHash === 'string'
    && SHA256_HEX.test(file.contentHash)
    && typeof file.kind === 'string'
    && file.kind in MEDIA_KINDS
    && typeof file.size === 'number'
    && typeof file.sourceModifiedAt === 'number'
    && Number.isFinite(file.sourceModifiedAt)
    && file.sourceModifiedAt >= 0
    && Number.isFinite(file.size)
    && file.size >= 0
    && isOptionalPositiveNumber(file.durationSeconds)
    && isOptionalPositiveNumber(file.width)
    && isOptionalPositiveNumber(file.height)
    && isOptionalPositiveNumber(file.sourceFps)
    && isReadyDirectoryImport(file);
}

export function isDirectoryImportEvent(value: unknown): value is DirectoryImportEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<DirectoryImportEvent>;
  return isDirectoryImportOpaqueId(event.watchId)
    && isDirectoryImportProjectId(event.projectId)
    && isDirectoryImportedFile(event.file);
}

export function isDirectoryWatchStartResult(value: unknown): value is DirectoryWatchStartResult {
  if (!value || typeof value !== 'object' || exposesRawDirectoryPath(value)) return false;
  const result = value as Partial<DirectoryWatchStartResult>;
  return isDirectoryImportOpaqueId(result.watchId)
    && isDirectoryImportProjectId(result.projectId)
    && typeof result.directoryName === 'string'
    && result.directoryName.length > 0
    && result.directoryName.length <= 512
    && Array.isArray(result.files)
    && result.files.every(isDirectoryImportedFile);
}
