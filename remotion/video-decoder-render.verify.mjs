// End-to-end check of the server render's two video decoders (issue #162).
// Windows renders video through <OffthreadVideo> (the FFmpeg compositor)
// because its WebCodecs path can wedge on D3D11 hardware decoders; macOS and
// Linux keep @remotion/media. Whichever decoder a platform uses, an export must
// show the source frame the Player shows, keep WebM alpha and carry the clip's
// audio. ProRes proves the switch is live on every server entry point:
// @remotion/media cannot decode it at all, so only the compositor renders it.
// node remotion/video-decoder-render.verify.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { renderClip, renderTimeline, renderTimelineStills, setUploadsDirProvider } from './render.mjs';
import { disposeServeBundle, getServeUrl } from './serve-bundle.mjs';
import { resolveServerVideoDecoder } from './video-decoder.mjs';

const run = promisify(execFile);
const WIDTH = 160;
const HEIGHT = 90;
const FPS = 30;
const FRAME_BYTES = WIDTH * HEIGHT * 3;
const SOFTWARE_H264 = { id: 'libx264', label: 'Software (libx264)', hardware: false, transport: 'server' };
// A run exercises the WebCodecs path only where it ships: on Windows that is
// the path that wedges, so a Windows run covers the compositor alone.
const DECODERS = resolveServerVideoDecoder({ override: '' }) === 'offthread'
  ? ['offthread']
  : ['webcodecs', 'offthread'];
// Same gate as src/gl/clipFxExport.verify.mjs: Linux CI's software GL shifts
// frame delivery, so exact index mapping is asserted on macOS and Windows.
const exactMapping = !(process.platform === 'linux' && !!process.env.CI);
// The two decoders convert colour slightly differently, so a rendered frame is
// identified by being much closer to one source frame than to any other.
const IDENTIFIED_RATIO = 0.6;
const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];

if (!ffmpegPath) throw new Error('ffmpeg-static binary unavailable');

const ffmpeg = (args) => run(ffmpegPath, ['-v', 'error', '-y', ...args]);

async function rgbFrames(path, scaleFilter = []) {
  const { stdout } = await run(ffmpegPath, [
    '-v', 'error', '-i', path, ...scaleFilter, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(stdout.length % FRAME_BYTES, 0, `${path} decoded to a partial frame`);
  return Array.from({ length: stdout.length / FRAME_BYTES },
    (_, index) => stdout.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES));
}

function meanSquaredError(left, right) {
  let total = 0;
  let samples = 0;
  for (let index = 0; index < left.length; index += 5) {
    const delta = left[index] - right[index];
    total += delta * delta;
    samples += 1;
  }
  return total / samples;
}

/** Index of the source frame a rendered frame shows, asserting it shows one. */
function sourceIndexOf(frame, sources, context) {
  const ranked = sources
    .map((source, index) => ({ index, distance: meanSquaredError(frame, source) }))
    .sort((left, right) => left.distance - right.distance);
  const [best, runnerUp] = ranked;
  assert.ok(
    best.distance < runnerUp.distance * IDENTIFIED_RATIO,
    `${context} shows no single source frame (MSE ${best.distance.toFixed(1)} vs ${runnerUp.distance.toFixed(1)})`,
  );
  return best.index;
}

async function audioRms(path) {
  const { stdout } = await run(ffmpegPath, [
    '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  let sum = 0;
  for (const sample of samples) sum += (sample / 32768) ** 2;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

function timelineState(id, items, trackOrder = ['V1']) {
  return {
    id, fps: FPS, width: WIDTH, height: HEIGHT, fit: 'contain', items,
    tracks: Object.fromEntries(trackOrder.map((track) => [track, { kind: 'video' }])),
    trackOrder, selectedId: null, selectedIds: [], assets: [],
  };
}

function videoItem(name, durationInFrames, {
  srcInFrame = 0, playbackRate = 1, track = 'V1', startFrame = 0, effects,
} = {}) {
  return {
    id: `${track}-${name}-${startFrame}`, name, kind: 'video', src: `/media/uploads/${name}`, track,
    startFrame, durationInFrames, srcInFrame, playbackRate, width: WIDTH, height: HEIGHT,
    ...(effects ? { effects } : {}),
  };
}

async function withDecoder(decoder, render) {
  const previous = process.env.CC_RENDER_VIDEO_DECODER;
  process.env.CC_RENDER_VIDEO_DECODER = decoder;
  try {
    return await render();
  } finally {
    if (previous === undefined) delete process.env.CC_RENDER_VIDEO_DECODER;
    else process.env.CC_RENDER_VIDEO_DECODER = previous;
  }
}

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-video-decoder-'));
const media = (name) => join(directory, name);
try {
  setUploadsDirProvider(() => directory);
  process.env.OPENCHATCUT_RENDER_CONCURRENCY = '4';
  process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING = '1';

  // 29.97 fps footage with audio in a 30 fps timeline: the fractional-rate case
  // where a decoder that selects frames differently is off by one source frame.
  await ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=30000/1001`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3.2',
    '-frames:v', '90', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...BT709, '-c:a', 'aac', media('camera.mp4'),
  ]);
  const cameraFrames = await rgbFrames(media('camera.mp4'));
  const outputFrames = 36;
  for (const { label, srcInFrame, playbackRate } of [
    { label: 'normal', srcInFrame: 0, playbackRate: 1 },
    { label: 'trimmed-2x', srcInFrame: 5, playbackRate: 2 },
  ]) {
    // The Player (@remotion/media) shows the last source frame whose timestamp
    // is at most 1 ms after the requested time. In 1/30000 s units a source
    // frame lasts 1001, a timeline frame 1000 and the tolerance 30.
    const expected = Array.from({ length: outputFrames },
      (_, frame) => Math.floor(((srcInFrame + frame * playbackRate) * 1000 + 30) / 1001));
    const selections = new Map();
    for (const decoder of DECODERS) {
      const output = media(`camera-${label}-${decoder}.mp4`);
      await withDecoder(decoder, () => renderTimeline({
        state: timelineState(`decoder-${label}`, [videoItem('camera.mp4', outputFrames, { srcInFrame, playbackRate })]),
        outputLocation: output,
        codec: 'h264',
        h264Profile: SOFTWARE_H264,
      }));
      const shown = (await rgbFrames(output)).slice(0, outputFrames)
        .map((frame, index) => sourceIndexOf(frame, cameraFrames, `${decoder} ${label} frame ${index}`));
      if (exactMapping) {
        assert.deepEqual(shown, expected, `${decoder} ${label} must show the source frames the Player shows`);
      }
      selections.set(decoder, shown);
      if (label === 'normal') {
        const rms = await audioRms(output);
        assert.ok(rms > 0.05, `${decoder} export lost the clip's own audio (RMS ${rms.toFixed(3)})`);
      }
    }
    console.log(`video-decoder-render.verify: ${DECODERS.join(' + ')} ${label} 29.97→30 fps frames ${
      exactMapping ? 'match the Player frame for frame' : 'render (exact mapping skipped on Linux CI)'}`);
  }

  // WebM alpha: the overlay's transparent area must show the red track below.
  await ffmpeg([
    '-f', 'lavfi', '-i', `color=c=black@0.0:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=1,format=rgba,`
      + 'drawbox=x=50:y=25:w=60:h=40:color=white@1.0:t=fill:replace=1',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-metadata:s:v:0', 'alpha_mode=1',
    '-auto-alt-ref', '0', media('overlay.webm'),
  ]);
  const solid = {
    id: 'V1-red', name: 'red', kind: 'solid', track: 'V1', startFrame: 0, durationInFrames: 10,
    props: { color: '#ff0000' },
  };
  for (const decoder of DECODERS) {
    const output = media(`alpha-${decoder}.mp4`);
    await withDecoder(decoder, () => renderTimeline({
      state: timelineState('decoder-alpha', [solid, videoItem('overlay.webm', 10, { track: 'V2' })], ['V2', 'V1']),
      outputLocation: output,
      codec: 'h264',
      h264Profile: SOFTWARE_H264,
    }));
    const [frame] = await rgbFrames(output);
    const pixel = (x, y) => [...frame.subarray((y * WIDTH + x) * 3, (y * WIDTH + x) * 3 + 3)];
    const [r, g, b] = pixel(8, 8);
    assert.ok(r > 180 && g < 80 && b < 80, `${decoder} lost WebM alpha: corner pixel is ${[r, g, b]}`);
    assert.ok(pixel(80, 45).every((channel) => channel > 200), `${decoder} dropped the opaque overlay`);
  }
  console.log(`video-decoder-render.verify: ${DECODERS.join(' + ')} keep WebM alpha over lower tracks`);

  // ProRes: @remotion/media cannot decode it at all (it cancels the render), so
  // a ProRes source renders only when the compositor feeds every layer — plain
  // clips and GL effect inputs alike — on every server entry point.
  await ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}`,
    '-frames:v', '30', '-c:v', 'prores_ks', '-profile:v', '0', ...BT709, media('master.mov'),
  ]);
  const masterFrames = await rgbFrames(media('master.mov'));
  const plainState = timelineState('decoder-prores', [videoItem('master.mov', 12)]);
  const effectState = timelineState('decoder-prores-effect', [
    videoItem('master.mov', 6),
    videoItem('master.mov', 6, {
      startFrame: 6, srcInFrame: 6, effects: [{ id: 'invert', assetId: 'builtin:fx-invert' }],
    }),
  ]);
  const checkMaster = (frames, count, context) => {
    assert.ok(frames.length >= count, `${context} rendered ${frames.length} frames`);
    frames.slice(0, count).forEach((frame, index) => {
      const shown = sourceIndexOf(frame, masterFrames, `${context} frame ${index}`);
      if (exactMapping) assert.equal(shown, index, `${context} frame ${index} showed source frame ${shown}`);
    });
  };
  await withDecoder('offthread', async () => {
    await renderTimeline({
      state: effectState, outputLocation: media('prores-timeline.mp4'), codec: 'h264', h264Profile: SOFTWARE_H264,
    });
    // Frames 6-11 carry the GL effect; that they render at all proves its input
    // came from the compositor. clipFxExport.verify.mjs owns their content.
    const exported = await rgbFrames(media('prores-timeline.mp4'));
    assert.ok(exported.length >= 12, `offthread export rendered ${exported.length} frames`);
    checkMaster(exported, 6, 'offthread export');
    await renderClip({
      state: plainState, outputLocation: media('prores-clip.mp4'), codec: 'h264', transparent: false,
      h264Profile: SOFTWARE_H264,
    });
    checkMaster(await rgbFrames(media('prores-clip.mp4')), 12, 'offthread clip render');
    const [still] = await renderTimelineStills({ state: plainState, frames: [7] });
    await writeFile(media('still.jpg'), Buffer.from(still.base64, 'base64'));
    const [stillFrame] = await rgbFrames(media('still.jpg'), ['-vf', `scale=${WIDTH}:${HEIGHT}`]);
    const shown = sourceIndexOf(stillFrame, masterFrames, 'offthread still');
    if (exactMapping) assert.equal(shown, 7, `offthread still showed source frame ${shown}`);
  });
  if (DECODERS.includes('webcodecs')) {
    await assert.rejects(
      withDecoder('webcodecs', () => renderTimeline({
        state: plainState, outputLocation: media('prores-webcodecs.mp4'), codec: 'h264', h264Profile: SOFTWARE_H264,
      })),
      /ProRes/,
      'WebCodecs must not decode ProRes, or the offthread checks above prove nothing',
    );
  }
  console.log('video-decoder-render.verify: the decoder choice reaches exports, GL effect inputs, clip renders and stills');

  // The serve bundle's media/uploads links (a junction on Windows) to the
  // uploads directory, which here holds the fixtures: disposing the bundle
  // must delete it without following that link.
  const serveUrl = await getServeUrl();
  const uploads = (await readdir(directory)).sort();
  await disposeServeBundle();
  assert.equal(existsSync(serveUrl), false, 'disposeServeBundle deletes the webpacked serve bundle');
  assert.deepEqual((await readdir(directory)).sort(), uploads, 'disposing the serve bundle leaves the linked uploads intact');
  console.log('video-decoder-render.verify: the serve bundle is disposed without touching the linked uploads');
} finally {
  await rm(directory, { recursive: true, force: true });
  // The serve bundle this run webpacked (~150 MB in the OS temp dir).
  await disposeServeBundle();
}
