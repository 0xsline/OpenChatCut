// Browser-hosted local media routes (issue #185): a plain browser tab has no
// Electron bridge, so browse_local_media and the import_* tools reach the same
// core the desktop app uses over these same-origin POSTs. This drives the real
// middleware against a loopback socket to prove authorization, the mandatory
// AGENT_IMPORT_ROOTS allowlist, browsing, deduped import, and root escape
// rejection. npx tsx server/plugins/local-media.verify.ts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalCurrentUploadDirectory } from '../directory-watch-import.ts';
import { seedKeystore } from '../keystore.ts';
import { resolveUploadFile } from '../media-dir.ts';
import { mediaReferenceManifestPath } from '../media-references.ts';
import { LOCAL_MEDIA_BROWSE_PATH, LOCAL_MEDIA_IMPORT_PATH, localMediaPlugin } from './local-media.ts';

/** A valid 16-bit mono PCM wav (1s silence) so the probe reports a duration;
 *  CI checkouts have no runtime uploads to copy from. */
function silentWavBytes(seconds = 1): Uint8Array {
  const sampleRate = 16_000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buffer);
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;
const handlers = new Map<string, RouteHandler>();
const configureServer = localMediaPlugin().configureServer;
assert.equal(typeof configureServer, 'function');
if (typeof configureServer !== 'function') throw new Error('local media plugin must register routes');
configureServer({
  middlewares: {
    use(path: string, handler: RouteHandler) {
      handlers.set(path, handler);
    },
  },
} as never);
assert.ok(handlers.has(LOCAL_MEDIA_BROWSE_PATH), 'browse route registered');
assert.ok(handlers.has(LOCAL_MEDIA_IMPORT_PATH), 'import route registered');

const server = createServer((req, res) => {
  const spoofed = req.headers['x-test-remote-address'];
  if (typeof spoofed === 'string') {
    const actual = req.socket.remoteAddress;
    Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: spoofed });
    res.once('finish', () => Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: actual }));
  }
  const handler = handlers.get((req.url ?? '').split('?')[0] ?? '');
  if (!handler) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  req.url = '/';
  handler(req, res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
// Chrome marks same-origin fetches this way; projectStoreHttpAuthorized requires it.
const editorHeaders = { 'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(
  `${origin}${path}`,
  {
    method: 'POST',
    headers: { ...editorHeaders, ...headers },
    body: JSON.stringify(body),
  },
);
const json = async (response: Response) => await response.json() as Record<string, unknown>;

const workRoot = await mkdtemp(join(tmpdir(), 'occ-local-media-route-'));
const root = await realpath(workRoot);
const uploadDir = await canonicalCurrentUploadDirectory();
const cleanup = new Set<string>();
try {
  // ── Local-device gate: cross-site and non-loopback requests never reach a file ──
  let response = await post(LOCAL_MEDIA_BROWSE_PATH, { path: root }, { Origin: 'https://evil.example' });
  assert.equal(response.status, 403, 'a cross-site page cannot list local media');
  response = await post(LOCAL_MEDIA_BROWSE_PATH, { path: root }, { 'X-Test-Remote-Address': '192.0.2.44' });
  assert.equal(response.status, 403, 'a non-loopback socket cannot spoof a same-origin editor');
  response = await fetch(`${origin}${LOCAL_MEDIA_BROWSE_PATH}`, { headers: editorHeaders });
  assert.equal(response.status, 405, 'the browse route refuses non-POST methods');
  response = await fetch(`${origin}${LOCAL_MEDIA_IMPORT_PATH}`, { headers: editorHeaders });
  assert.equal(response.status, 405, 'the import route refuses non-POST methods');

  // ── A browser editor must opt in: an unseeded allowlist refuses everything ──
  response = await post(LOCAL_MEDIA_BROWSE_PATH, { path: root });
  assert.equal(response.status, 403, 'browsing needs an explicit allowlist');
  assert.equal((await json(response)).code, 'IMPORT_ROOTS_NOT_CONFIGURED');
  response = await post(LOCAL_MEDIA_IMPORT_PATH, { paths: [root], projectId: 'project-185', knownHashes: [] });
  assert.equal(response.status, 403, 'importing needs an explicit allowlist');
  assert.equal((await json(response)).code, 'IMPORT_ROOTS_NOT_CONFIGURED');

  // ── With an explicit root: browse, search, and refuse escapes ──
  seedKeystore({ AGENT_IMPORT_ROOTS: root });
  await mkdir(join(root, 'Interview'));
  await writeFile(join(root, 'A.MP4'), 'media listing does not decode bytes');
  await writeFile(join(root, 'notes.md'), 'not a media asset');
  const sourcePath = join(root, 'Interview', 'take.wav');
  await writeFile(sourcePath, silentWavBytes());

  const listing = await json(await post(LOCAL_MEDIA_BROWSE_PATH, { path: root }));
  assert.deepEqual(
    (listing.entries as Array<{ name: string }>).map((entry) => entry.name),
    ['A.MP4', 'Interview'],
    'only supported media and directories are listed',
  );
  assert.equal(listing.truncated, false);
  const search = await json(await post(
    LOCAL_MEDIA_BROWSE_PATH, { path: root, recursive: true, query: 'take', kind: 'audio' },
  ));
  assert.deepEqual((search.entries as Array<{ path: string }>).map((entry) => entry.path), [sourcePath]);

  response = await post(LOCAL_MEDIA_BROWSE_PATH, { path: root, limit: 0 });
  assert.equal(response.status, 400, 'an invalid browse body is refused');
  response = await post(LOCAL_MEDIA_BROWSE_PATH, { path: join(root, '..') });
  assert.equal(response.status, 400, 'a path outside the allowlist is refused');
  assert.match(String((await json(response)).error), /已添加的目录/);

  // ── Import runs the canonical probe/hash chain, then dedupes ──
  const imported = await json(await post(
    LOCAL_MEDIA_IMPORT_PATH, { paths: [sourcePath], projectId: 'project-185', knownHashes: [] },
  ));
  const files = imported.imported as Array<{ storedName: string; src: string; contentHash: string; kind: string }>;
  assert.equal((imported.errors as unknown[]).length, 0, JSON.stringify(imported.errors));
  assert.equal(files.length, 1, 'exactly one file imported');
  assert.equal(files[0]!.kind, 'audio');
  assert.match(files[0]!.contentHash, /^[0-9a-f]{64}$/, 'SHA-256 fingerprint present');
  assert.match(files[0]!.src, /^\/media\/uploads\//);
  cleanup.add(mediaReferenceManifestPath(uploadDir, files[0]!.storedName));
  assert.equal(resolveUploadFile(files[0]!.storedName), sourcePath, 'the published URL resolves to the allowlisted source');

  const duplicate = await json(await post(
    LOCAL_MEDIA_IMPORT_PATH,
    { paths: [sourcePath], projectId: 'project-185', knownHashes: [files[0]!.contentHash] },
  ));
  assert.equal((duplicate.imported as unknown[]).length, 0, 'duplicate content is not re-imported');
  assert.equal(duplicate.duplicateCount, 1, 'repeated content is reported as a duplicate');

  const outside = await json(await post(
    LOCAL_MEDIA_IMPORT_PATH, { paths: [join(root, '..')], projectId: 'project-185', knownHashes: [] },
  ));
  assert.equal((outside.errors as Array<{ code?: string }>)[0]?.code, 'PATH_OUTSIDE_IMPORT_ROOTS');

  response = await post(LOCAL_MEDIA_IMPORT_PATH, { paths: [], projectId: 'project-185', knownHashes: [] });
  assert.equal(response.status, 400, 'an empty batch is refused');
  response = await post(LOCAL_MEDIA_IMPORT_PATH, { paths: [sourcePath], projectId: '', knownHashes: [] });
  assert.equal(response.status, 400, 'a missing projectId is refused');
  response = await post(LOCAL_MEDIA_IMPORT_PATH, { paths: [sourcePath], projectId: 'project-185', knownHashes: ['nope'] });
  assert.equal(response.status, 400, 'a malformed hash list is refused');

  // ── A symlink inside the root must not reach outside it ──
  const outsideRoot = await mkdtemp(join(tmpdir(), 'occ-local-media-outside-'));
  const escapeLink = join(root, 'escape');
  try {
    await writeFile(join(outsideRoot, 'secret.wav'), silentWavBytes());
    // A junction lets this run unprivileged on Windows; POSIX ignores the type.
    await symlink(outsideRoot, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
    response = await post(LOCAL_MEDIA_BROWSE_PATH, { path: escapeLink });
    assert.equal(response.status, 400, 'a symlink out of the allowlist cannot be browsed');
    const escaped = await json(await post(
      LOCAL_MEDIA_IMPORT_PATH,
      { paths: [join(escapeLink, 'secret.wav')], projectId: 'project-185', knownHashes: [] },
    ));
    assert.equal((escaped.imported as unknown[]).length, 0, 'a symlinked path cannot import outside the allowlist');
    assert.equal((escaped.errors as Array<{ code?: string }>)[0]?.code, 'PATH_OUTSIDE_IMPORT_ROOTS');
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
  }

  console.log('local-media.verify: browser allowlist, browse, import and escape gates passed');
} finally {
  for (const path of cleanup) await rm(path, { force: true }).catch(() => undefined);
  await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  server.close();
  await once(server, 'close');
}

// Registration is the classic silent failure: assert the assembled server plugin
// list really mounts this route, the same check export-stage.verify runs.
const { serverPlugins } = await import('./index.ts');
assert.ok(
  serverPlugins().some((plugin) => plugin.name === 'openchatcut-local-media'),
  'localMediaPlugin must be registered in serverPlugins()',
);
console.log('local-media.verify: registered in serverPlugins');
