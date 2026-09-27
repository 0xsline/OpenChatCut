// POST /api/export-media-sources: which files an FCPXML export should name and
// which timecode each starts at (issue #27), and who may ask. Real reference
// manifests in temp upload directories, and real ffmpeg-tagged media end to end.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MAX_EXPORT_MEDIA_SOURCES, type ExportMediaStart } from '../../shared/export-media-sources.ts';
import type { TimelineItem, TimelineState } from '../../src/editor/types.ts';
import { timelineToFcpxml } from '../../src/export/fcpxml.ts';
import { fcpxmlDtdViolations } from '../../src/export/fcpxml.verify-support.ts';
import { resolveExportMediaSources } from '../export-media-sources.ts';
import { ffmpegBin } from '../media-binaries.ts';
import { normalizeMediaFile } from '../media-normalization-runner.ts';
import { registerMediaReference } from '../media-references.ts';
import { probeMediaStart } from '../media-timecode.ts';
import { handleExportMediaSourcesRequest } from './export-media-sources.ts';

const run = promisify(execFile);

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

async function call(req: IncomingMessage, resolve = async (sources: readonly string[]) => ({
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
  const noTimecode = async () => null;
  const resolved = await resolveExportMediaSources([
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
  ], noTimecode, [writable, legacy]);
  assert.deepEqual(resolved, {
    '/media/uploads/r1.normalized.mp4?v=2': { path: join(writable, 'r1.normalized.mp4'), originalPath: await realpath(clip) },
    '/media/uploads/r1.mov': { path: await realpath(clip), originalPath: await realpath(clip) },
    '/media/uploads/r2.wav': { path: await realpath(legacyClip), originalPath: await realpath(legacyClip) },
    '/media/uploads/dup.normalized.mp4': { path: join(writable, 'dup.normalized.mp4') },
    '/media/uploads/managed.normalized.mp4': { path: join(writable, 'managed.normalized.mp4') },
  }, 'references resolve in read order, derived copies find their one original, unsafe or unknown sources stay out');

  // ── Starts: the original's own when readable, else its working copy's; one probe per file, four at a time ──
  {
    const uploads = join(root, 'tc-uploads');
    const card = join(root, 'Card 01');
    await Promise.all([uploads, card].map((directory) => mkdir(directory, { recursive: true })));
    const originals = Object.fromEntries(await Promise.all(
      ['inplace', 'derived', 'unreadable', 'untagged', 'offline', 'extra1', 'extra2'].map(async (stem) => {
        const file = join(card, `${stem}.mov`);
        await writeFile(file, 'camera original');
        await registerMediaReference(uploads, `${stem}.mov`, file);
        return [stem, await realpath(file)] as const;
      }),
    )) as Record<string, string>;
    const copy = (stem: string) => join(uploads, `${stem}.normalized.mp4`);
    await Promise.all(['derived', 'unreadable', 'untagged', 'offline'].map((stem) => writeFile(copy(stem), 'working copy')));
    await writeFile(join(uploads, 'managed.mp4'), 'browser upload');
    await rm(originals.offline!);
    const at = (seconds: number): ExportMediaStart => ({ value: seconds * 25, timescale: 25, timecode: 'label', dropFrame: false });
    const starts = new Map<string, ExportMediaStart | null | Error>([
      [originals.inplace!, at(36_000)],
      [copy('derived'), at(3_600)], [originals.derived!, at(7_200)],
      [copy('unreadable'), at(1_800)], [originals.unreadable!, new Error('unreadable')],
      [copy('untagged'), at(900)], [originals.untagged!, null],
      [copy('offline'), at(600)],
      [join(uploads, 'managed.mp4'), at(60)],
      [originals.extra1!, null], [originals.extra2!, null],
    ]);
    const probed: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const probe = async (path: string): Promise<ExportMediaStart | null> => {
      probed.push(path);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const start = starts.get(path);
      if (start instanceof Error) throw start;
      return start ?? null;
    };
    const located = await resolveExportMediaSources([
      '/media/uploads/inplace.mov', '/media/uploads/inplace.mov?v=2',
      '/media/uploads/derived.normalized.mp4', '/media/uploads/derived.mov',
      '/media/uploads/unreadable.normalized.mp4', '/media/uploads/untagged.normalized.mp4',
      '/media/uploads/offline.normalized.mp4', '/media/uploads/managed.mp4',
      '/media/uploads/extra1.mov', '/media/uploads/extra2.mov',
    ], probe, [uploads]);
    const inplace = { path: originals.inplace, originalPath: originals.inplace, pathStart: at(36_000), originalStart: at(36_000) };
    assert.deepEqual(located, {
      '/media/uploads/inplace.mov': inplace,
      '/media/uploads/inplace.mov?v=2': inplace,
      '/media/uploads/derived.normalized.mp4': {
        path: copy('derived'), originalPath: originals.derived, pathStart: at(3_600), originalStart: at(7_200),
      },
      '/media/uploads/derived.mov': {
        path: originals.derived, originalPath: originals.derived, pathStart: at(7_200), originalStart: at(7_200),
      },
      '/media/uploads/unreadable.normalized.mp4': {
        path: copy('unreadable'), originalPath: originals.unreadable, pathStart: at(1_800), originalStart: at(1_800),
      },
      '/media/uploads/untagged.normalized.mp4': {
        path: copy('untagged'), originalPath: originals.untagged, pathStart: at(900),
      },
      '/media/uploads/offline.normalized.mp4': {
        path: copy('offline'), originalPath: originals.offline, pathStart: at(600), originalStart: at(600),
      },
      '/media/uploads/managed.mp4': { path: join(uploads, 'managed.mp4'), pathStart: at(60) },
      '/media/uploads/extra1.mov': { path: originals.extra1, originalPath: originals.extra1 },
      '/media/uploads/extra2.mov': { path: originals.extra2, originalPath: originals.extra2 },
    }, 'a readable original keeps its own start (even none); an unreadable or offline one borrows its copy\'s');
    assert.deepEqual(probed.toSorted(), [...new Set(probed)].toSorted(), 'each file is probed once per export');
    assert.equal(probed.length, 11, 'every online file behind the timeline is probed');
    assert.ok(peak <= 4 && peak > 1, `probes run a few at a time (peak ${peak})`);
  }

  // ── End to end: ffmpeg-tagged clips export on their own timecode; untagged media stays at 0s ──
  {
    const uploads = join(root, 'e2e-uploads');
    const card = join(root, '素材 Card #2');
    await Promise.all([uploads, card].map((directory) => mkdir(directory, { recursive: true })));
    const make = async (name: string, fps: string, tail: string[]) => {
      const file = join(card, name);
      await run(ffmpegBin(), [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=d=0.4:r=${fps}:s=64x36`, '-c:v', 'mpeg4', ...tail, file,
      ]);
      return file;
    };
    const [pal, ntsc, plain] = await Promise.all([
      make('A001 10h.mov', '25', ['-timecode', '10:00:00:00']),
      make('B001 df.mov', '30000/1001', ['-timecode', '01:00:00;00']),
      make('C001 plain.mp4', '25', []),
    ]);
    await registerMediaReference(uploads, 'p1.mov', pal);
    await registerMediaReference(uploads, 'n1.mov', ntsc);
    await registerMediaReference(uploads, 'u1.mp4', plain);
    await normalizeMediaFile({
      inputPath: pal, publicSrc: '/media/uploads/p1.mov', outputPath: join(uploads, 'p1.normalized.mp4'),
      preserveInput: true, force: true, publishR2: false, uploadsDirectory: uploads,
    });
    const clip = (id: string, track: string, src: string, srcInFrame: number): TimelineItem => ({
      id, track, src, srcInFrame, kind: 'video', startFrame: 10, durationInFrames: 5, name: id,
    });
    const state: TimelineState = {
      fps: 25, width: 1920, height: 1080, selectedId: null,
      tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, V3: { kind: 'video' } }, trackOrder: ['V3', 'V2', 'V1'],
      items: [
        clip('pal', 'V1', '/media/uploads/p1.normalized.mp4', 3),
        clip('ntsc', 'V2', '/media/uploads/n1.mov', 2),
        clip('plain', 'V3', '/media/uploads/u1.mp4', 4),
      ],
    };
    const mediaSources = await resolveExportMediaSources(state.items.map((item) => item.src!), probeMediaStart, [uploads]);
    for (const nleFormat of ['fcp_xml', 'fcp_xml_resolve'] as const) {
      const xml = timelineToFcpxml(state, { mediaDir: uploads, mediaSources, nleFormat });
      const asset = (id: string) => xml.match(new RegExp(`<asset id="id-${id}"[\\s\\S]*?</asset>`))?.[0] ?? '';
      const assetStart = (id: string) => asset(id).match(/<asset [^>]*start="([^"]*)"/)?.[1];
      const clipOf = (id: string) => xml.match(new RegExp(`<asset-clip ref="id-${id}"[^>]*/>`))?.[0] ?? '';
      const reps = (id: string) => [...asset(id).matchAll(/kind="([^"]*)" src="([^"]*)"/g)]
        .map(([, kind, src]) => [kind, fileURLToPath(src!)]);
      assert.equal(assetStart('pal'), '900000/25s', `${nleFormat}: 10:00:00:00 @ 25 fps is the asset start`);
      assert.match(clipOf('pal'), / offset="10\/25s" duration="5\/25s" start="900003\/25s" .*tcFormat="NDF"/,
        `${nleFormat}: clip start = timecode + in-point, in the asset's time; offset stays on the timeline`);
      assert.deepEqual(reps('pal'), [['original-media', await realpath(pal)], ['proxy-media', join(uploads, 'p1.normalized.mp4')]],
        `${nleFormat}: the normalized copy keeps the camera timecode, so it stays the proxy`);
      assert.equal(assetStart('ntsc'), '107999892/30000s', `${nleFormat}: 01:00:00;00 drop-frame is frame 107892 at 30000/1001`);
      assert.match(clipOf('ntsc'), / start="108002292\/30000s" .*tcFormat="DF"/,
        `${nleFormat}: 2 frames at 25 fps past 01:00:00;00, exact`);
      assert.equal(assetStart('plain'), '0s', `${nleFormat}: untagged media still starts at 0s`);
      assert.match(clipOf('plain'), / start="4\/25s" name="plain"\/>/, `${nleFormat}: untagged clips keep the plain in-point`);
      assert.deepEqual(fcpxmlDtdViolations(xml), [], `${nleFormat}: timecoded export validates against the FCPXML 1.10 DTD`);
    }
  }
} finally {
  if (previousEditorUrl === undefined) delete process.env.OPENCHATCUT_EDITOR_URL;
  else process.env.OPENCHATCUT_EDITOR_URL = previousEditorUrl;
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('export-media-sources.verify: route gate, body validation, reference resolution, start timecodes and timecoded export passed\n');
