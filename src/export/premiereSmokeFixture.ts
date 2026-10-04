// Generate a local synthetic XMEML handoff for a manual Premiere import check.
// Run with `npx tsx src/export/premiereSmokeFixture.ts`; outputs stay under
// node_modules so media/XML with local paths are never committed accidentally.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TimelineItem, TimelineState } from '../editor/types';
import type { ExportMediaSourceMap } from '../../shared/export-media-sources';
import { ffmpegBin } from '../../server/media-binaries';
import { timelineToPremiereXml } from './premiereXml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = join(ROOT, 'node_modules', '.cache', 'openchatcut', 'premiere smoke fixture');

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-4000)}`));
    });
  });
}

function videoItem(
  id: string,
  track: string,
  src: string,
  startFrame: number,
  durationInFrames: number,
  srcInFrame: number,
  extra: Partial<TimelineItem> = {},
): TimelineItem {
  return {
    id, track, kind: 'video', src, startFrame, durationInFrames, srcInFrame,
    name: id, ...extra,
  };
}

function audioItem(
  id: string,
  track: string,
  src: string,
  startFrame: number,
  durationInFrames: number,
  srcInFrame: number,
): TimelineItem {
  return { id, track, kind: 'audio', src, startFrame, durationInFrames, srcInFrame, name: id };
}

/** Create source media and a project whose XML can be opened by a human. */
export async function generatePremiereSmokeFixture(): Promise<string> {
  await mkdir(OUTPUT, { recursive: true });
  const cameraA = join(OUTPUT, 'camera A & closeup.mov');
  const cameraB = join(OUTPUT, 'camera B #wide.mov');
  const music = join(OUTPUT, 'music bed.wav');
  const voice = join(OUTPUT, 'voice.wav');
  const bakedTitle = join(OUTPUT, 'baked title alpha.mov');
  const xmlPath = join(OUTPUT, 'OpenChatCut Premiere smoke.xml');
  const readmePath = join(OUTPUT, 'README.md');

  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'prores_ks', '-profile:v', '2',
    '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', '-timecode', '01:00:00:00', cameraA,
  ]);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=8',
    '-map', '0:v:0', '-map', '1:a:0', '-vf', 'hue=h=100', '-c:v', 'prores_ks', '-profile:v', '2',
    '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', '-timecode', '10:00:00:00', cameraB,
  ]);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=8',
    '-c:a', 'pcm_s16le', music,
  ]);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=8',
    '-c:a', 'pcm_s16le', voice,
  ]);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=black@0.0:s=640x360:r=30:d=3,format=rgba,drawbox=x=20:y=20:w=600:h=320:color=yellow@0.25:t=fill,drawbox=x=80:y=80:w=480:h=200:color=magenta@0.8:t=fill',
    '-an', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', bakedTitle,
  ]);

  const source = (path: string, timecode: string, frameCount: number) => ({
    path,
    originalPath: path,
    pathRate: { numerator: 30, denominator: 1 },
    originalRate: { numerator: 30, denominator: 1 },
    pathStart: { value: frameCount, timescale: 30, timecode, dropFrame: false },
    originalStart: { value: frameCount, timescale: 30, timecode, dropFrame: false },
  });
  const srcA = '/media/uploads/premiere-smoke-camera-a.mov';
  const srcB = '/media/uploads/premiere-smoke-camera-b.mov';
  const srcMusic = '/media/uploads/premiere-smoke-music.wav';
  const srcVoice = '/media/uploads/premiere-smoke-voice.wav';
  const items: TimelineItem[] = [
    videoItem('camera-a-speed-trim', 'V1', srcA, 0, 90, 30, { playbackRate: 1.5, volume: 0.65 }),
    videoItem('camera-b-trim', 'V2', srcB, 45, 105, 60, { playbackRate: 1 }),
    {
      id: 'motion-graphic-title', track: 'V3', kind: 'motion-graphic', src: undefined,
      startFrame: 75, durationInFrames: 90, name: 'Baked alpha title', code: 'return null;',
    },
    audioItem('music-bed-trim', 'A1', srcMusic, 0, 210, 45),
    audioItem('voice-trim', 'A2', srcVoice, 90, 120, 30),
  ];
  const timeline: TimelineState = {
    fps: 30,
    width: 640,
    height: 360,
    selectedId: null,
    items,
    trackOrder: ['V3', 'V2', 'V1', 'A1', 'A2'],
    tracks: {
      V3: { kind: 'video' }, V2: { kind: 'video' }, V1: { kind: 'video' },
      A1: { kind: 'audio' }, A2: { kind: 'audio' },
    },
  };
  const mediaSources = {
    [srcA]: source(cameraA, '01:00:00:00', 108_000),
    [srcB]: source(cameraB, '10:00:00:00', 1_080_000),
    [srcMusic]: { path: music, originalPath: music },
    [srcVoice]: { path: voice, originalPath: voice },
  } as unknown as ExportMediaSourceMap;
  const xml = timelineToPremiereXml(timeline, {
    title: 'OpenChatCut Premiere smoke fixture',
    mediaDir: OUTPUT,
    mediaSources,
    bakedMedia: { 'motion-graphic-title': { visualSrc: bakedTitle } },
  });
  await writeFile(xmlPath, xml, 'utf8');
  await writeFile(readmePath, [
    '# Premiere XML smoke fixture',
    '',
    'Generated locally by `npx tsx src/export/premiereSmokeFixture.ts`.',
    'This fixture uses synthetic media, absolute local file URLs, two camera lanes plus an upper baked title lane, two standalone audio lanes, source trims, linked camera audio, distinct source timecode origins, a 1.5x clip, and a rendered alpha title layer.',
    '',
    '## Manual import checklist',
    '',
    '1. In Adobe Premiere Pro, use **File → Import** and select `OpenChatCut Premiere smoke.xml`.',
    '2. Confirm the sequence opens at 640×360, 30 fps, and about eight seconds long.',
    '3. Confirm V1/V2 and A1/A2 are separate tracks, with camera audio companions and the baked title on the upper picture lane.',
    '4. Confirm camera A begins at source 01:00:00:00 + 1 second and camera B begins at source 10:00:00:00 + 2 seconds; the sequence placements should remain at 00:00:00:00 and 00:00:01:15 respectively.',
    '5. Inspect the first camera clip for its 1.5x retime and the trimmed music/voice clips for nonzero source in-points.',
    '6. Check that the yellow/magenta title layer is transparent outside its colored shapes.',
    '7. Record the Premiere Pro version, whether the import succeeded, any relink prompt, warnings, missing effects, and which checks passed.',
    '',
    'Premiere import has not been run by this generator. XML parsing and unit verification do not establish host-import compatibility.',
    '',
    '## Local files',
    '',
    `- XML: ${pathToFileURL(xmlPath).href}`,
    `- Camera A: ${pathToFileURL(cameraA).href}`,
    `- Camera B: ${pathToFileURL(cameraB).href}`,
    `- Music: ${pathToFileURL(music).href}`,
    `- Voice: ${pathToFileURL(voice).href}`,
    `- Baked title: ${pathToFileURL(bakedTitle).href}`,
    '',
  ].join('\n'), 'utf8');
  return OUTPUT;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generatePremiereSmokeFixture().then((directory) => {
    process.stdout.write(`Premiere smoke fixture written to ${directory}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`Premiere smoke fixture generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
