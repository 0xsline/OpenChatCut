// Cloudflare R2 存储层(S3 兼容,server-only)。架构:上传写穿(本地磁盘=缓存,
// R2=真源)+ 读取回源(磁盘缺文件时经 dev server 从 R2 取回并落盘)——素材 src
// 保持同源 /media/uploads/... 路径不变,桶保持私有,密钥只在 keystore/.env.local。
// S3 ingest(request_asset_upload_url);我们以服务端代读写
// 替代 presigned 直传,规避去浏览器直连 R2 的 CORS 配置。
// 代理:R2 端点国内直连时好时坏——尊重 HTTPS_PROXY/https_proxy 环境变量(Clash)。
// 大文件:put/get 走流式,避免 1GB+ 素材整包进 Node 堆。
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

/** 四项齐全 + 开关未停用才算启用云存储(计入 caps.storage)。
 * ignoreEnabled:测试连接即使停用也要能验密钥。 */
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

// client 随配置变化重建(设置面板改 key 即时生效);同配置内存复用。
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

/** 上传写穿:PUT uploads/<name> 到 R2。Body 可为 Buffer 或可读流(大文件用流)。 */
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

/** 从本地文件流式写穿到 R2(大视频路径)。 */
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

/** 读取回源到内存(仅适合小对象/测试;大文件请用 getUploadObjectToFile)。 */
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

/** 读取回源并流式落盘(大文件回源缓存)。返回 contentType + bytes;不存在 → null。 */
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
 * 是否允许浏览器直连 R2 的预签名 PUT/GET。
 * 默认开启(R2 已配置时);设 R2_PRESIGN=0 则仅服务端写穿(规避 CORS)。
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

/** 测试连接探针:HeadBucket 合成 Response(桶存在 + 鉴权通过 = 200)。
 * S3 错误映射为对应 HTTP 状态给 classifyStatus;网络层错误原样抛给 networkMessage。 */
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
    throw err; // 网络层(DNS/超时/代理)→ runProbe 的 networkMessage
  }
}
