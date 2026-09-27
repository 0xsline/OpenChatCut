// POST /api/export-media-sources: which files an FCPXML export should name (issue #27),
// and who may ask. Real reference manifests in temp upload directories.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MAX_EXPORT_MEDIA_SOURCES } from '../../shared/export-media-sources.ts';
import { resolveExportMediaSources } from '../export-media-sources.ts';
import { registerMediaReference } from '../media-references.ts';
import { handleExportMediaSourcesRequest } from './export-media-sources.ts';

function request(
  method: string,
  body: string,
  headers: Record<string, string>,
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  const stream = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage;
  stream.method = method;
  stream.url = '/';
  stream.headers = headers;
  Object.defineProperty(stream, 'socket', { value: { remoteAddress } });
  return stream;
}

async function call(req: IncomingMessage, resolve = (sources: readonly string[]) => ({
  [sources[0] ?? '']: { path: '/resolved' },
})): Promise<{ status: number; body: Record<string, unknown>; resolved: number }> {
  let resolved = 0;
  let status = 0;
  let text = '';
  const res = {
    headersSent: false,
    get statusCode() { return status; },
    set statusCode(value: number) { status = value; },
    setHeader: () => undefined,
    end: (chunk?: string) => { text = chunk ?? ''; },
  } as unknown as ServerResponse;
  await handleExportMediaSourcesRequest(req, res, {
    resolve: (sources) => { resolved += 1; return resolve(sources); },
  });
  return { status, body: JSON.parse(text || '{}') as Record<string, unknown>, resolved };
}

const editorHeaders = { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' };
const previousEditorUrl = process.env.OPENCHATCUT_EDITOR_URL;
delete process.env.OPENCHATCUT_EDITOR_URL;
const root = await mkdtemp(join(tmpdir(), 'openchatcut-export-media-sources-'));
try {
  // ── Route: only the local editor page may learn source paths ──
  const body = JSON.stringify({ sources: ['/media/uploads/a.mp4'] });
  assert.equal((await call(request('GET', '', editorHeaders))).status, 405);
  const crossSite = await call(request('POST', body, { ...editorHeaders, origin: 'http://evil.example' }));
  assert.deepEqual([crossSite.status, crossSite.resolved], [403, 0], 'a cross-site page is refused before any lookup');
  const remote = await call(request('POST', body, editorHeaders, '192.168.1.20'));
  assert.deepEqual([remote.status, remote.resolved], [403, 0], 'a LAN client is refused');
  const noOrigin = await call(request('POST', body, { host: '127.0.0.1:5173' }));
  assert.deepEqual([noOrigin.status, noOrigin.resolved], [403, 0], 'an Origin-less request is refused');
  const ok = await call(request('POST', body, editorHeaders));
  assert.deepEqual([ok.status, ok.body], [200, { ok: true, sources: { '/media/uploads/a.mp4': { path: '/resolved' } } }]);
  for (const bad of ['{', JSON.stringify({ sources: 'a' }), JSON.stringify({ sources: [1] }),
    JSON.stringify({ sources: Array.from({ length: MAX_EXPORT_MEDIA_SOURCES + 1 }, (_, i) => `/media/uploads/${i}.mp4`) })]) {
    const rejected = await call(request('POST', bad, editorHeaders));
    assert.deepEqual([rejected.status, rejected.resolved], [400, 0], `malformed body is rejected: ${bad.slice(0, 40)}`);
  }

  // ── Resolver: upload read order, derived working copies, and nothing outside the uploads ──
  const writable = join(root, 'writable');
  const legacy = join(root, 'legacy');
  const folder = join(root, 'Footage 素材');
  await Promise.all([writable, legacy, folder].map((directory) => mkdir(directory, { recursive: true })));
  const [clip, other, legacyClip, mxf] = ['clip.mov', 'other.mov', 'legacy.wav', 'clip.mxf'].map((name) => join(folder, name));
  await Promise.all([clip, other, legacyClip, mxf].map((file) => writeFile(file, 'media')));
  await registerMediaReference(writable, 'r1.mov', clip);
  await writeFile(join(writable, 'r1.normalized.mp4'), 'transcode');
  await registerMediaReference(legacy, 'r2.wav', legacyClip);
  await registerMediaReference(writable, 'dup.mov', other);
  await registerMediaReference(writable, 'dup.mxf', mxf);
  await writeFile(join(writable, 'dup.normalized.mp4'), 'transcode of an ambiguous stem');
  await writeFile(join(writable, 'managed.normalized.mp4'), 'transcode of a managed upload');
  await writeFile(join(legacy, 'r1.mov'), 'a same-named file in a later read dir');
  const resolved = resolveExportMediaSources([
    '/media/uploads/r1.normalized.mp4?v=2',
    '/media/uploads/r1.mov',
    '/media/uploads/r2.wav',
    '/media/uploads/dup.normalized.mp4',
    '/media/uploads/managed.normalized.mp4',
    '/media/uploads/..%2F..%2Fetc%2Fpasswd',
    '/media/uploads/.references',
    '/etc/passwd',
    'https://cdn.example/r1.mov',
    '/media/uploads/missing.mov',
  ], [writable, legacy]);
  assert.deepEqual(resolved, {
    '/media/uploads/r1.normalized.mp4?v=2': { path: join(writable, 'r1.normalized.mp4'), originalPath: await realpath(clip) },
    '/media/uploads/r1.mov': { path: await realpath(clip), originalPath: await realpath(clip) },
    '/media/uploads/r2.wav': { path: await realpath(legacyClip), originalPath: await realpath(legacyClip) },
    '/media/uploads/dup.normalized.mp4': { path: join(writable, 'dup.normalized.mp4') },
    '/media/uploads/managed.normalized.mp4': { path: join(writable, 'managed.normalized.mp4') },
  }, 'references resolve in read order, derived copies find their one original, unsafe or unknown sources stay out');
} finally {
  if (previousEditorUrl === undefined) delete process.env.OPENCHATCUT_EDITOR_URL;
  else process.env.OPENCHATCUT_EDITOR_URL = previousEditorUrl;
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('export-media-sources.verify: route gate, body validation, and reference resolution passed\n');
