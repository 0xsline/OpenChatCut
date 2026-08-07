import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { EDITOR_CREDENTIAL_HEADER, editorBootstrapPayload } from '../editor-auth.ts';
import { DEFAULT_UPLOAD_MAX_BYTES } from '../r2.ts';
import { seedKeystore } from '../keystore.ts';
import { maxUploadBytes } from './upload-routes.ts';
import { uploadMultipartPlugin } from './upload-multipart.ts';
import {
  createNormalizeAdmission,
  normalizeMediaPlugin,
  parseFrameRate,
  playableDurationSeconds,
  resolveNormalizeOutputPath,
  resolveNormalizeTargetKey,
  resolveStreamPlan,
  type NormalizeEncodeContext,
} from './normalize-media.ts';

assert.equal(parseFrameRate('30/1'), 30);
assert.ok(Math.abs((parseFrameRate('30000/1001') ?? 0) - 29.97002997) < 0.000001);
assert.equal(parseFrameRate('0/0'), undefined);
assert.equal(parseFrameRate('N/A'), undefined);

assert.deepEqual(
  resolveStreamPlan({ videoCodec: 'h264', audioCodec: 'pcm_s16le', hasAudio: true }, false, false),
  { transcodeVideo: false, transcodeAudio: true },
  'an incompatible audio stream must not force compatible H.264 video through an encoder',
);
assert.deepEqual(
  resolveStreamPlan({ videoCodec: 'hevc', audioCodec: 'pcm_s24le', hasAudio: true }, false, false),
  { transcodeVideo: false, transcodeAudio: true },
  'an incompatible audio stream must not force compatible HEVC video through an encoder',
);
assert.deepEqual(
  resolveStreamPlan({ videoCodec: 'h264', audioCodec: 'aac', hasAudio: true }, true, false),
  { transcodeVideo: true, transcodeAudio: true },
  'explicit optimization retains full video/audio transcoding',
);
assert.equal(playableDurationSeconds({ duration: 3.934, frameCount: 116, avgFrameRate: 30 }), 116 / 30);
assert.equal(playableDurationSeconds({ duration: 3.934 }), 3.934);
const movOutputPath = resolveNormalizeOutputPath('/alias/master.mov');
const webmOutputPath = resolveNormalizeOutputPath('/alias/master.webm');
assert.equal(movOutputPath, webmOutputPath, 'extension variants publish to the same .mp4 target');
assert.equal(
  resolveNormalizeOutputPath('/alias/master.MP4'),
  join('/alias', 'master.mp4'),
  'the published target always uses the normalized .mp4 extension',
);

const missingTargetRealpath = async (path: string): Promise<string> => {
  if (path.startsWith('/alias/')) {
    throw Object.assign(new Error(`missing: ${path}`), { code: 'ENOENT' });
  }
  assert.equal(path, '/alias');
  return '/Volumes/Me\u0301dia';
};
assert.equal(
  await resolveNormalizeTargetKey(movOutputPath, 'linux', missingTargetRealpath),
  await resolveNormalizeTargetKey(webmOutputPath, 'linux', missingTargetRealpath),
  'extension variants acquire the same published-target key',
);
const darwinNfcKey = await resolveNormalizeTargetKey('/alias/Caf\u00e9.mp4', 'darwin', missingTargetRealpath);
const darwinNfdKey = await resolveNormalizeTargetKey('/alias/CAFE\u0301.MP4', 'darwin', missingTargetRealpath);
assert.equal(darwinNfcKey, darwinNfdKey, 'Darwin target aliases converge across case and NFC/NFD spelling');
const windowsNfcKey = await resolveNormalizeTargetKey('/alias/Caf\u00e9.mp4', 'win32', missingTargetRealpath);
const windowsNfdKey = await resolveNormalizeTargetKey('/alias/CAFE\u0301.MP4', 'win32', missingTargetRealpath);
assert.equal(windowsNfcKey, windowsNfdKey, 'Windows target aliases converge across case and NFC/NFD spelling');
const linuxUpperKey = await resolveNormalizeTargetKey('/alias/Clip.mp4', 'linux', missingTargetRealpath);
const linuxLowerKey = await resolveNormalizeTargetKey('/alias/clip.mp4', 'linux', missingTargetRealpath);
assert.notEqual(linuxUpperKey, linuxLowerKey, 'Linux preserves case-distinct target identities');
const linuxNfcKey = await resolveNormalizeTargetKey('/alias/Caf\u00e9.mp4', 'linux', missingTargetRealpath);
const linuxNfdKey = await resolveNormalizeTargetKey('/alias/Cafe\u0301.mp4', 'linux', missingTargetRealpath);
assert.notEqual(linuxNfcKey, linuxNfdKey, 'Linux preserves normalization-distinct target identities');

let existingTargetRealpathCalls = 0;
const existingTargetKey = await resolveNormalizeTargetKey('/alias/Clip.mp4', 'darwin', async (path) => {
  existingTargetRealpathCalls += 1;
  assert.equal(path, '/alias/Clip.mp4');
  return '/Actual/Caf\u00e9.mp4';
});
assert.equal(existingTargetKey, '/actual/caf\u00e9.mp4');
assert.equal(existingTargetRealpathCalls, 1, 'an existing target uses its own realpath without resolving its parent');


for (const [name, binary] of [['ffmpeg', ffmpegBin()], ['ffprobe', ffprobeBin()]]) {
  const result = spawnSync(binary, ['-version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${name} binary is not executable: ${result.error?.message ?? result.stderr}`);
}

interface VideoFixtureProbe {
  duration: number;
  frameCount: number;
  avgFrameRate: number;
  nominalFrameRate: number;
}

function probeVideoFixture(path: string): VideoFixtureProbe {
  const result = spawnSync(ffprobeBin(), [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,duration,avg_frame_rate,r_frame_rate,nb_frames',
    '-of', 'json',
    path,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `failed to probe ${basename(path)}: ${result.stderr}`);
  const payload: unknown = JSON.parse(result.stdout || '{}');
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${basename(path)} returned an invalid ffprobe payload`);
  }
  const streams = 'streams' in payload && Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find(
    (stream): stream is Record<string, unknown> => (
      Boolean(stream)
      && typeof stream === 'object'
      && 'codec_type' in stream
      && stream.codec_type === 'video'
    ),
  );
  if (!video) throw new Error(`${basename(path)} has no video stream`);
  const formatDuration = 'format' in payload
    && payload.format
    && typeof payload.format === 'object'
    && 'duration' in payload.format
    ? payload.format.duration
    : undefined;
  const duration = Number(formatDuration ?? video.duration);
  const frameCount = Number(video.nb_frames);
  const avgFrameRate = parseFrameRate(video.avg_frame_rate);
  const nominalFrameRate = parseFrameRate(video.r_frame_rate);
  if (!(duration > 0) || !(frameCount > 0) || !avgFrameRate || !nominalFrameRate) {
    throw new Error(`${basename(path)} has incomplete timing metadata`);
  }
  return { duration, frameCount, avgFrameRate, nominalFrameRate };
}

async function postNormalize(origin: string, src: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${origin}/api/normalize-media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: `/media/uploads/${src}`, ...body }),
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 10);
    await delay.promise;
  }
}

const previousMediaDir = process.env.MEDIA_DIR;
const previousUploadMax = process.env.UPLOAD_MAX_BYTES;
const previousMultipartMax = process.env.UPLOAD_MULTIPART_MAX_BYTES;
const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const testDir = await mkdtemp(join(tmpdir(), 'openchatcut-ingest-policy-'));
let server: ViteDevServer | undefined;
let releaseEncoderGate: (() => void) | undefined;
try {
  process.env.MEDIA_DIR = testDir;
  seedKeystore({ MEDIA_DIR: testDir });
  delete process.env.UPLOAD_MAX_BYTES;
  delete process.env.UPLOAD_MULTIPART_MAX_BYTES;
  assert.equal(maxUploadBytes(), DEFAULT_UPLOAD_MAX_BYTES, 'default upload policy is bounded at 20 GiB');
  process.env.UPLOAD_MAX_BYTES = '1024';
  assert.equal(maxUploadBytes(), 1024, 'an explicit positive upload limit remains authoritative');
  delete process.env.UPLOAD_MAX_BYTES;

  const sourcePath = join(testDir, 'compatible-large-frame.mp4');
  const generated = spawnSync(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=2048x1152:r=30',
    '-t', '0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
    '-movflags', '+faststart', sourcePath,
  ], { encoding: 'utf8' });
  assert.equal(generated.status, 0, `failed to generate ingest fixture: ${generated.stderr}`);

  const audioOnlySourcePath = join(testDir, 'compatible-video-pcm-audio.mov');
  const generatedAudioOnly = spawnSync(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=60000/1001',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
    '-t', '0.25', '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le',
    audioOnlySourcePath,
  ], { encoding: 'utf8' });
  assert.equal(generatedAudioOnly.status, 0, `failed to generate audio-only conversion fixture: ${generatedAudioOnly.stderr}`);
  const sourceVideoHashResult = spawnSync(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', audioOnlySourcePath,
    '-map', '0:v:0', '-c:v', 'copy',
    '-f', 'hash', '-hash', 'sha256', '-',
  ], { encoding: 'utf8' });
  assert.equal(sourceVideoHashResult.status, 0, `failed to hash source video stream: ${sourceVideoHashResult.stderr}`);
  const sourceVideoHash = sourceVideoHashResult.stdout.trim();

  const vfrSourcePath = join(testDir, 'unequal-pts.mp4');
  const generatedVfr = spawnSync(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15:duration=1.2',
    '-vf', 'setpts=(floor(N/2)*3+mod(N\\,2))/(15*TB)',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-fps_mode', 'vfr', '-an', '-movflags', '+faststart',
    vfrSourcePath,
  ], { encoding: 'utf8' });
  assert.equal(generatedVfr.status, 0, `failed to generate unequal-PTS VFR fixture: ${generatedVfr.stderr}`);
  const sourceVfrProbe = probeVideoFixture(vfrSourcePath);
  assert.ok(
    Math.abs(sourceVfrProbe.avgFrameRate - sourceVfrProbe.nominalFrameRate) > 0.5,
    'fixture must expose genuinely unequal cadence through ffprobe',
  );

  const concurrentNames = [
    'shared.mov',
    'other-0.mov',
    'shared.mkv',
    'other-1.mov',
    'other-2.mov',
    'other-3.mov',
    'other-4.mov',
    'other-5.mov',
    'other-6.mov',
    'other-7.mov',
  ];
  await Promise.all(
    [...concurrentNames, 'overflow.mov', 'recovery.mov'].map(
      (name) => copyFile(vfrSourcePath, join(testDir, name)),
    ),
  );

  const routeAdmission = createNormalizeAdmission();
  const observedAdmissionKeys: string[] = [];
  const admission = {
    acquire(key: string) {
      observedAdmissionKeys.push(key);
      return routeAdmission.acquire(key);
    },
    snapshot() {
      return routeAdmission.snapshot();
    },
  };
  let encoderGate: Promise<void> | undefined;
  let failOutputPath: string | undefined;
  let activeEncodes = 0;
  let maxActiveEncodes = 0;
  let overlappingOutput = false;
  const activeOutputs = new Set<string>();
  const observedTempPaths: string[] = [];
  const encoderHook = async (
    context: NormalizeEncodeContext,
    encode: () => Promise<void>,
  ): Promise<void> => {
    observedTempPaths.push(context.tempPath);
    activeEncodes += 1;
    maxActiveEncodes = Math.max(maxActiveEncodes, activeEncodes);
    if (activeOutputs.has(context.outputPath)) overlappingOutput = true;
    activeOutputs.add(context.outputPath);
    try {
      if (context.outputPath === failOutputPath) {
        failOutputPath = undefined;
        await writeFile(context.tempPath, 'partial encode');
        throw new Error('injected encoder failure');
      }
      await encoderGate;
      await encode();
    } finally {
      activeOutputs.delete(context.outputPath);
      activeEncodes -= 1;
    }
  };


  server = await createServer({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      uploadMultipartPlugin(),
      normalizeMediaPlugin({ admission, encoderHook }),
    ],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('ingest policy verification server has no TCP address');
  const origin = `http://127.0.0.1:${address.port}`;

  const vfrResponse = await postNormalize(origin, 'unequal-pts.mp4', { targetFps: 24 });
  const vfrText = await vfrResponse.text();
  assert.equal(vfrResponse.status, 200, vfrText);
  const vfr: unknown = JSON.parse(vfrText);
  if (
    !vfr
    || typeof vfr !== 'object'
    || !('normalized' in vfr)
    || !('fps' in vfr) || typeof vfr.fps !== 'number'
    || !('variableFrameRate' in vfr)
    || !('durationSeconds' in vfr) || typeof vfr.durationSeconds !== 'number'
    || !('videoFrameCount' in vfr) || typeof vfr.videoFrameCount !== 'number'
    || !('reason' in vfr) || typeof vfr.reason !== 'string'
  ) {
    throw new Error(`normalize VFR route returned an invalid payload: ${vfrText}`);
  }
  assert.equal(vfr.normalized, true, 'detected VFR must traverse the route encoder');
  assert.match(vfr.reason, /variable frame rate detected/);
  assert.equal(vfr.variableFrameRate, false, 'the route must publish CFR output for detected VFR');
  const outputVfrProbe = probeVideoFixture(vfrSourcePath);
  assert.ok(
    Math.abs(outputVfrProbe.duration - sourceVfrProbe.duration) <= Math.max(0.2, sourceVfrProbe.duration * 0.15),
    'VFR normalization preserves playable duration',
  );
  assert.ok(
    Math.abs(outputVfrProbe.frameCount - sourceVfrProbe.frameCount) <= 2,
    'VFR normalization preserves the source frame-count scale',
  );
  assert.ok(
    Math.abs(outputVfrProbe.avgFrameRate - sourceVfrProbe.avgFrameRate) < 1,
    'automatic CFR follows source cadence rather than project fps',
  );
  assert.ok(outputVfrProbe.avgFrameRate < 15, 'automatic CFR must not snap the fixture to 24/30 fps');
  assert.ok(Math.abs(vfr.fps - outputVfrProbe.avgFrameRate) < 0.1);
  assert.equal(vfr.videoFrameCount, outputVfrProbe.frameCount);
  assert.ok(Math.abs(vfr.durationSeconds - outputVfrProbe.duration) < 0.1);


  const editorCredential = editorBootstrapPayload().credential;
  const multipartResponse = await fetch(`${origin}/upload/multipart/init`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [EDITOR_CREDENTIAL_HEADER]: editorCredential,
      origin,
    },
    body: JSON.stringify({
      name: '20GiB-boundary.mov',
      size: DEFAULT_UPLOAD_MAX_BYTES,
      partSize: 64 * 1024 ** 2,
    }),
  });
  const multipartText = await multipartResponse.text();
  assert.equal(multipartResponse.status, 200, multipartText);
  const multipart = JSON.parse(multipartText) as { uploadId: string; maxBytes: number };
  assert.equal(multipart.maxBytes, DEFAULT_UPLOAD_MAX_BYTES);
  const abortResponse = await fetch(`${origin}/upload/multipart?uploadId=${multipart.uploadId}`, {
    method: 'DELETE',
    headers: { [EDITOR_CREDENTIAL_HEADER]: editorCredential, origin },
  });
  assert.equal(abortResponse.status, 200, await abortResponse.text());

  const acceptedResponse = await fetch(`${origin}/api/normalize-media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '/media/uploads/compatible-large-frame.mp4' }),
  });
  const acceptedText = await acceptedResponse.text();
  assert.equal(acceptedResponse.status, 200, acceptedText);
  const accepted = JSON.parse(acceptedText) as {
    normalized: boolean;
    path: string;
    width: number;
    height: number;
  };
  assert.equal(accepted.normalized, false, 'compatible sources are not optimized merely for exceeding 1920px');
  assert.equal(accepted.path, '/media/uploads/compatible-large-frame.mp4');
  assert.deepEqual([accepted.width, accepted.height], [2048, 1152]);

  const audioOnlyResponse = await fetch(`${origin}/api/normalize-media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '/media/uploads/compatible-video-pcm-audio.mov', targetFps: 24 }),
  });
  const audioOnlyText = await audioOnlyResponse.text();
  assert.equal(audioOnlyResponse.status, 200, audioOnlyText);
  const audioOnly = JSON.parse(audioOnlyText) as { normalized: boolean; path: string; fps: number };
  assert.equal(audioOnly.normalized, true);
  assert.equal(audioOnly.path, '/media/uploads/compatible-video-pcm-audio.mp4');
  assert.ok(audioOnly.fps > 59 && audioOnly.fps <= 60, 'default import preserves the source 59.94/60 cadence');
  const audioOnlyOutputPath = join(testDir, 'compatible-video-pcm-audio.mp4');
  const outputVideoHashResult = spawnSync(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', audioOnlyOutputPath,
    '-map', '0:v:0', '-c:v', 'copy',
    '-f', 'hash', '-hash', 'sha256', '-',
  ], { encoding: 'utf8' });
  assert.equal(outputVideoHashResult.status, 0, `failed to hash normalized video stream: ${outputVideoHashResult.stderr}`);
  assert.equal(
    outputVideoHashResult.stdout.trim(),
    sourceVideoHash,
    'audio compatibility conversion must stream-copy the original video bitstream',
  );
  const outputProbeResult = spawnSync(ffprobeBin(), [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'json',
    audioOnlyOutputPath,
  ], { encoding: 'utf8' });
  assert.equal(outputProbeResult.status, 0, `failed to probe normalized streams: ${outputProbeResult.stderr}`);
  const outputProbePayload: unknown = JSON.parse(outputProbeResult.stdout);
  assert.ok(outputProbePayload && typeof outputProbePayload === 'object' && 'streams' in outputProbePayload);
  const outputStreams = Array.isArray(outputProbePayload.streams)
    ? outputProbePayload.streams.filter(
      (stream): stream is { codec_type?: string; codec_name?: string } => Boolean(stream) && typeof stream === 'object',
    )
    : [];
  assert.equal(outputStreams.find((stream) => stream.codec_type === 'video')?.codec_name, 'h264');
  assert.equal(outputStreams.find((stream) => stream.codec_type === 'audio')?.codec_name, 'aac');

  await copyFile(sourcePath, join(testDir, 'explicitly-optimized.mp4'));
  const optimizedResponse = await fetch(`${origin}/api/normalize-media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      src: '/media/uploads/explicitly-optimized.mp4',
      targetFps: 30,
      optimize: true,
    }),
  });
  const optimizedText = await optimizedResponse.text();
  assert.equal(optimizedResponse.status, 200, optimizedText);
  const optimized = JSON.parse(optimizedText) as {
    normalized: boolean;
    width: number;
    height: number;
  };
  assert.equal(optimized.normalized, true, 'optimize:true retains the prior explicit optimization path');
  assert.equal(Math.max(optimized.width, optimized.height), 1920);

  observedTempPaths.length = 0;
  observedAdmissionKeys.length = 0;
  maxActiveEncodes = 0;
  overlappingOutput = false;
  const gate = Promise.withResolvers<void>();
  encoderGate = gate.promise;
  releaseEncoderGate = gate.resolve;
  const activeRequests = concurrentNames.slice(0, 2).map((name) => (
    postNormalize(origin, name, { optimize: true })
  ));
  await waitFor(
    () => activeEncodes === 2,
    'two normalize requests did not enter the production encoder wrapper',
  );
  const queuedRequests = concurrentNames.slice(2).map((name) => (
    postNormalize(origin, name, { optimize: true })
  ));
  await waitFor(
    () => admission.snapshot().queued === 8,
    'normalize requests did not fill the production queue',
  );
  assert.deepEqual(admission.snapshot(), { active: 2, queued: 8 });
  const overflowResponse = await postNormalize(origin, 'overflow.mov', { optimize: true });
  const overflowText = await overflowResponse.text();
  assert.equal(overflowResponse.status, 429, overflowText);
  const overflowPayload: unknown = JSON.parse(overflowText);
  assert.ok(overflowPayload && typeof overflowPayload === 'object' && 'code' in overflowPayload);
  assert.equal(overflowPayload.code, 'NORMALIZE_QUEUE_FULL');
  gate.resolve();
  releaseEncoderGate = undefined;
  encoderGate = undefined;
  const admittedResponses = await Promise.all([...activeRequests, ...queuedRequests]);
  for (const response of admittedResponses) {
    const text = await response.text();
    assert.equal(response.status, 200, text);
  }
  await waitFor(
    () => admission.snapshot().active === 0 && admission.snapshot().queued === 0,
    'successful route transactions did not release admission',
  );
  assert.equal(maxActiveEncodes, 2, 'the real route must never exceed two active encoders');
  assert.equal(overlappingOutput, false, 'requests publishing the same canonical stem must not overlap');
  assert.equal(observedTempPaths.length, concurrentNames.length);
  const sharedTargetKey = await resolveNormalizeTargetKey(join(testDir, 'shared.mp4'));
  assert.equal(
    observedAdmissionKeys.filter((key) => key === sharedTargetKey).length,
    2,
    'the registered route must acquire the canonical published-target key for both aliases',
  );
  assert.equal(
    new Set(observedTempPaths).size,
    observedTempPaths.length,
    'every admitted route transaction receives a unique temp output',
  );
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0 });

  observedTempPaths.length = 0;
  const recoveryOutputPath = join(testDir, 'recovery.mp4');
  failOutputPath = recoveryOutputPath;
  const failedResponse = await postNormalize(origin, 'recovery.mov', { optimize: true });
  const failedText = await failedResponse.text();
  assert.equal(failedResponse.status, 500, failedText);
  assert.match(failedText, /injected encoder failure/);
  await waitFor(
    () => admission.snapshot().active === 0,
    'failed route transaction did not release admission',
  );
  assert.equal(observedTempPaths.length, 1);
  const failedTempPath = observedTempPaths[0];
  if (!failedTempPath) throw new Error('failed route did not expose its temp output');
  await access(join(testDir, 'recovery.mov'));
  await assert.rejects(access(failedTempPath), { code: 'ENOENT' });
  await assert.rejects(access(recoveryOutputPath), { code: 'ENOENT' });
  assert.equal(
    (await readdir(testDir)).some((name) => name.startsWith('.recovery.norm-')),
    false,
    'failed normalization must leave no partial temp output',
  );

  const recoveredResponse = await postNormalize(origin, 'recovery.mov', { optimize: true });
  const recoveredText = await recoveredResponse.text();
  assert.equal(recoveredResponse.status, 200, recoveredText);
  await waitFor(
    () => admission.snapshot().active === 0,
    'recovered route transaction did not release admission',
  );
  assert.equal(observedTempPaths.length, 2);
  assert.notEqual(observedTempPaths[0], observedTempPaths[1]);
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0 });
  assert.equal(
    (await readdir(testDir)).some((name) => name.includes('.norm-') && name.endsWith('.tmp.mp4')),
    false,
    'successful recovery must also remove every transaction temp',
  );
} finally {
  releaseEncoderGate?.();
  await server?.close();
  await rm(testDir, { recursive: true, force: true });
  restoreEnv('MEDIA_DIR', previousMediaDir);
  restoreEnv('UPLOAD_MAX_BYTES', previousUploadMax);
  restoreEnv('UPLOAD_MULTIPART_MAX_BYTES', previousMultipartMax);
}

console.log('normalize-media verification passed');
