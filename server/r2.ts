// Cloudflare R2 storage layer (S3 compatible, server-only). Architecture: Upload Write Through (local disk = cache,
// R2 = true source) + read back to the source (when the disk is missing files, it is retrieved from R2 via the dev server and dropped to the disk) - material src
// Keep the same origin /media/uploads/... path unchanged, the bucket remains private, and the key is only in keystore/.env.local.
// S3 ingest(request_asset_upload_url); We use the server to read and write
// Replaces presigned direct transmission and avoids the CORS configuration of direct browser connection to R2.
// Proxy: R2 endpoint domestic direct connection is sometimes good or bad - respect the HTTPS_PROXY/https_proxy environment variable (Clash).
// Large files: Put/get is streamed to avoid 1GB+ material being packed into the Node heap.
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getKey, type KeyName } from './keystore.ts';

type Get = (name: KeyName) => string;
const fromKeystore: Get = (name) => getKey(name);

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** All four items + Cloud storage must be enabled only if the switch is not disabled(credited caps.storage)。
 * ignoreEnabled:The test connection must be able to verify the key even if it is disabled. */
export function r2Config(get: Get = fromKeystore, opts?: { ignoreEnabled?: boolean }): R2Config | null {
  if (!opts?.ignoreEnabled && get('R2_ENABLED') === '0') return null;
  const accountId = get('R2_ACCOUNT_ID');
  const accessKeyId = get('R2_ACCESS_KEY_ID');
  const secretAccessKey = get('R2_SECRET_ACCESS_KEY');
  const bucket = get('R2_BUCKET');
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

function proxyHandler(): NodeHttpHandler | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  if (!proxy) return undefined;
  const agent = new HttpsProxyAgent(proxy);
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

/** Upload write-through:PUT uploads/<name> Arrive R2。Body can be Buffer or readable stream(Streaming for large files)。 */
export async function putUploadObject(
  name: string,
  body: UploadBody,
  contentType?: string,
  contentLength?: number,
): Promise<void> {
  const cfg = r2Config();
  if (!cfg) return;
  await clientFor(cfg).send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: `uploads/${name}`,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
    ...(typeof contentLength === 'number' && contentLength >= 0
      ? { ContentLength: contentLength }
      : {}),
  }));
}

/** Streaming write-through from local file to R2(Large video path)。 */
export async function putUploadFile(
  name: string,
  filePath: string,
  contentType?: string,
): Promise<void> {
  const info = await stat(filePath);
  await putUploadObject(name, createReadStream(filePath), contentType, info.size);
}

export interface R2Object {
  body: Buffer;
  contentType: string;
  bytes: number;
}

/** Read back from source to memory(Only suitable for small objects/test;Please use for large files getUploadObjectToFile)。 */
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

/** Read back to source and stream to disk(Large file back-to-origin cache). Return contentType + bytes;does not exist → null。 */
export async function getUploadObjectToFile(
  name: string,
  destPath: string,
): Promise<{ contentType: string; bytes: number } | null> {
  const cfg = r2Config();
  if (!cfg) return null;
  try {
    const res = await clientFor(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: `uploads/${name}` }));
    if (!res.Body) return null;
    const body = res.Body as Readable;
    await pipeline(body, createWriteStream(destPath));
    const bytes = typeof res.ContentLength === 'number'
      ? res.ContentLength
      : (await stat(destPath)).size;
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
 * Whether to allow direct browser connection R2 pre-signed PUT/GET。
 * Enabled by default(R2 When configured);Set R2_PRESIGN=0 Then only the server side writes through(avoid CORS)。
 * request_asset_upload_url → S3 presigned PUT。
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

/** Test connection probe:HeadBucket synthesis Response(bucket exists + Authentication passed = 200)。
 * S3 The error is mapped to the corresponding HTTP status to classifyStatus;Network layer errors are thrown unchanged to networkMessage。 */
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
      const note = status === 404 ? `bucket「${cfg.bucket}” does not exist` : name;
      return new Response(note, { status });
    }
    throw err; // Network layer (DNS/timeouts/proxy) → runProbe's networkMessage
  }
}
