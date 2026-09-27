// Embedded start timecodes (issue #27): SMPTE labels → exact start times,
// ffprobe's output shapes, and real files written by the bundled ffmpeg,
// including the working copy OCC's normalizer makes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { transparentMovProxyArgs } from './local-media-import.ts';
import { ffmpegBin } from './media-binaries.ts';
import { normalizeMediaFile } from './media-normalization-runner.ts';
import { mediaStartFromProbe, parseFrameRate, probeMediaStart, timecodeStart } from './media-timecode.ts';

const run = promisify(execFile);
const rate = (num: number, den = 1) => ({ num, den });

// ── SMPTE label → frames × rate denominator over the rate numerator ──
{
  const cases: ReadonlyArray<readonly [string, { num: number; den: number }, number | null, boolean]> = [
    ['10:00:00:00', rate(25), 900_000, false],
    ['10:00:00:12', rate(25), 900_012, false],
    // 29.97 drop-frame: labels ;00 and ;01 are skipped every minute but each tenth.
    ['01:00:00;00', rate(30000, 1001), 107_892 * 1001, true],
    ['00:10:00;00', rate(30000, 1001), 17_982 * 1001, true],
    ['00:01:00;02', rate(30000, 1001), 1_800 * 1001, true],
    ['01:00:00:00', rate(30000, 1001), 108_000 * 1001, false],
    // 59.94 drop-frame skips four labels a minute.
    ['01:00:00;00', rate(60000, 1001), 215_784 * 1001, true],
    ['01:00:00:00', rate(24000, 1001), 86_400 * 1001, false],
    ['00:00:00:00', rate(25), null, false],
    ['10:00:00:25', rate(25), null, false],
    ['10:00:00;00', rate(25), null, true],
    ['1:2:3:4', rate(25), null, false],
    ['not a timecode', rate(25), null, false],
  ];
  for (const [label, frameRate, value, dropFrame] of cases) {
    const start = timecodeStart(label, frameRate);
    if (value === null) {
      assert.equal(start, null, `${label} @ ${frameRate.num}/${frameRate.den} has no usable start`);
      continue;
    }
    assert.deepEqual(start, { value, timescale: frameRate.num, timecode: label, dropFrame },
      `${label} @ ${frameRate.num}/${frameRate.den}`);
  }
  assert.equal(timecodeStart('10:00:00:00', null), null, 'no frame rate, no start');
  assert.deepEqual(parseFrameRate('30000/1001'), rate(30000, 1001));
  assert.deepEqual(parseFrameRate('12800/512'), rate(25), 'ffprobe rates are reduced');
  assert.deepEqual(parseFrameRate('25'), rate(25));
  assert.equal(parseFrameRate('0/0'), null);
  assert.equal(parseFrameRate(undefined), null);
}

// ── ffprobe shapes: MOV/MP4 video + tmcd, MXF format timecode, Broadcast WAV ──
{
  const video = { codec_type: 'video', r_frame_rate: '25/1', avg_frame_rate: '25/1' };
  assert.deepEqual(mediaStartFromProbe({
    streams: [{ ...video, tags: { timecode: '10:00:00:00' } }, { codec_type: 'data', tags: { timecode: '11:00:00:00' } }],
  }), { value: 900_000, timescale: 25, timecode: '10:00:00:00', dropFrame: false }, 'the video stream label wins');
  assert.deepEqual(mediaStartFromProbe({
    streams: [video, { codec_type: 'data', avg_frame_rate: '30000/1001', tags: { timecode: '10:00:00:00' } }],
  })?.timescale, 25, 'a tmcd label counts frames at the picture rate');
  assert.deepEqual(mediaStartFromProbe({
    streams: [{ codec_type: 'data', avg_frame_rate: '30000/1001', tags: { timecode: '01:00:00;00' } }],
  }), { value: 107_892 * 1001, timescale: 30000, timecode: '01:00:00;00', dropFrame: true },
  'without a picture stream the tmcd rate applies');
  assert.deepEqual(mediaStartFromProbe({ streams: [video], format: { tags: { timecode: '10:00:00:00' } } })?.value,
    900_000, 'MXF keeps its timecode on the format');
  assert.deepEqual(mediaStartFromProbe({ streams: [{ ...video, tags: { TIMECODE: '10:00:00:00' } }] })?.value,
    900_000, 'Matroska/WebM spells the stream tag TIMECODE');
  assert.deepEqual(mediaStartFromProbe({
    streams: [{ codec_type: 'audio', sample_rate: '48000' }],
    format: { tags: { time_reference: '1728000000' } },
  }), { value: 1_728_000_000, timescale: 48_000, dropFrame: false }, 'BWF time_reference counts samples');
  assert.equal(mediaStartFromProbe({ streams: [video, { codec_type: 'audio', sample_rate: '48000' }] }), null);
  assert.equal(mediaStartFromProbe({ streams: [{ codec_type: 'audio' }], format: { tags: { time_reference: '0' } } }), null);
}

// ── Real files from the bundled ffmpeg ──
const root = await mkdtemp(join(tmpdir(), 'openchatcut-media-timecode-'));
try {
  const picture = (fps: string) => ['-f', 'lavfi', '-i', `testsrc2=d=0.4:r=${fps}:s=64x36`];
  const tone = ['-f', 'lavfi', '-i', 'sine=d=0.4:sample_rate=48000'];
  const make = async (name: string, args: string[]) => {
    const file = join(root, name);
    await run(ffmpegBin(), ['-y', '-v', 'error', ...args, file]);
    return file;
  };
  const [pal, ntscDf, mxf, plain, bwf] = await Promise.all([
    make('tc25.mov', [...picture('25'), ...tone, '-c:v', 'mpeg4', '-c:a', 'aac', '-timecode', '10:00:00:00']),
    make('tc2997df.mov', [...picture('30000/1001'), '-c:v', 'mpeg4', '-timecode', '01:00:00;00']),
    make('tc25.mxf', [...picture('25'), '-c:v', 'mpeg2video', '-timecode', '10:00:00:00']),
    make('plain.mp4', [...picture('25'), ...tone, '-c:v', 'mpeg4', '-c:a', 'aac']),
    make('bwf.wav', [...tone, '-c:a', 'pcm_s24le', '-write_bext', '1', '-metadata', 'time_reference=1728000000']),
  ]);
  assert.deepEqual(await probeMediaStart(pal), { value: 900_000, timescale: 25, timecode: '10:00:00:00', dropFrame: false });
  assert.deepEqual(await probeMediaStart(ntscDf),
    { value: 107_999_892, timescale: 30_000, timecode: '01:00:00;00', dropFrame: true },
    '29.97 drop-frame 01:00:00;00 is frame 107892, 107999892/30000 s');
  assert.deepEqual(await probeMediaStart(mxf), { value: 900_000, timescale: 25, timecode: '10:00:00:00', dropFrame: false });
  assert.equal(await probeMediaStart(plain), null, 'untagged media has no start');
  assert.deepEqual(await probeMediaStart(bwf), { value: 1_728_000_000, timescale: 48_000, dropFrame: false });
  assert.equal(await probeMediaStart(join(root, 'never-written.png')), null, 'stills are not probed');
  const text = join(root, 'notes.mov');
  await writeFile(text, 'not media');
  await assert.rejects(probeMediaStart(text), 'an unreadable file is an error, not "no timecode"');

  // The working copy the timeline plays must stay on the camera's clock: the
  // exporter lets it stand in for an offline original and keeps it as proxy.
  for (const [source, expected] of [[pal, 900_000], [ntscDf, 107_999_892], [mxf, 900_000]] as const) {
    const output = join(root, `${source.split('/').pop()}.normalized.mp4`);
    const result = await normalizeMediaFile({
      inputPath: source, publicSrc: '/media/uploads/x.mov', outputPath: output,
      preserveInput: true, force: true, publishR2: false, uploadsDirectory: root,
    });
    assert.deepEqual([result.normalized, result.outputPath], [true, output], 'fixture really transcodes');
    assert.equal((await probeMediaStart(output))?.value, expected, `${source} keeps its start timecode when normalized`);
  }
  // The transparent-MOV proxy (<stem>.alpha.webm) is a WebM made by the import pipeline's own arguments.
  const alpha = join(root, 'tc25.alpha.webm');
  await run(ffmpegBin(), ['-v', 'error', ...transparentMovProxyArgs(pal, alpha)]);
  assert.deepEqual(await probeMediaStart(alpha), { value: 900_000, timescale: 25, timecode: '10:00:00:00', dropFrame: false },
    'the alpha WebM proxy keeps the camera timecode');
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('media-timecode.verify: SMPTE/drop-frame math, probe shapes, real files, normalized copies and alpha proxies passed\n');
