import { constants } from 'node:fs';
import { access, mkdir, open, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  collectExportMediaPlan,
  type ExportMediaPlan,
  type ExportMediaReference,
} from '../../src/export/exportMediaPlan.ts';
import {
  createExportFailure,
  ExportFailureError,
  type ExportMediaIssue,
} from '../../src/export/exportFailure.ts';
import {
  isSafeUploadName,
  resolveOrHydrateUploadFile,
  resolveUploadFile,
  uploadDir,
  type ResolvedUploadFile,
} from '../media-dir.ts';
import { safePublicFetch } from '../safe-public-fetch.ts';

const MAX_MATERIALIZED_MEDIA_BYTES = 10 * 1024 * 1024 * 1024;
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/m4a': '.m4a',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/heic': '.heic',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-m4v': '.m4v',
  'application/x-cube': '.cube',
};

export interface ServerExportMediaOptions {
  publicDirectory?: string;
  uploadDirectory?: string;
  fetcher?: typeof safePublicFetch;
  resolveUpload?: (name: string) => string | null;
  hydrateUpload?: (name: string) => Promise<ResolvedUploadFile | null>;
  maxMaterializedBytes?: number;
}

export interface MaterializedServerExportMedia<Value> {
  readonly snapshot: Value;
  readonly plan: ExportMediaPlan;
  readonly localPaths: readonly string[];
  cleanup(): Promise<void>;
}

type ResolvedServerExportMediaOptions = Required<Pick<
  ServerExportMediaOptions,
  'publicDirectory' | 'uploadDirectory' | 'fetcher' | 'resolveUpload' | 'hydrateUpload' | 'maxMaterializedBytes'
>>;

async function readableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function issueFor(reference: ExportMediaReference, code: ExportMediaIssue['code'], message: string): ExportMediaIssue {
  return { ...reference, code, message };
}

function isHtmlContentType(contentType: string | null | undefined): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/html';
}

function extensionFor(source: string, contentType: string | null): string {
  const mime = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const mimeExtension = MIME_EXTENSIONS[mime];
  if (mimeExtension) return mimeExtension;
  try {
    const extension = extname(new URL(source).pathname).toLowerCase();
    if (/^\.(?:aac|avif|bin|cube|flac|gif|heic|jpe?g|m4a|m4v|mov|mp3|mp4|ogg|opus|png|svg|wav|webm|webp)$/.test(extension)) {
      return extension;
    }
  } catch {
    // safePublicFetch already validated the URL; use a neutral extension.
  }
  return '.bin';
}

async function cleanupPaths(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await unlink(path);
        return;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        if (attempt === 4) throw error;
        await delay(25 * 2 ** attempt);
      }
    }
  }));
}

async function materializeRemote(
  reference: ExportMediaReference,
  options: ResolvedServerExportMediaOptions,
): Promise<{ localPath: string; publicPath: string } | ExportMediaIssue> {
  let response: Response | undefined;
  let partialPath: string | undefined;
  let finalPath: string | undefined;
  let handle: FileHandle | undefined;
  try {
    response = await options.fetcher(reference.source, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(30 * 60_000),
    });
    const contentType = response.headers.get('content-type');
    if (isHtmlContentType(contentType)) {
      return issueFor(
        reference,
        'missing_source',
        `Media source resolved to HTML instead of media (HTTP ${response.status}): ${reference.source}`,
      );
    }
    if (response.status !== 200 || !response.body) {
      return issueFor(
        reference,
        response.status === 404 ? 'missing_source' : 'unreadable',
        `Media source is not readable (HTTP ${response.status}): ${reference.source}`,
      );
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > options.maxMaterializedBytes) {
      return issueFor(reference, 'unreadable', `Media source exceeds the materialization limit: ${reference.source}`);
    }

    await mkdir(options.uploadDirectory, { recursive: true });
    const filename = `openchatcut-render-media-${randomUUID()}${extensionFor(reference.source, contentType)}`;
    finalPath = resolve(options.uploadDirectory, filename);
    partialPath = `${finalPath}.part`;
    handle = await open(partialPath, 'wx', 0o600);
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > options.maxMaterializedBytes) {
          throw new Error(`Media source exceeds the materialization limit: ${reference.source}`);
        }
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value.subarray(offset));
          if (bytesWritten < 1) throw new Error(`Media source could not be written: ${reference.source}`);
          offset += bytesWritten;
        }
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    }
    if (bytes < 1) throw new Error(`Media source returned an empty body: ${reference.source}`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(partialPath, finalPath);
    partialPath = undefined;
    return { localPath: finalPath, publicPath: `/media/uploads/${filename}` };
  } catch (error) {
    return issueFor(
      reference,
      'unreadable',
      `Media source could not be materialized: ${reference.source} (${error instanceof Error ? error.message : String(error)})`,
    );
  } finally {
    await response?.body?.cancel().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    if (partialPath) await unlink(partialPath).catch(() => undefined);
    if (finalPath && !await readableFile(finalPath)) await unlink(finalPath).catch(() => undefined);
  }
}

async function checkLocalReference(
  reference: ExportMediaReference,
  options: ResolvedServerExportMediaOptions,
): Promise<ExportMediaIssue | null> {
  if (reference.source.startsWith('data:')) return null;
  if (reference.source.startsWith('blob:')) {
    return issueFor(reference, 'unsupported_source', `Blob URL is not readable by the export server: ${reference.source}`);
  }
  if (reference.source.startsWith('file:') || isAbsolute(reference.source) && !reference.source.startsWith('/')) {
    return issueFor(reference, 'unsupported_source', `Local file source is not mapped for export: ${reference.source}`);
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(reference.source.split(/[?#]/, 1)[0] ?? '');
  } catch {
    return issueFor(reference, 'unsupported_source', `Media source has invalid path encoding: ${reference.source}`);
  }
  const uploadPrefix = '/media/uploads/';
  if (pathname.startsWith(uploadPrefix)) {
    const name = pathname.slice(uploadPrefix.length);
    if (!isSafeUploadName(name)) {
      return issueFor(reference, 'unsupported_source', `Media upload name is unsafe: ${reference.source}`);
    }
    const local = options.resolveUpload(name);
    if (local) {
      return await readableFile(local)
        ? null
        : issueFor(reference, 'unreadable', `Media upload is not readable: ${reference.source}`);
    }
    let hydrated: ResolvedUploadFile | null;
    try {
      hydrated = await options.hydrateUpload(name);
    } catch (error) {
      return issueFor(
        reference,
        'unreadable',
        `Media upload could not be restored: ${reference.source} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (!hydrated) return issueFor(reference, 'missing_source', `Media upload is missing: ${reference.source}`);
    if (isHtmlContentType(hydrated.contentType)) {
      return issueFor(reference, 'missing_source', `Media upload resolved to HTML instead of media: ${reference.source}`);
    }
    return await readableFile(hydrated.file)
      ? null
      : issueFor(reference, 'unreadable', `Restored media upload is not readable: ${reference.source}`);
  }
  if (!pathname.startsWith('/')) {
    return issueFor(reference, 'unsupported_source', `Relative media source is not mapped for export: ${reference.source}`);
  }
  const candidate = resolve(options.publicDirectory, `.${pathname}`);
  const escaped = relative(options.publicDirectory, candidate);
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    return issueFor(reference, 'unsupported_source', `Media source escapes the public directory: ${reference.source}`);
  }
  return await readableFile(candidate)
    ? null
    : issueFor(reference, 'missing_source', `Public media source is missing or unreadable: ${reference.source}`);
}

function collectExternalMediaFields(snapshot: unknown): ExportMediaReference[] {
  const references: ExportMediaReference[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, fieldPrefix: string): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${fieldPrefix}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const field = fieldPrefix ? `${fieldPrefix}.${key}` : key;
      if (typeof child === 'string'
        && /^https?:\/\//i.test(child)
        && (/(?:^|_)(?:src|url|path|cube|lut)$/i.test(key) || /(?:Src|Url|Path)$/.test(key))) {
        references.push({ source: child, owner: 'item', field });
      } else if (child && typeof child === 'object') {
        visit(child, field);
      }
    }
  };
  visit(snapshot, '');
  return references;
}

function replaceMaterializedSources(value: unknown, replacements: ReadonlyMap<string, string>, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      if (typeof child === 'string') value[index] = replacements.get(child) ?? child;
      else replaceMaterializedSources(child, replacements, seen);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      if (replacements.has(child)) Reflect.set(value, key, replacements.get(child));
    } else {
      replaceMaterializedSources(child, replacements, seen);
    }
  }
}

function freezeSnapshot(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeSnapshot(child, seen);
  Object.freeze(value);
}

function resolvedOptions(options: ServerExportMediaOptions): ResolvedServerExportMediaOptions {
  const requestedLimit = options.maxMaterializedBytes;
  const maxMaterializedBytes = typeof requestedLimit === 'number'
    && Number.isFinite(requestedLimit)
    && requestedLimit > 0
    ? Math.floor(requestedLimit)
    : MAX_MATERIALIZED_MEDIA_BYTES;
  return {
    publicDirectory: resolve(options.publicDirectory ?? resolve(process.cwd(), 'public')),
    uploadDirectory: resolve(options.uploadDirectory ?? uploadDir()),
    fetcher: options.fetcher ?? safePublicFetch,
    resolveUpload: options.resolveUpload ?? resolveUploadFile,
    hydrateUpload: options.hydrateUpload ?? resolveOrHydrateUploadFile,
    maxMaterializedBytes,
  };
}

function preflightFailure(issues: readonly ExportMediaIssue[]): ExportFailureError {
  return new ExportFailureError(createExportFailure({
    stage: 'preflight',
    code: 'export_media_preflight_failed',
    retryable: false,
    message: `Export media preflight failed for ${issues.length} reference${issues.length === 1 ? '' : 's'}`,
    mediaIssues: [...issues],
  }));
}

/**
 * Resolve every render-visible external URL exactly once through safePublicFetch,
 * atomically publish it under the controlled upload directory, and freeze a
 * snapshot whose renderer-visible references are same-origin paths.
 */
export async function materializeServerExportMedia<Value>(
  snapshot: Value,
  options: ServerExportMediaOptions = {},
): Promise<MaterializedServerExportMedia<Value>> {
  const plan = collectExportMediaPlan(snapshot);
  if (plan.issues.length > 0) throw preflightFailure(plan.issues);
  const resolved = resolvedOptions(options);
  const remoteReferences = [
    ...plan.references.filter((reference) => /^https?:\/\//i.test(reference.source)),
    ...collectExternalMediaFields(snapshot),
  ];
  const localReferences = plan.references.filter((reference) => !/^https?:\/\//i.test(reference.source));
  const localIssues = (await Promise.all(localReferences.map((reference) => checkLocalReference(reference, resolved))))
    .filter((issue): issue is ExportMediaIssue => issue !== null);
  if (localIssues.length > 0) throw preflightFailure(localIssues);

  const replacements = new Map<string, string>();
  const localPaths: string[] = [];
  const remoteIssues: ExportMediaIssue[] = [];
  const attemptedRemoteSources = new Set<string>();
  for (const reference of remoteReferences) {
    if (attemptedRemoteSources.has(reference.source)) continue;
    attemptedRemoteSources.add(reference.source);
    const materialized = await materializeRemote(reference, resolved);
    if ('code' in materialized) {
      remoteIssues.push(materialized);
      continue;
    }
    replacements.set(reference.source, materialized.publicPath);
    localPaths.push(materialized.localPath);
  }
  if (remoteIssues.length > 0) {
    await cleanupPaths(localPaths);
    throw preflightFailure(remoteIssues);
  }

  const immutable = structuredClone(snapshot);
  replaceMaterializedSources(immutable, replacements, new WeakSet());
  freezeSnapshot(immutable, new WeakSet());
  let cleanupPromise: Promise<void> | undefined;
  return Object.freeze({
    snapshot: immutable,
    plan,
    localPaths: Object.freeze([...localPaths]),
    cleanup: () => cleanupPromise ??= cleanupPaths(localPaths),
  });
}

export async function validateServerExportMedia(
  snapshot: unknown,
  options: ServerExportMediaOptions = {},
): Promise<ExportMediaPlan> {
  const materialized = await materializeServerExportMedia(snapshot, options);
  await materialized.cleanup();
  return materialized.plan;
}
