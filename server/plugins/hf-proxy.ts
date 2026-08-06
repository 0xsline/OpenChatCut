// GET /api/hf-proxy/<owner>/<repo>/resolve/<rev>/<path...>
// Proxies Hugging Face model-file downloads through the local server so the
// on-device ASR worker can fetch models same-origin:
//   - same-origin → no CORS restrictions (hf-mirror redirects are unusable in
//     the browser; Node fetch cannot reach the LFS CDN on many networks)
//   - curl child process downloads (verified reachable where undici is not)
//   - disk cache under ~/.openchatcut/asr-models → re-loads are instant and
//     survive restarts (never inside the repo/public, shared across projects)
// Security: only <owner>/<repo> model ids matching the whitelist pattern, no
// path traversal, fixed resolve revision handling, size-capped cache files.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MODEL_ID = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/;
const REV = /^[A-Za-z0-9_.-]+$/;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const MAX_CACHE_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB hard cap
const CURL_TIMEOUT_S = 1800;
const CURL_ROUNDS = 6; // each round also retries internally (--retry 8)
const PARALLEL_CHUNKS = 4; // per-connection throttling → parallel byte ranges

/**
 * Download sources, tried in order. The official host is correct (ModelScope
 * mirrors of these files fail onnxruntime-web protobuf parsing) and is fetched
 * in parallel byte ranges to beat per-connection throttling; hf-mirror is a
 * same-content fallback.
 */
const SOURCES: ReadonlyArray<{ name: string; url: (target: ProxyTarget) => string }> = [
  {
    name: 'huggingface',
    url: (target) => `https://huggingface.co/${target.modelId}/resolve/${target.revision}/${target.filePath}`,
  },
  {
    name: 'hf-mirror',
    url: (target) => `https://hf-mirror.com/${target.modelId}/resolve/${target.revision}/${target.filePath}`,
  },
];

/** Cache lives in the user data dir — never inside the repo (public/ gets
 *  built into dist) and shared across projects. */
function modelCacheDir(): string {
  return join(homedir(), '.openchatcut', 'asr-models');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function contentTypeOf(file: string): string {
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.txt')) return 'text/plain';
  if (file.endsWith('.onnx')) return 'application/octet-stream';
  if (file.endsWith('.model')) return 'application/octet-stream';
  if (file.endsWith('.bin')) return 'application/octet-stream';
  return 'application/octet-stream';
}

interface ProxyTarget {
  modelId: string;
  revision: string;
  filePath: string;
}

/** Parse /Xenova/whisper-small/resolve/main/onnx/foo.onnx → safe target or null. */
function parseTarget(rawPath: string): ProxyTarget | null {
  const clean = decodeURIComponent(rawPath.split('?')[0] ?? '').replace(/^\/+/, '');
  const parts = clean.split('/');
  const resolveIdx = parts.indexOf('resolve');
  if (resolveIdx < 1 || resolveIdx + 2 >= parts.length) return null;
  const modelId = parts.slice(0, resolveIdx).join('/');
  if (!MODEL_ID.test(modelId)) return null;
  const revision = parts[resolveIdx + 1];
  if (!REV.test(revision)) return null;
  const fileParts = parts.slice(resolveIdx + 2);
  if (fileParts.length === 0 || fileParts.some((segment) => !SEGMENT.test(segment))) return null;
  return { modelId, revision, filePath: fileParts.join('/') };
}

async function cacheFile(target: ProxyTarget): Promise<string> {
  const finalPath = join(modelCacheDir(), target.modelId, ...target.filePath.split('/'));
  if (existsSync(finalPath)) {
    const size = (await stat(finalPath)).size;
    if (size > 0 && size <= MAX_CACHE_FILE_BYTES) return finalPath;
    await unlink(finalPath).catch(() => undefined);
  }
  await mkdir(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.part`;
  const runCurl = (url: string, out: string, range?: string): Promise<void> => new Promise<void>((resolve, reject) => {
    const args = [
      '-sSL', '--fail', '--max-time', String(CURL_TIMEOUT_S),
      '--speed-limit', '1024', '--speed-time', '30',
      '--retry', '8', '--retry-delay', '3', '--retry-all-errors',
    ];
    if (range) args.push('-r', range);
    else args.push('-C', '-');
    args.push('-o', out, url);
    const child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += String(c);
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`model download failed (curl exit ${code}): ${stderr.slice(-300)}`));
    });
  });

  /** Single-connection download with resume (fallback sources). */
  const downloadSingle = async (url: string): Promise<void> => {
    let lastError: unknown;
    for (let round = 0; round < CURL_ROUNDS; round += 1) {
      try {
        await runCurl(url, tmpPath);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
  };

  /** Parallel byte-range download (official host, beats per-connection throttle). */
  const downloadParallel = async (url: string, size: number): Promise<void> => {
    const chunkSize = Math.ceil(size / PARALLEL_CHUNKS);
    const parts = Array.from({ length: PARALLEL_CHUNKS }, (_, i) => ({
      file: `${tmpPath}.${i}`,
      range: `${i * chunkSize}-${i === PARALLEL_CHUNKS - 1 ? size - 1 : (i + 1) * chunkSize - 1}`,
    }));
    let lastError: unknown;
    for (let round = 0; round < CURL_ROUNDS; round += 1) {
      try {
        await Promise.all(parts.map((part) => runCurl(url, part.file, part.range)));
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    // Merge chunks in order; verify the total before accepting.
    const chunks = await Promise.all(parts.map((part) => readFile(part.file)));
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (total !== size) {
      throw new Error(`parallel download size mismatch: got ${total}, expected ${size}`);
    }
    const fd = await open(tmpPath, 'w');
    try {
      for (const chunk of chunks) await fd.write(chunk);
    } finally {
      await fd.close();
    }
    await Promise.all(parts.map((part) => unlink(part.file).catch(() => undefined)));
  };

  let lastError: unknown;
  for (const source of SOURCES) {
    try {
      await unlink(tmpPath).catch(() => undefined);
      const url = source.url(target);
      if (source.name === 'huggingface') {
        // LFS CDNs report unreliable content-length on HEAD; a 1-byte range
        // GET returns the authoritative total in Content-Range.
        const size = await new Promise<number>((resolve, reject) => {
          const child = spawn('curl', ['-sS', '--max-time', '60', '-L', '-r', '0-0', '-D', '-', '-o', '/dev/null', url], { stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          child.stdout?.on('data', (c: Buffer) => { stdout += String(c); });
          child.on('error', reject);
          child.on('close', (code) => {
            if (code !== 0) { reject(new Error(`range probe failed (curl exit ${code})`)); return; }
            const m = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(stdout);
            const size = m ? Number(m[1]) : NaN;
            if (!Number.isFinite(size) || size <= 0 || size > MAX_CACHE_FILE_BYTES) {
              reject(new Error(`invalid content-range: ${stdout.slice(0, 160)}`));
              return;
            }
            resolve(size);
          });
        });
        await downloadParallel(url, size);
      } else {
        await downloadSingle(url);
      }
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  const size = (await stat(tmpPath)).size;
  if (size <= 0 || size > MAX_CACHE_FILE_BYTES) {
    await unlink(tmpPath).catch(() => undefined);
    throw new Error(`model download produced an invalid file (${size} bytes)`);
  }
  await rename(tmpPath, finalPath);
  return finalPath;
}

async function handleProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed — use GET' });
    return;
  }
  const target = parseTarget(req.url ?? '');
  if (!target) {
    sendJson(res, 400, { error: 'invalid model path — expected /api/hf-proxy/<owner>/<repo>/resolve/<rev>/<file>' });
    return;
  }
  try {
    const file = await cacheFile(target);
    const size = (await stat(file)).size;
    res.setHeader('Content-Type', contentTypeOf(file));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Accept-Ranges', 'bytes');
    // onnxruntime-web fetches large model files in byte ranges; honoring them
    // is required (returning the full body for every range corrupts assembly).
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : size - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && end < size) {
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          res.setHeader('Content-Length', String(end - start + 1));
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${size}`);
        sendJson(res, 416, { error: 'range not satisfiable' });
        return;
      }
    }
    res.statusCode = 200;
    res.setHeader('Content-Length', String(size));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: message });
  }
}

export function hfProxyPlugin(): Plugin {
  return {
    name: 'openchatcut-hf-proxy',
    configureServer(server) {
      server.middlewares.use('/api/hf-proxy', (req, res) => {
        void handleProxy(req, res);
      });
    },
  };
}
