import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { ffprobeBin } from '../media-binaries.ts';
import { parseFrameRate } from './normalize-media.ts';

export interface VideoFixtureProbe {
  duration: number;
  frameCount: number;
  avgFrameRate: number;
  nominalFrameRate: number;
}

export function probeVideoFixture(path: string): VideoFixtureProbe {
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

export function postNormalize(origin: string, src: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${origin}/api/normalize-media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: `/media/uploads/${src}`, ...body }),
  });
}

export async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
