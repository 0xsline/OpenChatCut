import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ffmpegStatic = require('ffmpeg-static') as string | null;
const ffprobeInstaller = require('@ffprobe-installer/ffprobe') as { path?: string };

/**
 * Prefer explicit overrides for developers who need a custom FFmpeg build.
 * Packaged desktop builds fall back to the platform binaries shipped through
 * production dependencies, so media import does not depend on the user's PATH.
 */
export function ffmpegBin(): string {
  return process.env.OPENCHATCUT_FFMPEG
    ?? process.env.FFMPEG_PATH
    ?? ffmpegStatic
    ?? 'ffmpeg';
}

export function ffprobeBin(): string {
  return process.env.OPENCHATCUT_FFPROBE
    ?? process.env.FFPROBE_PATH
    ?? ffprobeInstaller.path
    ?? 'ffprobe';
}
