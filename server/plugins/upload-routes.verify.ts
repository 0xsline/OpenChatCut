import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { seedKeystore } from '../keystore.ts';
import { resolveOrHydrateUploadFile } from '../media-dir.ts';
import {
  configuredUploadMaxBytes,
  getUploadObjectToFile,
  type R2Config,
} from '../r2.ts';
import { uploadMultipartPlugin } from './upload-multipart.ts';
import {
  directR2UploadAllowed,
  maxUploadBytes,
  registerUploadRoutes,
  type UploadRouteDependencies,
} from './upload-routes.ts';

const CAP = 8;
const OLD_DEFAULT_BYTES = 10 * 1024 ** 3;
const DECLARED_LARGE_BYTES = OLD_DEFAULT_BYTES + 1;
const ENV_NAMES = ['MEDIA_DIR', 'UPLOAD_MAX_BYTES', 'UPLOAD_MULTIPART_MAX_BYTES'] as const;
type EnvName = (typeof ENV_NAMES)[number];
const previousEnv = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
) as Record<EnvName, string | undefined>;

interface HttpResult {
  status: number;
  body: string;
}

function restoreEnv(): void {
  for (const name of ENV_NAMES) {
    const value = previousEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  assert.ok(response.ok, `unexpected ${response.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function chunkedPut(origin: string, path: string, chunks: readonly Buffer[]): Promise<HttpResult> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpResult>();
  const req = request(new URL(path, origin), {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'transfer-encoding': 'chunked',
    },
  }, (res) => {
    const responseChunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => responseChunks.push(chunk));
    res.on('end', () => resolve({
      status: res.statusCode ?? 0,
      body: Buffer.concat(responseChunks).toString('utf8'),
    }));
  });
  req.on('error', reject);
  for (const chunk of chunks) req.write(chunk);
  req.end();
  return promise;
}

async function assertMissing(path: string, message: string): Promise<void> {
  await assert.rejects(
    () => stat(path),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    message,
  );
}

async function multipartInit(
  origin: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; json: Record<string, unknown> }> {
  const response = await fetch(`${origin}/upload/multipart/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, json: JSON.parse(await response.text()) as Record<string, unknown> };
}

async function abortMultipart(origin: string, uploadId: string): Promise<void> {
  const response = await fetch(`${origin}/upload/multipart?uploadId=${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
  });
  assert.equal(response.status, 200, await response.text());
}

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-upload-routes-'));
const r2Config: R2Config = {
  accountId: 'test-account',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'test-bucket',
};
interface R2Fixture {
  chunks: readonly string[];
  contentLength?: number;
  etag: string;
}
const r2Fixtures: Record<string, R2Fixture> = {
  'uploads/header-too-large.bin': {
    chunks: ['x'],
    contentLength: CAP + 1,
    etag: '"header-too-large"',
  },
  'uploads/chunked-too-large.bin': {
    chunks: ['1234', '56789'],
    etag: '"chunked-too-large"',
  },
  'uploads/exact-boundary.bin': {
    chunks: ['1234', '5678'],
    contentLength: CAP,
    etag: '"exact-boundary"',
  },
};
const deletedR2Keys: string[] = [];
const fakeR2Client = {
  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key ?? '';
      const fixture = r2Fixtures[key];
      if (!fixture) {
        const error = new Error(`missing fake R2 object: ${key}`) as Error & { name: string };
        error.name = 'NoSuchKey';
        throw error;
      }
      return {
        Body: Readable.from(fixture.chunks.map((chunk) => Buffer.from(chunk))),
        ContentLength: fixture.contentLength,
        ContentType: 'application/octet-stream',
        ETag: fixture.etag,
      };
    }
    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key ?? '';
      const fixture = r2Fixtures[key];
      return { ContentLength: fixture?.contentLength, ETag: fixture?.etag };
    }
    if (command instanceof DeleteObjectCommand) {
      deletedR2Keys.push(command.input.Key ?? '');
      return {};
    }
    throw new Error(`unexpected fake R2 command: ${String(command)}`);
  },
} as unknown as Pick<S3Client, 'send'>;

const routeDependencies: UploadRouteDependencies = {
  syncLegacy: async () => undefined,
  resolveUpload: (name) => resolveOrHydrateUploadFile(name, {
    resolveLocal: () => null,
    cloudAvailable: () => true,
    uploadDirectory: () => directory,
    downloadToFile: (objectName, destination) => getUploadObjectToFile(
      objectName,
      destination,
      { config: r2Config, client: fakeR2Client },
    ),
  }),
};
const uploadRoutesPlugin: Plugin = {
  name: 'upload-routes-verification',
  configureServer(vite) {
    registerUploadRoutes(vite, routeDependencies);
  },
};

let server: ViteDevServer | undefined;
try {
  process.env.MEDIA_DIR = directory;
  for (const invalid of ['', '0', '-1', 'not-a-number']) {
    process.env.UPLOAD_MAX_BYTES = invalid;
    assert.equal(
      configuredUploadMaxBytes(),
      null,
      `invalid cap ${JSON.stringify(invalid)} must remain an uncapped policy`,
    );
    assert.equal(directR2UploadAllowed(true), true);
  }
  process.env.UPLOAD_MAX_BYTES = String(CAP);
  process.env.UPLOAD_MULTIPART_MAX_BYTES = String(12 * 1024 ** 3);
  seedKeystore({
    MEDIA_DIR: directory,
    R2_ACCOUNT_ID: r2Config.accountId,
    R2_ACCESS_KEY_ID: r2Config.accessKeyId,
    R2_SECRET_ACCESS_KEY: r2Config.secretAccessKey,
    R2_BUCKET: r2Config.bucket,
    R2_ENABLED: '1',
    R2_PRESIGN: '1',
  });

  assert.equal(configuredUploadMaxBytes(), CAP);
  assert.equal(maxUploadBytes(), CAP);
  assert.equal(directR2UploadAllowed(true), false);

  server = await createServer({
    root: directory,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [uploadMultipartPlugin(), uploadRoutesPlugin],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('upload verification server has no TCP address');
  const origin = `http://127.0.0.1:${address.port}`;

  const declaredRaw = await fetch(`${origin}/upload?name=raw.bin&assetId=raw-declared`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(CAP + 1),
    },
    body: Buffer.alloc(CAP + 1, 1),
  });
  assert.equal(declaredRaw.status, 413, await declaredRaw.text());
  await assertMissing(join(directory, 'raw-declared.bin'), 'declared raw overflow must not publish a file');

  const presign = await jsonResponse(await fetch(`${origin}/upload/presign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'proxy.bin', assetId: 'proxy-overflow' }),
  }));
  assert.equal(presign.mode, 'proxy', 'an explicit cap must suppress direct R2 PUT');
  assert.equal(presign.enabled, false);
  assert.equal(typeof presign.uploadUrl, 'string');
  const proxyOverflow = await chunkedPut(origin, String(presign.uploadUrl), [
    Buffer.alloc(CAP / 2, 2),
    Buffer.alloc(CAP / 2 + 1, 3),
  ]);
  assert.equal(proxyOverflow.status, 413, proxyOverflow.body);
  await assertMissing(join(directory, 'proxy-overflow.bin'), 'chunked proxy overflow must not publish a file');
  assert.equal(
    (await readdir(directory)).some((name) => name.includes('raw-declared') || name.includes('proxy-overflow')),
    false,
    'rejected raw/proxy uploads must remove temporary parts',
  );

  const oversizedInit = await multipartInit(origin, { name: 'too-large.bin', size: CAP + 1 });
  assert.equal(oversizedInit.response.status, 413, JSON.stringify(oversizedInit.json));
  assert.deepEqual(
    await readdir(join(directory, '.multipart')).catch(() => [] as string[]),
    [],
    'oversized multipart init must not leave a session',
  );

  const declaredPartSession = await multipartInit(origin, {
    name: 'declared-part.bin',
    assetId: 'declared-part',
    size: CAP,
  });
  assert.equal(declaredPartSession.response.status, 200, JSON.stringify(declaredPartSession.json));
  const declaredPartId = String(declaredPartSession.json.uploadId);
  const declaredPart = await fetch(
    `${origin}/upload/multipart/part?uploadId=${declaredPartId}&part=1`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(CAP + 1),
      },
      body: Buffer.alloc(CAP + 1, 4),
    },
  );
  assert.ok(declaredPart.status >= 400, `declared over-slot part was accepted: ${await declaredPart.text()}`);
  assert.deepEqual(
    await readdir(join(directory, '.multipart', declaredPartId)),
    ['meta.json'],
    'declared over-slot part must remove its temporary file',
  );
  const declaredComplete = await fetch(`${origin}/upload/multipart/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: declaredPartId }),
  });
  assert.equal(declaredComplete.status, 400, await declaredComplete.text());
  await assertMissing(join(directory, 'declared-part.bin'), 'an over-slot part must not become completable');
  await abortMultipart(origin, declaredPartId);

  const streamedPartSession = await multipartInit(origin, {
    name: 'streamed-part.bin',
    assetId: 'streamed-part',
    size: CAP,
  });
  assert.equal(streamedPartSession.response.status, 200, JSON.stringify(streamedPartSession.json));
  const streamedPartId = String(streamedPartSession.json.uploadId);
  const streamedPart = await chunkedPut(
    origin,
    `/upload/multipart/part?uploadId=${streamedPartId}&part=1`,
    [Buffer.alloc(CAP / 2, 5), Buffer.alloc(CAP / 2 + 1, 6)],
  );
  assert.ok(streamedPart.status >= 400, `chunked over-slot part was accepted: ${streamedPart.body}`);
  assert.deepEqual(
    await readdir(join(directory, '.multipart', streamedPartId)),
    ['meta.json'],
    'streamed over-slot part must remove its temporary file',
  );
  const streamedComplete = await fetch(`${origin}/upload/multipart/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: streamedPartId }),
  });
  assert.equal(streamedComplete.status, 400, await streamedComplete.text());
  await assertMissing(join(directory, 'streamed-part.bin'), 'actual over-slot bytes must not become completable');
  await abortMultipart(origin, streamedPartId);

  seedKeystore({ R2_ENABLED: '0' });
  const exactMultipartSession = await multipartInit(origin, {
    name: 'exact-multipart.bin',
    assetId: 'exact-multipart',
    size: CAP,
  });
  assert.equal(exactMultipartSession.response.status, 200, JSON.stringify(exactMultipartSession.json));
  const exactMultipartId = String(exactMultipartSession.json.uploadId);
  const exactPart = await fetch(
    `${origin}/upload/multipart/part?uploadId=${exactMultipartId}&part=1`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(CAP, 7),
    },
  );
  assert.equal(exactPart.status, 200, await exactPart.text());
  const exactComplete = await jsonResponse(await fetch(`${origin}/upload/multipart/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: exactMultipartId }),
  }));
  assert.equal(exactComplete.bytes, CAP, 'multipart completion must not publish beyond the configured cap');
  assert.equal((await stat(join(directory, 'exact-multipart.bin'))).size, CAP);

  for (const name of ['header-too-large.bin', 'chunked-too-large.bin']) {
    const hydrated = await fetch(`${origin}/upload/hydrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    assert.equal(hydrated.status, 413, `${name}: ${await hydrated.text()}`);
    await assertMissing(join(directory, name), `${name} must not be published`);
    await assertMissing(join(directory, `.${name}.part`), `${name} must remove its hydration part`);
    assert.ok(deletedR2Keys.includes(`uploads/${name}`), `${name} must invoke bounded R2 cleanup`);
  }

  const exactHydrate = await jsonResponse(await fetch(`${origin}/upload/hydrate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'exact-boundary.bin' }),
  }));
  assert.equal(exactHydrate.bytes, CAP);
  assert.equal(await readFile(join(directory, 'exact-boundary.bin'), 'utf8'), '12345678');
  await assertMissing(
    join(directory, '.exact-boundary.bin.part'),
    'successful hydration must rename, not retain, its part file',
  );

  delete process.env.UPLOAD_MAX_BYTES;
  assert.equal(configuredUploadMaxBytes(), null);
  assert.equal(maxUploadBytes(), Number.MAX_SAFE_INTEGER, 'unset policy must not restore the old 10 GiB cap');
  assert.equal(directR2UploadAllowed(true), true, 'uncapped policy retains direct-R2 eligibility');
  const largeDeclaration = await multipartInit(origin, {
    name: 'declared-over-old-default.mov',
    size: DECLARED_LARGE_BYTES,
    partSize: 64 * 1024 ** 2,
  });
  assert.equal(largeDeclaration.response.status, 200, JSON.stringify(largeDeclaration.json));
  assert.equal(
    largeDeclaration.json.maxBytes,
    Number.MAX_SAFE_INTEGER,
    'multipart declaration must expose the uncapped application policy',
  );
  assert.ok(Number(largeDeclaration.json.size) > OLD_DEFAULT_BYTES);
  await abortMultipart(origin, String(largeDeclaration.json.uploadId));

  assert.equal(basename(directory).startsWith('openchatcut-upload-routes-'), true);
} finally {
  await server?.close();
  await rm(directory, { recursive: true, force: true });
  restoreEnv();
}

console.log('upload route verification passed');
