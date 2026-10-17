// Remotion (4.0.x) encodes a render's AAC track with libfdk_aac into a raw ADTS
// stream (@remotion/renderer compress-audio.js) and then stream-copies it into
// the mp4/mov. FDK's AAC-LC encoder emits 2048 samples of priming ahead of the
// first real sample, and ADTS has nowhere to record that: the container gets
// its first audio packet at pts 0 with no edit list, so every player hears the
// whole track 2048 samples late (42.7 ms at 48 kHz). Decode and mix are
// sample-exact — a wav render of the same timeline is aligned — the ADTS encode
// alone adds the lag.
//
// Fix: remux losslessly with the audio shifted back by the encoder delay. The
// priming packets then carry negative timestamps, which the mp4/mov muxer
// records as an edit list (media_time = 2048), the same signalling ffmpeg's own
// AAC encoder writes for ordinary source media.
import { RenderInternals } from '@remotion/renderer';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** libfdk_aac AAC-LC encoder delay, in samples, at every sample rate. */
export const FDK_AAC_ENCODER_DELAY_SAMPLES = 2048;

/** Containers Remotion muxes its ADTS track into (renderMedia codecs). */
const CONTAINER_CODECS = new Set(['h264', 'h265', 'prores']);

/**
 * First audio stream's codec, sample rate and first packet pts, or null when
 * the file has no audio. A negative first pts means priming is already signalled.
 * @param {(bin: 'ffmpeg'|'ffprobe', args: string[]) => Promise<string>} run returns stdout
 */
export async function probeFirstAudioPacket(file, run) {
  const stdout = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate:packet=pts',
    '-read_intervals', '%+#1', '-of', 'json', file,
  ]);
  const probe = JSON.parse(stdout);
  const stream = probe.streams?.[0];
  if (!stream) return null;
  return {
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    firstPts: Number(probe.packets?.[0]?.pts ?? 0),
  };
}

/**
 * Restore the encoder delay a Remotion render dropped. No-op unless the file's
 * audio is AAC whose priming is unsignalled, so running it twice is safe.
 * @param {object} args
 * @param {string} args.file  mp4/mov produced by renderMedia; replaced in place
 * @param {(bin: 'ffmpeg'|'ffprobe', args: string[]) => Promise<string>} args.run
 * @returns {Promise<boolean>} whether the file was rewritten
 */
export async function compensateAacEncoderDelay({ file, run }) {
  const audio = await probeFirstAudioPacket(file, run);
  if (!audio || audio.codec !== 'aac' || audio.firstPts < 0 || !(audio.sampleRate > 0)) return false;
  const ext = path.extname(file);
  const temp = `${file}.aac-delay${ext}`;
  const shiftSeconds = FDK_AAC_ENCODER_DELAY_SAMPLES / audio.sampleRate;
  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', file,
      '-itsoffset', `-${shiftSeconds.toFixed(9)}`, '-i', file,
      '-map', '0', '-map', '-0:a', '-map', '1:a:0',
      '-c', 'copy', '-map_metadata', '0',
      '-movflags', '+faststart',
      '-f', ext.toLowerCase() === '.mov' ? 'mov' : 'mp4',
      temp,
    ]);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return true;
}

/**
 * Runner over Remotion's bundled ffmpeg/ffprobe — the binaries renderMedia
 * used, with the env/cwd Remotion sets for them. Resolves stdout.
 * @param {{binariesDirectory?: string|null, signal?: AbortSignal}} [args]
 */
export function remotionFfRunner({ binariesDirectory = null, signal } = {}) {
  return async (bin, args) => {
    signal?.throwIfAborted();
    const task = RenderInternals.callFf({ bin, args, indent: false, logLevel: 'error', binariesDirectory });
    const kill = () => task.kill();
    signal?.addEventListener('abort', kill, { once: true });
    try {
      return (await task).stdout;
    } finally {
      signal?.removeEventListener('abort', kill);
    }
  };
}

/** Whether renderMedia's options produce Remotion's own AAC track in a container. */
export function rendersRemotionAacTrack(options) {
  return Boolean(options.outputLocation)
    && CONTAINER_CODECS.has(options.codec)
    && !options.muted
    && (options.audioCodec == null || options.audioCodec === 'aac');
}
