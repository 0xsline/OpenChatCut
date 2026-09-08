import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

const require = createRequire(import.meta.url);
const ffmpegStatic = require('ffmpeg-static') as string | null;
const ffprobeInstaller = require('@ffprobe-installer/ffprobe') as { path?: string };

const ASAR_SEGMENT = `${sep}app.asar${sep}`;
const UNPACKED_SEGMENT = `${sep}app.asar.unpacked${sep}`;

/**
 * The on-disk twin of a path inside the packaged app archive.
 *
 * Electron's fs shim reads files inside app.asar transparently, but nothing can be
 * executed or dlopen'ed from there: spawn needs a real file. electron-builder keeps the
 * modules listed in asarUnpack as real files under app.asar.unpacked with the same
 * layout, so a resolved path is rewritten to that twin when it exists. Dev builds and
 * paths outside the archive come back unchanged.
 */
export function unpackedPath(path: string): string {
  const index = path.indexOf(ASAR_SEGMENT);
  if (index < 0) return path;
  const twin = `${path.slice(0, index)}${UNPACKED_SEGMENT}${path.slice(index + ASAR_SEGMENT.length)}`;
  return existsSync(twin) ? twin : path;
}

/**
 * Prefer explicit overrides for developers who need a custom FFmpeg build.
 * Packaged desktop builds fall back to the platform binaries shipped through
 * production dependencies, so media import does not depend on the user's PATH.
 */
export function ffmpegBin(): string {
  return process.env.OPENCHATCUT_FFMPEG
    ?? process.env.FFMPEG_PATH
    ?? (ffmpegStatic ? unpackedPath(ffmpegStatic) : null)
    ?? 'ffmpeg';
}

export function ffprobeBin(): string {
  return process.env.OPENCHATCUT_FFPROBE
    ?? process.env.FFPROBE_PATH
    ?? (ffprobeInstaller.path ? unpackedPath(ffprobeInstaller.path) : null)
    ?? 'ffprobe';
}

/**
 * whisper.cpp CLI used by the desktop native-ASR worker (Metal/CPU). Dev and
 * packaged builds resolve from public/whisper-cli/<platform>/ (provisioned by
 * scripts/sync-whisper-cli.mjs and shipped through extraResources); an
 * explicit override wins for locally compiled binaries.
 */
export function whisperCliBin(): string {
  const override = process.env.OPENCHATCUT_WHISPER_CLI;
  if (override) return override;
  const platformKey = `${process.platform}-${process.arch}`;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const relative = join('whisper-cli', platformKey, `whisper-cli${suffix}`);
  const candidates = [
    join(import.meta.dirname, '..', 'public', relative),
    join(process.resourcesPath ?? '', 'dist', relative),
    join(process.resourcesPath ?? '', relative),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return join(candidates[0]!);
}
