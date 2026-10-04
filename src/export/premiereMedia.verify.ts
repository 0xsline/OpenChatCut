// Runnable check: `npx tsx src/export/premiereMedia.verify.ts`.
// Frame rates are independent of embedded timecode labels and are kept per
// original/working file so a proxy rate never masquerades as the camera rate.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaProbeFromProbe } from '../../server/media-timecode.ts';
import { resolveExportMediaSources } from '../../server/export-media-sources.ts';
import { registerMediaReference } from '../../server/media-references.ts';
import { isExportMediaSourceMap, type ExportMediaSourceMap, type ExportMediaStart } from '../../shared/export-media-sources.ts';

// ── Probe reports the native video rate even without a usable timecode ──
{
  const rate = { numerator: 30_000, denominator: 1_001 };
  const noTimecode = mediaProbeFromProbe({
    streams: [{ codec_type: 'video', r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001' }],
  });
  assert.deepEqual(noTimecode, { start: null, rate }, 'untagged video still reports its native rate');

  const zeroTimecode = mediaProbeFromProbe({
    streams: [{ codec_type: 'video', r_frame_rate: '30000/1001', tags: { timecode: '00:00:00:00' } }],
  });
  assert.deepEqual(zeroTimecode, { start: null, rate }, 'a zero label is no start, while the native video rate remains available');

  const videoRateWithDifferentDataRate = mediaProbeFromProbe({
    streams: [
      { codec_type: 'video', r_frame_rate: '25/1', avg_frame_rate: '25/1' },
      { codec_type: 'data', r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001', tags: { timecode: '11:00:00:00' } },
    ],
  });
  assert.deepEqual(videoRateWithDifferentDataRate, {
    start: { value: 990_000, timescale: 25, timecode: '11:00:00:00', dropFrame: false },
    rate: { numerator: 25, denominator: 1 },
  }, 'a tmcd label uses the picture rate, not a distinct data-stream rate');

  const dataOnly = mediaProbeFromProbe({
    streams: [{ codec_type: 'data', r_frame_rate: '30000/1001', tags: { timecode: '01:00:00;00' } }],
  });
  assert.deepEqual(dataOnly, {
    start: { value: 107_999_892, timescale: 30_000, timecode: '01:00:00;00', dropFrame: true },
  }, 'a data-only timecode can be decoded but cannot invent a native video rate');
}

// ── Wire validation accepts positive integer rational rates only ──
{
  const valid = {
    '/media/uploads/camera.normalized.mp4': {
      path: 'C:\\cache\\camera.normalized.mp4',
      originalPath: 'D:\\camera\\camera.mov',
      pathRate: { numerator: 30_000, denominator: 1_001 },
      originalRate: { numerator: 25, denominator: 1 },
    },
  };
  assert.equal(isExportMediaSourceMap(valid), true, 'per-file rates are accepted on a media-source map');
  for (const invalidRate of [
    { numerator: 0, denominator: 1 },
    { numerator: 30, denominator: 0 },
    { numerator: -25, denominator: 1 },
    { numerator: 25, denominator: -1 },
    { numerator: 25.5, denominator: 1 },
    { numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1 },
    { numerator: '25', denominator: 1 },
  ]) {
    assert.equal(isExportMediaSourceMap({ '/media/uploads/camera.mov': { pathRate: invalidRate } }), false,
      `invalid rational source rate is rejected: ${JSON.stringify(invalidRate)}`);
  }
}

// ── Original and proxy probes never share a rate by fallback ──
{
  const root = await mkdtemp(join(tmpdir(), 'occ-premiere-media-'));
  try {
    const uploads = join(root, 'uploads');
    const originals = join(root, 'camera');
    await Promise.all([mkdir(uploads, { recursive: true }), mkdir(originals, { recursive: true })]);
    const original = join(originals, 'camera.mov');
    const proxy = join(uploads, 'camera.normalized.mp4');
    await Promise.all([writeFile(original, 'original'), writeFile(proxy, 'proxy')]);
    await registerMediaReference(uploads, 'camera.mov', original);

    const proxyStart: ExportMediaStart = {
      value: 108_000,
      timescale: 30,
      timecode: '01:00:00:00',
      dropFrame: false,
    };
    const source = '/media/uploads/camera.normalized.mp4';
    const noOriginalVideoRate = await resolveExportMediaSources([source], async (path) => (
      path === original
        ? { start: null }
        : { start: proxyStart, rate: { numerator: 30, denominator: 1 } }
    ), [uploads]);
    assert.deepEqual(noOriginalVideoRate[source], {
      path: proxy,
      originalPath: original,
      pathStart: proxyStart,
      pathRate: { numerator: 30, denominator: 1 },
    }, 'a valid original probe without video has no rate, even though its proxy does');

    const unreadableOriginal: ExportMediaSourceMap = await resolveExportMediaSources([source], async (path) => {
      if (path === original) throw new Error('camera original unreadable');
      return { start: proxyStart, rate: { numerator: 30, denominator: 1 } };
    }, [uploads]);
    assert.equal(unreadableOriginal[source]?.originalRate, undefined, 'proxy rate is not copied into originalRate');
    assert.deepEqual(unreadableOriginal[source], {
      path: proxy,
      originalPath: original,
      pathStart: proxyStart,
      originalStart: proxyStart,
      pathRate: { numerator: 30, denominator: 1 },
    }, 'an unreadable original may borrow the proxy clock start but never its video rate');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log('premiereMedia.verify: ok (probe clocks/rates/map validation/no proxy-rate fallback)');
