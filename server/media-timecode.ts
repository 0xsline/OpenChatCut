// Embedded start timecode of a media file, read with the bundled ffprobe.
//
// NLEs conform an interchange file against the timecode a camera wrote into
// the media: DaVinci Resolve reports a clip "not found" when an FCPXML asset
// says it starts at 0 but the file starts at, say, 10:00:00:00. ffprobe exposes
// that start as tags.timecode on the video stream and on the QuickTime/MP4
// tmcd data stream, on the format for MXF, as TIMECODE on a Matroska/WebM
// stream (the alpha proxy), and as time_reference (samples since midnight) for
// Broadcast WAV.
import type { ExportMediaStart } from '../shared/export-media-sources.ts';
import { ffprobeBin } from './media-binaries.ts';
import { spawnMediaProcess } from './media-process.ts';

const PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_OUTPUT = 64 * 1024;
/** Stills never carry a start timecode; skip the process spawn. */
const STILL_IMAGE = /\.(?:png|jpe?g|webp|gif|svg|avif|heic|heif|bmp|tiff?)$/i;
/** hh:mm:ss:ff; a ';' or '.' before the frames marks drop-frame, as ffmpeg prints it. */
const TIMECODE_LABEL = /^(\d{1,2}):([0-5]\d):([0-5]\d)([:;.])(\d{2,3})$/;

interface Rate {
  readonly num: number;
  readonly den: number;
}

type ProbeTags = Readonly<Record<string, unknown>>;

interface ProbeStream {
  readonly codec_type?: unknown;
  readonly r_frame_rate?: unknown;
  readonly avg_frame_rate?: unknown;
  readonly sample_rate?: unknown;
  readonly tags?: ProbeTags;
}

interface ProbeOutput {
  readonly format?: { readonly tags?: ProbeTags };
  readonly streams?: readonly ProbeStream[];
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/** "30000/1001" → {30000, 1001}, reduced ("12800/512" → 25/1); null for 0/0 or junk. */
export function parseFrameRate(value: unknown): Rate | null {
  const match = typeof value === 'string' ? /^(\d+)(?:\/(\d+))?$/.exec(value.trim()) : null;
  if (!match) return null;
  const num = Number(match[1]);
  const den = Number(match[2] ?? 1);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) return null;
  const divisor = greatestCommonDivisor(num, den);
  return { num: num / divisor, den: den / divisor };
}

/**
 * A SMPTE label at its frame rate → exact start. Drop-frame (29.97/59.94) skips
 * frame numbers 0-1 (0-3 at 59.94) of every minute except each tenth, so
 * 01:00:00;00 is frame 107892, i.e. 107892 × 1001/30000 s. Zero starts return
 * null: an asset starting at 0 is what the exporter writes already.
 */
export function timecodeStart(label: string, rate: Rate | null): ExportMediaStart | null {
  const match = TIMECODE_LABEL.exec(label.trim());
  if (!match || !rate) return null;
  const [hours, minutes, seconds, frame] = [match[1], match[2], match[3], match[5]].map(Number) as [number, number, number, number];
  const nominal = Math.round(rate.num / rate.den);
  if (nominal <= 0 || frame >= nominal) return null;
  const dropFrame = match[4] !== ':';
  let frames = ((hours * 60 + minutes) * 60 + seconds) * nominal + frame;
  if (dropFrame) {
    if (nominal % 30 !== 0) return null;
    const totalMinutes = hours * 60 + minutes;
    frames -= (nominal / 15) * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  if (frames <= 0) return null;
  return { value: frames * rate.den, timescale: rate.num, timecode: label.trim(), dropFrame };
}

/** The `timecode` tag: lowercase from MOV/MP4/MXF, `TIMECODE` from Matroska/WebM. */
function timecodeLabel(tags: ProbeTags | undefined): string | null {
  const label = Object.entries(tags ?? {}).find(([key]) => key.toLowerCase() === 'timecode')?.[1];
  return typeof label === 'string' && label.trim() ? label : null;
}

/** The start ffprobe reported: video stream, then tmcd/data stream, then format timecode, then BWF. */
export function mediaStartFromProbe(probe: ProbeOutput): ExportMediaStart | null {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const videoRate = parseFrameRate(video?.r_frame_rate) ?? parseFrameRate(video?.avg_frame_rate);
  const labels: Array<{ label: string | null; rate: Rate | null }> = [
    { label: timecodeLabel(video?.tags), rate: videoRate },
    ...streams.filter((stream) => stream.codec_type === 'data').map((stream) => ({
      label: timecodeLabel(stream.tags),
      rate: videoRate ?? parseFrameRate(stream.avg_frame_rate) ?? parseFrameRate(stream.r_frame_rate),
    })),
    { label: timecodeLabel(probe.format?.tags), rate: videoRate },
  ];
  for (const { label, rate } of labels) {
    const start = label ? timecodeStart(label, rate) : null;
    if (start) return start;
  }
  const reference = probe.format?.tags?.time_reference;
  const sampleRate = Number(streams.find((stream) => stream.codec_type === 'audio')?.sample_rate);
  const samples = typeof reference === 'string' && /^\d+$/.test(reference) ? Number(reference) : 0;
  return Number.isSafeInteger(samples) && samples > 0 && Number.isSafeInteger(sampleRate) && sampleRate > 0
    ? { value: samples, timescale: sampleRate, dropFrame: false }
    : null;
}

function runProbe(path: string): Promise<string> {
  const deferred = Promise.withResolvers<string>();
  const child = spawnMediaProcess(ffprobeBin(), [
    '-v', 'error', '-print_format', 'json',
    '-show_entries',
    'format_tags=timecode,time_reference:stream=codec_type,r_frame_rate,avg_frame_rate,sample_rate:stream_tags=timecode',
    path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_PROBE_OUTPUT) chunks.push(chunk);
  });
  child.stderr.resume();
  child.once('error', (error) => {
    clearTimeout(timer);
    deferred.reject(error);
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) deferred.reject(new Error(`ffprobe exited ${code ?? 'on a signal'}`));
    else if (size > MAX_PROBE_OUTPUT) deferred.reject(new Error('ffprobe output too large'));
    else deferred.resolve(Buffer.concat(chunks).toString('utf8'));
  });
  return deferred.promise;
}

/** Embedded start of one media file: null when it carries none; rejects when ffprobe cannot read it. */
export async function probeMediaStart(path: string): Promise<ExportMediaStart | null> {
  if (STILL_IMAGE.test(path)) return null;
  return mediaStartFromProbe(JSON.parse(await runProbe(path)) as ProbeOutput);
}
