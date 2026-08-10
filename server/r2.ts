// Cloudflare R2 storage layer (S3 compatible, server-only). Architecture: Upload Write Through (local disk = cache,
// R2 = true source) + read back to the source (when the disk is missing files, it is retrieved from R2 via the dev server and dropped to the disk) - asset src
// Keep the same origin /media/uploads/... path unchanged, the bucket remains private, and the key is only in keystore/.env.local.
// Browser uploads are written through the authenticated server route; this avoids
// exposing object-store credentials and does not require browser-to-R2 CORS.
// Proxy: R2 endpoint domestic direct connection is sometimes good or bad - respect the HTTPS_PROXY/https_proxy environment variable (Clash).
// Large files: put/get is streamed to avoid 1GB+ asset being packed into the Node heap.
// Isolated development profiles disable this unnamespaced store completely.
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand,
  PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { getKey, type KeyName } from './keystore.ts';
import { outboundHttpAgent } from './outbound-proxy.ts';
import { isIsolatedDevProfile } from './runtime-profile.ts';

const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;
/** Finite default: large enough for long-form source masters while bounding disk/R2 abuse. */
export const DEFAULT_UPLOAD_MAX_BYTES = 20 * 1024 ** 3;

/** A positive UPLOAD_MAX_BYTES overrides the finite 20 GiB application default. */
export function configuredUploadMaxBytes(): number | null {
  const raw = process.env.UPLOAD_MAX_BYTES?.trim();
  if (!raw) return null;
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_SAFE_BYTES) : null;
}

export function effectiveUploadMaxBytes(): number {
  return configuredUploadMaxBytes() ?? DEFAULT_UPLOAD_MAX_BYTES;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes % (1024 ** 3) === 0 ? 0 : 1)}GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export class UploadTooLargeError extends Error {
  constructor(max: number) {
    super(`file too large (max ${formatBytes(max)})`);
    this.name = 'UploadTooLargeError';
  }
}

type Get = (name: KeyName) => string;
const fromKeystore: Get = (name) => getKey(name);

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Cloud storage (counted into caps.storage) must be enabled when all four items are complete + the switch is not disabled.
 * ignoreEnabled: The test connection must be able to verify the key even if it is disabled. */
export function r2Config(get: Get = fromKeystore, opts?: { ignoreEnabled?: boolean }): R2Config | null {
  if (isIsolatedDevProfile()) return null;
  if (!opts?.ignoreEnabled && get('R2_ENABLED') === '0') return null;
  const accountId = get('R2_ACCOUNT_ID');
  const accessKeyId = get('R2_ACCESS_KEY_ID');
  const secretAccessKey = get('R2_SECRET_ACCESS_KEY');
  const bucket = get('R2_BUCKET');
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

function proxyHandler(): NodeHttpHandler | undefined {
  const agent = outboundHttpAgent();
  if (!agent) return undefined;
  return new NodeHttpHandler({ httpsAgent: agent });
}

// The client is rebuilt as the configuration changes (key changes in the settings panel take effect immediately); the same configuration memory is reused.
let cached: { key: string; client: S3Client } | null = null;
function clientFor(cfg: R2Config): S3Client {
  const key = `${cfg.accountId}|${cfg.accessKeyId}|${cfg.secretAccessKey.slice(0, 6)}`;
  if (cached?.key === key) return cached.client;
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: true,
    requestHandler: proxyHandler(),
  });
  cached = { key, client };
  return client;
}

export type UploadBody = Buffer | Uint8Array | Readable;

export type PutUploadObjectResult = 'stored' | 'exists' | 'off';
export interface PutUploadObjectIfAbsentOptions {
  ifAbsent: true;
  rollbackToken: string;
}

function isPreconditionFailed(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const code = (error as { name?: string }).name ?? '';
  return status === 409 || status === 412 || code === 'ConditionalRequestConflict' || code === 'PreconditionFailed';
}

/** Upload writethrough: PUT uploads/<name> to R2, optionally without replacing an existing object. */
export function putUploadObject(
  name: string,
  body: UploadBody,
  contentType?: string,
  contentLength?: number,
): Promise<void>;
export function putUploadObject(
  name: string,
  body: UploadBody,
  contentType: string | undefined,
  contentLength: number | undefined,
  options: PutUploadObjectIfAbsentOptions,
): Promise<PutUploadObjectResult>;
export async function putUploadObject(
  name: string,
  body: UploadBody,
  contentType?: string,
  contentLength?: number,
  options?: PutUploadObjectIfAbsentOptions,
): Promise<void | PutUploadObjectResult> {
  const cfg = r2Config();
  if (!cfg) return options ? 'off' : undefined;
  try {
    await clientFor(cfg).send(new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: `uploads/${name}`,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
      ...(typeof contentLength === 'number' && contentLength >= 0
        ? { ContentLength: contentLength }
        : {}),
      ...(options ? { IfNoneMatch: '*' } : {}),
      ...(options ? { Metadata: { 'openchatcut-import-token': options.rollbackToken } } : {}),
    }));
    return options ? 'stored' : undefined;
  } catch (error) {
    if (options && isPreconditionFailed(error)) return 'exists';
    throw error;
  }
}

/** Streaming write-through from local file to R2 (large video path). */
export function putUploadFile(name: string, filePath: string, contentType?: string): Promise<void>;
export function putUploadFile(
  name: string,
  filePath: string,
  contentType: string | undefined,
  options: PutUploadObjectIfAbsentOptions,
): Promise<PutUploadObjectResult>;
export async function putUploadFile(
  name: string,
  filePath: string,
  contentType?: string,
  options?: PutUploadObjectIfAbsentOptions,
): Promise<void | PutUploadObjectResult> {
  const info = await stat(filePath);
  if (options) {
    return putUploadObject(name, createReadStream(filePath), contentType, info.size, options);
  }
  await putUploadObject(name, createReadStream(filePath), contentType, info.size);
}

/** Delete one upload from R2. Returns false when R2 is not configured. */
export async function deleteUploadObject(name: string, rollbackToken?: string): Promise<boolean> {
  const cfg = r2Config();
  if (!cfg) return false;
  if (!rollbackToken) {
    await clientFor(cfg).send(new DeleteObjectCommand({
      Bucket: cfg.bucket,
      Key: `uploads/${name}`,
    }));
    return true;
  }
  let etag: string | undefined;
  try {
    const head = await clientFor(cfg).send(new HeadObjectCommand({
      Bucket: cfg.bucket,
      Key: `uploads/${name}`,
    }));
    if (head.Metadata?.['openchatcut-import-token'] !== rollbackToken) return false;
    etag = head.ETag;
    if (!etag) return false;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  try {
    await clientFor(cfg).send(new DeleteObjectCommand({
      Bucket: cfg.bucket,
      Key: `uploads/${name}`,
      IfMatch: etag,
    }));
    return true;
  } catch (error) {
    if (isNotFound(error) || isPreconditionFailed(error)) return false;
    throw error;
  }
}

export interface R2Object {
  body: Buffer;
  contentType: string;
  bytes: number;
}

export interface R2DownloadOptions {
  config?: R2Config;
  client?: Pick<S3Client, 'send'>;
  signal?: AbortSignal;
}

/** Read back from source to memory (only suitable for small objects/tests; please use getUploadObjectToFile for large files).*/
export async function getUploadObject(name: string): Promise<R2Object | null> {
  const cfg = r2Config();
  if (!cfg) return null;
  try {
    const res = await clientFor(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: `uploads/${name}` }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) return null;
    const body = Buffer.from(bytes);
    return { body, contentType: res.ContentType || 'application/octet-stream', bytes: body.length };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}
/** Stream an R2 upload body to disk while enforcing the configured application byte limit. */
export async function writeBoundedUploadStream(
  source: Readable,
  destPath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        signal?.throwIfAborted();
        if (chunk.length > maxBytes - bytes) {
          done(new UploadTooLargeError(maxBytes));
          return;
        }
        bytes += chunk.length;
        done(null, chunk);
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  try {
    signal?.throwIfAborted();
    await pipeline(source, counter, createWriteStream(destPath), { signal });
    signal?.throwIfAborted();
    return bytes;
  } catch (error) {
    await unlink(destPath).catch(() => undefined);
    throw error;
  }
}

async function deleteOversizedUploadObject(
  cfg: R2Config,
  name: string,
  maxBytes: number,
  expectedEtag?: string,
  options?: R2DownloadOptions,
): Promise<boolean> {
  let etag = expectedEtag;
  if (!etag) {
    try {
      const head = await (options?.client ?? clientFor(cfg)).send(new HeadObjectCommand({
        Bucket: cfg.bucket,
        Key: `uploads/${name}`,
      }));
      if (typeof head.ContentLength === 'number' && head.ContentLength <= maxBytes) return false;
      etag = head.ETag;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
  if (!etag) return false;
  try {
    await (options?.client ?? clientFor(cfg)).send(new DeleteObjectCommand({
      Bucket: cfg.bucket,
      Key: `uploads/${name}`,
      IfMatch: etag,
    }));
    return true;
  } catch (error) {
    if (isNotFound(error) || isPreconditionFailed(error)) return false;
    throw error;
  }
}

async function rejectOversizedUploadObject(
  cfg: R2Config,
  name: string,
  destPath: string,
  maxBytes: number,
  etag: string | undefined,
  body: Readable,
  options?: R2DownloadOptions,
): Promise<never> {
  body.destroy();
  await unlink(destPath).catch(() => undefined);
  try {
    await deleteOversizedUploadObject(cfg, name, maxBytes, etag, options);
  } catch (cleanupError) {
    const error = new UploadTooLargeError(maxBytes) as UploadTooLargeError & { cause?: unknown };
    error.cause = cleanupError;
    throw error;
  }
  throw new UploadTooLargeError(maxBytes);
}


/** Read through to disk while enforcing the effective upload cap against streamed bytes. */
export async function getUploadObjectToFile(
  name: string,
  destPath: string,
  options?: R2DownloadOptions,
): Promise<{ contentType: string; bytes: number } | null> {
  if (isIsolatedDevProfile()) return null;
  const cfg = options?.config ?? r2Config();
  if (!cfg) return null;
  const signal = options?.signal;
  try {
    signal?.throwIfAborted();
    const res = await (options?.client ?? clientFor(cfg)).send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: `uploads/${name}` }),
      { abortSignal: signal },
    );
    signal?.throwIfAborted();
    if (!res.Body) return null;
    const body = res.Body as Readable;
    const maxBytes = effectiveUploadMaxBytes();
    if (typeof res.ContentLength === 'number' && res.ContentLength > maxBytes) {
      return await rejectOversizedUploadObject(cfg, name, destPath, maxBytes, res.ETag, body, options);
    }
    let bytes: number;
    try {
      bytes = await writeBoundedUploadStream(body, destPath, maxBytes, signal);
    } catch (error) {
      await unlink(destPath).catch(() => undefined);
      if (error instanceof UploadTooLargeError) {
        try {
          await deleteOversizedUploadObject(cfg, name, maxBytes, res.ETag, options);
        } catch (cleanupError) {
          error.cause = cleanupError;
        }
      }
      throw error;
    }
    signal?.throwIfAborted();
    return {
      contentType: res.ContentType || 'application/octet-stream',
      bytes,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const code = (err as { name?: string }).name ?? '';
  return status === 404 || code === 'NoSuchKey' || code === 'NotFound';
}

/**
 * Whether to allow browsers to directly connect to R2's pre-signed PUT/GET.
 * Enabled by default when R2 is configured; set R2_PRESIGN=0 to keep server-mediated writes.
 */
export function r2PresignEnabled(get: Get = fromKeystore): boolean {
  if (!r2Config(get)) return false;
  return get('R2_PRESIGN') !== '0';
}

export interface PresignedUpload {
  /** Browser PUT target (R2 endpoint, signed). */
  uploadUrl: string;
  /** Same-origin path the editor uses after upload (local cache + R2 key). */
  path: string;
  /** Object key inside the bucket. */
  fileKey: string;
  /** Seconds until the URL expires. */
  expiresIn: number;
  mode: 'presign';
}

/** Presigned PUT for uploads/<name>. Caller must PUT exact Content-Type if signed with it. */
export async function presignPutUpload(
  name: string,
  contentType?: string,
  expiresIn = 3600,
): Promise<PresignedUpload | null> {
  const cfg = r2Config();
  if (!cfg || !r2PresignEnabled()) return null;
  const key = `uploads/${name}`;
  const cmd = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ...(contentType ? { ContentType: contentType } : {}),
  });
  const uploadUrl = await getSignedUrl(clientFor(cfg), cmd, { expiresIn });
  return {
    uploadUrl,
    path: `/media/uploads/${name}`,
    fileKey: key,
    expiresIn,
    mode: 'presign',
  };
}

/** Presigned GET for private-bucket read (export / share). */
export async function presignGetUpload(
  name: string,
  expiresIn = 3600,
): Promise<{ downloadUrl: string; fileKey: string; expiresIn: number } | null> {
  const cfg = r2Config();
  if (!cfg || !r2PresignEnabled()) return null;
  const key = `uploads/${name}`;
  const cmd = new GetObjectCommand({ Bucket: cfg.bucket, Key: key });
  const downloadUrl = await getSignedUrl(clientFor(cfg), cmd, { expiresIn });
  return { downloadUrl, fileKey: key, expiresIn };
}

/** Test connection probe: HeadBucket synthetic response (bucket exists + authentication passed = 200).
 * S3 errors are mapped to the corresponding HTTP status to classifyStatus; network layer errors are thrown to networkMessage as they are.*/
export async function r2Probe(get: Get): Promise<Response> {
  const cfg = r2Config(get, { ignoreEnabled: true });
  if (!cfg) return new Response('missing config', { status: 400 });
  try {
    await clientFor(cfg).send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    return new Response('', { status: 200 });
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (err as { name?: string }).name ?? '';
    if (typeof status === 'number' && status > 0) {
      const note = status === 404 ? `bucket「${cfg.bucket}」不存在` : name;
      return new Response(note, { status });
    }
    throw err; // Network layer (DNS/timeouts/proxy) → runProbe's networkMessage
  }
}
