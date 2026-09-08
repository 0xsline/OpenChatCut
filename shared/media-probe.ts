// ffprobe JSON → the compact media summary the agent and the import routes work with.
// Pure and total (never throws on malformed input) so it can run in the browser tool,
// in the server import route, and in offline verifies alike.

export interface ProbeResult {
  durationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudioTrack: boolean;
  hasVideoTrack: boolean;
  videoCodec?: string;
  audioCodec?: string;
  /** Explicit planning risks derived from probed metadata; empty means none detected by these checks. */
  qualityRisks: string[];
}

/** Parse an ffprobe rational frame rate such as "30/1" or "30000/1001". */
function parseFrameRate(...candidates: unknown[]): number | undefined {
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw.includes('/')) continue;
    const [num, den] = raw.split('/').map(Number);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) continue;
    return Math.round((num / den) * 100) / 100;
  }
  return undefined;
}

/** Normalize an `ffprobe -print_format json -show_streams -show_format` object.
 *  Pure + total (never throws on malformed input) so it's unit-testable offline. */
export function parseProbe(json: unknown): ProbeResult {
  const data = (json ?? {}) as { streams?: unknown[]; format?: { duration?: unknown } };
  const streams = Array.isArray(data.streams) ? (data.streams as Record<string, unknown>[]) : [];
  const audio = streams.find((s) => s?.codec_type === 'audio');
  const video = streams.find((s) => s?.codec_type === 'video');
  const durRaw = data.format?.duration ?? video?.duration ?? audio?.duration;
  const duration = Number(durRaw);
  const width = typeof video?.width === 'number' ? video.width : undefined;
  const height = typeof video?.height === 'number' ? video.height : undefined;
  const averageFps = parseFrameRate(video?.avg_frame_rate);
  const nominalFps = parseFrameRate(video?.r_frame_rate);
  const fps = averageFps ?? nominalFps;
  const qualityRisks: string[] = [];
  if (width !== undefined && height !== undefined && (width < 720 || height < 480)) {
    qualityRisks.push(`low_resolution: ${width}x${height}; enlargement may look soft`);
  }
  if (audio && audio.channels === 1) {
    qualityRisks.push('mono_audio: stereo delivery may need deliberate channel treatment');
  }
  if (Number.isFinite(duration) && duration > 0 && duration < 3) {
    qualityRisks.push('very_short: source is under 3 seconds');
  }
  if (averageFps && nominalFps && Math.abs(averageFps - nominalFps) > 0.01) {
    qualityRisks.push(`variable_frame_rate: nominal ${nominalFps}fps differs from average ${averageFps}fps`);
  }
  if (fps && fps < 20) {
    qualityRisks.push(`low_frame_rate: ${fps}fps may look uneven in motion`);
  }
  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    width,
    height,
    fps,
    hasAudioTrack: audio !== undefined,
    hasVideoTrack: video !== undefined,
    videoCodec: typeof video?.codec_name === 'string' ? video.codec_name : undefined,
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : undefined,
    qualityRisks,
  };
}
