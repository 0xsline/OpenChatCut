type ExportPermissionState = 'granted' | 'denied' | 'prompt';
type ExportPermissionDescriptor = { mode: 'readwrite' };
export interface BrowserExportWritable {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface BrowserExportDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getFileHandle(name: string, options: { create: true }): Promise<{
    createWritable(): Promise<BrowserExportWritable>;
  }>;
  queryPermission(descriptor: ExportPermissionDescriptor): Promise<ExportPermissionState>;
  requestPermission(descriptor: ExportPermissionDescriptor): Promise<ExportPermissionState>;
}

export interface BrowserExportFileHandle {
  readonly kind: 'file';
  readonly name: string;
  createWritable(): Promise<BrowserExportWritable>;
  queryPermission(descriptor: ExportPermissionDescriptor): Promise<ExportPermissionState>;
  requestPermission(descriptor: ExportPermissionDescriptor): Promise<ExportPermissionState>;
}

export type ExportDestination =
  | { readonly type: 'downloads'; readonly label: string }
  | { readonly type: 'browser-directory'; readonly label: string; readonly handle: BrowserExportDirectoryHandle }
  | { readonly type: 'browser-file'; readonly label: string; readonly handle: BrowserExportFileHandle }
  | { readonly type: 'desktop-directory'; readonly label: string; readonly grantId: string }
  | { readonly type: 'desktop-file'; readonly label: string; readonly grantId: string; readonly filename: string };
export class ExportDestinationError extends Error {
  readonly key: string;
  readonly params?: Record<string, string | number>;

  constructor(key: string, params?: Record<string, string | number>) {
    super(key);
    this.name = 'ExportDestinationError';
    this.key = key;
    this.params = params;
  }
}

export function exportHistoryDestinationId(destination: ExportDestination): string | undefined {
  return destination.type === 'desktop-directory' || destination.type === 'desktop-file'
    ? destination.grantId
    : undefined;
}

export function exportDestinationFilename(destination: ExportDestination, filename: string): string {
  const target = checkedDestination(destination);
  checkedFilename(filename);
  return target.type === 'browser-file'
    ? target.handle.name
    : target.type === 'desktop-file'
      ? target.filename
      : filename;
}

export function exportDestinationErrorMessage(
  error: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (error instanceof ExportDestinationError) return t(error.key, error.params);
  return error instanceof Error ? error.message : t('导出失败');
}

export const DEFAULT_EXPORT_DESTINATION: ExportDestination = Object.freeze({
  type: 'downloads',
  label: '浏览器下载目录',
});

export function exportDestinationTargetPath(destination: ExportDestination, filename: string): string {
  const target = checkedDestination(destination);
  const outputFilename = exportDestinationFilename(target, filename);
  if (target.type === 'browser-file' || target.type === 'desktop-file') return outputFilename;
  return `${target.label.replace(/[\\/]$/, '')}/${outputFilename}`;
}
export const DIRECTORY_PERMISSION: ExportPermissionDescriptor = { mode: 'readwrite' };
const DESKTOP_GRANT_ID = /^[A-Za-z0-9_-]{32,128}$/;
const INVALID_FILENAME = /[/\\:*?"<>|]/;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function replaceControlCharacters(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    result += code <= 31 || code === 127 ? '�' : value[index];
  }
  return result;
}

export function isBrowserDirectoryHandle(value: unknown): value is BrowserExportDirectoryHandle {
  if (typeof value !== 'object' || value === null) return false;
  const handle = value as Partial<BrowserExportDirectoryHandle>;
  return handle.kind === 'directory'
    && typeof handle.name === 'string' && handle.name.length <= 1_000
    && typeof handle.getFileHandle === 'function'
    && typeof handle.queryPermission === 'function'
    && typeof handle.requestPermission === 'function';
}

export function isBrowserFileHandle(value: unknown): value is BrowserExportFileHandle {
  if (typeof value !== 'object' || value === null) return false;
  const handle = value as Partial<BrowserExportFileHandle>;
  return handle.kind === 'file'
    && typeof handle.name === 'string' && handle.name.length <= 1_000
    && typeof handle.createWritable === 'function'
    && typeof handle.queryPermission === 'function'
    && typeof handle.requestPermission === 'function';
}

export function safeDirectoryLabel(name: string): string {
  return replaceControlCharacters(name).slice(0, 500) || 'Selected folder';
}

function validDestinationLabel(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 500
    && !hasControlCharacters(value);
}

export function desktopDestination(value: unknown): ExportDestination | null {
  if (typeof value !== 'object' || value === null) return null;
  const grantId = 'grantId' in value ? value.grantId : undefined;
  const label = 'label' in value ? value.label : undefined;
  if (typeof grantId !== 'string' || !DESKTOP_GRANT_ID.test(grantId)) return null;
  if (!validDestinationLabel(label)) return null;
  if ('filename' in value) {
    const filename = value.filename;
    if (typeof filename !== 'string' || !validFilename(filename) || label !== filename) return null;
    return Object.freeze({
      type: 'desktop-file',
      grantId,
      label,
      filename,
    });
  }
  return Object.freeze({ type: 'desktop-directory', grantId, label });
}

export function checkedDestination(value: unknown): ExportDestination {
  if (typeof value !== 'object' || value === null) throw new ExportDestinationError('导出目录无效');
  const destination = value as Partial<ExportDestination>;
  if (destination.type === 'downloads' && validDestinationLabel(destination.label)) {
    return value as ExportDestination;
  }
  if (destination.type === 'browser-directory' && validDestinationLabel(destination.label)
    && isBrowserDirectoryHandle(destination.handle)) {
    return value as ExportDestination;
  }
  if (destination.type === 'browser-file' && validDestinationLabel(destination.label)
    && isBrowserFileHandle(destination.handle)) {
    return value as ExportDestination;
  }
  if (destination.type === 'desktop-directory' && validDestinationLabel(destination.label)
    && typeof destination.grantId === 'string' && DESKTOP_GRANT_ID.test(destination.grantId)) {
    return value as ExportDestination;
  }
  if (destination.type === 'desktop-file' && validDestinationLabel(destination.label)
    && typeof destination.grantId === 'string' && DESKTOP_GRANT_ID.test(destination.grantId)
    && typeof destination.filename === 'string' && validFilename(destination.filename)
    && destination.label === destination.filename) {
    return value as ExportDestination;
  }
  throw new ExportDestinationError('导出目录授权无效');
}

function validFilename(name: string): boolean {
  if (!name || name !== name.trim() || name === '.' || name === '..') return false;
  if (new TextEncoder().encode(name).byteLength > 240 || INVALID_FILENAME.test(name)
    || hasControlCharacters(name)) return false;
  if (/[. ]$/.test(name) || RESERVED_WINDOWS_NAME.test(name)) return false;
  return true;
}

export function checkedFilename(name: unknown): string {
  if (typeof name !== 'string' || !validFilename(name)) throw new ExportDestinationError('导出文件名无效');
  return name;
}
