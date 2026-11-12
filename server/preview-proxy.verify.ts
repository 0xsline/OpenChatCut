// Regression gate for the preview-proxy failure memo.
//
// Once a derivative build failed, `{reason,error}` was persisted and every later
// request returned it — including `?force=1` — so a transient ffmpeg failure
// pinned that clip to the (stuttering, seek-hostile) master for the life of the
// media with no way to retry. `force=1` must discard the memo and rebuild, while
// a plain request must still honour it (otherwise every playback retries ffmpeg).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin } from './media-binaries.ts';
import { handlePreviewProxy, type PreviewSourceProbe } from './preview-proxy.ts';

const directory = await mkdtemp(join(tmpdir(), 'occ-preview-proxy-'));
const source = join(directory, 'clip.mp4');
const proxyPath = join(directory, 'clip.proxy.mp4');
const statusPath = join(directory, 'clip.proxy-status.json');

try {
  // mpeg4 is not in the direct-play codec set, so a plain request already wants a
  // proxy — that keeps this test independent of resolution/GOP heuristics.
  const generated = spawnSync(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2',
    '-pix_fmt', 'yuv420p', '-c:v', 'mpeg4', source,
  ], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const info = await stat(source);

  let buildAttempts = 0;
  let failBuild = true;
  let payload: PreviewPayload | undefined;
  let servedPath: string | undefined;
  const deps = {
    resolve: async () => ({ name: 'clip.mp4', file: source, source: { size: info.size, mtimeMs: info.mtimeMs } }),
    cachePath: (_name: string, _source: { size: number; mtimeMs: number }, kind: string, ext: string) => (
      kind === 'proxy-status' ? statusPath : join(directory, `clip.${kind}.${ext}`)
    ),
    atomicBuild: async (path: string, build: (tmp: string) => Promise<void>) => {
      if (path !== statusPath) {
        buildAttempts += 1;
        if (failBuild) throw new Error('ffmpeg encoder failed transiently');
      }
      await build(path);
    },
    runDerivative: async <T>(
      _req: IncomingMessage,
      _res: ServerResponse,
      _key: string,
      work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> => work(new AbortController().signal),
    serveCached: async (_req: IncomingMessage, _res: ServerResponse, path: string) => { servedPath = path; },
    sendJson: (_res: ServerResponse, status: number, body: unknown) => {
      assert.equal(status, 200);
      payload = body as PreviewPayload;
    },
    handleError: (_res: ServerResponse, label: string, error: unknown) => {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    },
    logError: () => undefined,
  };

  // 1. A transient build failure is reported and memoized.
  await run('/api/preview-proxy?src=%2Fmedia%2Fuploads%2Fclip.mp4&force=1', deps);
  assert.equal(buildAttempts, 1);
  assert.equal(payload?.proxy.status, 'failed');
  assert.match(String((payload?.proxy as { error?: string } | undefined)?.error ?? ''), /failed transiently/);
  assert.equal(existsSync(statusPath), true, 'the failure memo is persisted');

  // 2. force=1 must retry: same input, machine now idle → the build runs again.
  failBuild = false;
  await run('/api/preview-proxy?src=%2Fmedia%2Fuploads%2Fclip.mp4&force=1', deps);
  assert.equal(buildAttempts, 2, 'force=1 must bypass the memoized failure and retry the build');
  assert.equal(payload?.proxy.status, 'ready');
  assert.equal(existsSync(proxyPath), true, 'the retried build publishes a proxy');
  assert.equal(existsSync(statusPath), false, 'a successful build clears the memo');
  assert.equal(servedPath, undefined, 'the payload points at the proxy file route, not a served path');

  // 3. A plain (unforced) request must still honour a memo — retrying ffmpeg on
  //    every playback would be worse than the pinned preview.
  await rm(proxyPath, { force: true });
  failBuild = true;
  await run('/api/preview-proxy?src=%2Fmedia%2Fuploads%2Fclip.mp4&force=1', deps);
  assert.equal(buildAttempts, 3);
  assert.equal(payload?.proxy.status, 'failed');
  assert.equal(existsSync(statusPath), true);
  await run('/api/preview-proxy?src=%2Fmedia%2Fuploads%2Fclip.mp4', deps);
  assert.equal(buildAttempts, 3, 'an unforced request must reuse the memo instead of rebuilding');
  assert.equal(payload?.proxy.status, 'failed');
  assert.match(await readFile(statusPath, 'utf8'), /failed transiently/);

  // 4. force=1 after a memoized failure rebuilds even once the memo is stale.
  failBuild = false;
  await run('/api/preview-proxy?src=%2Fmedia%2Fuploads%2Fclip.mp4&force=1', deps);
  assert.equal(buildAttempts, 4);
  assert.equal(payload?.proxy.status, 'ready');
} finally {
  await rm(directory, { recursive: true, force: true });
}

interface PreviewPayload {
  source: Omit<PreviewSourceProbe, 'unstableCodec'> & { src: string };
  proxy: { status: 'not-needed' | 'ready' | 'failed'; reason: string; error?: string; previewSrc?: string };
}

async function run(url: string, deps: Parameters<typeof handlePreviewProxy>[2]): Promise<void> {
  await handlePreviewProxy(
    { url, headers: {}, method: 'GET' } as unknown as IncomingMessage,
    { destroyed: false } as unknown as ServerResponse,
    deps,
  );
}

console.log('preview proxy failure memo verification passed');
