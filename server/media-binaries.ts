import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

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

/** FS and platform seams: the Windows branch is verifiable on any host. */
export interface BinaryResolutionOptions {
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
  readonly isFile?: (path: string) => boolean;
}

function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `/opt/ffmpeg/bin`, `C:\ffmpeg\bin` and `./tools/ffmpeg` are paths; `ffmpeg` is a PATH lookup. */
function looksLikePath(value: string): boolean {
  return isAbsolute(value) || /[\\/]/.test(value);
}

/**
 * Validate a binary override, resolving the directory convention to the executable.
 *
 * FFMPEG_PATH / FFPROBE_PATH are conventions shared with other tools and commonly hold
 * a *directory* (`C:\ffmpeg\bin`). Returning it as an executable made Windows startup
 * copy a directory as ffmpeg.exe and die with `EPERM ... copyfile` (issue #262). So:
 * a file is accepted, a directory resolves to the platform binary inside it, and
 * anything else is rejected with a message naming the variable and what to set instead.
 * A bare command name (`ffmpeg`) is a PATH lookup, not a path: returned untouched and
 * never stat'ed. Returns null when the variable is unset or blank.
 */
export function resolveBinaryOverride(
  value: string | undefined,
  variable: string,
  appVariable: string,
  name: string,
  options: BinaryResolutionOptions = {},
): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  if (!looksLikePath(candidate)) return candidate;
  const executable = (options.platform ?? process.platform) === 'win32' ? `${name}.exe` : name;
  const isFile = options.isFile ?? statIsFile;
  const pathExists = options.exists ?? existsSync;
  const guidance = variable === appVariable
    ? `Set ${appVariable} to the ${executable} executable itself, or unset it to use the bundled build.`
    : `Set ${appVariable} to the ${executable} executable itself to override OpenChatCut alone, or unset ${variable}.`;
  if (isFile(candidate)) return candidate;
  if (pathExists(candidate)) {
    const nested = join(candidate, executable);
    if (isFile(nested)) return nested;
    throw new Error(
      `${variable} points at a directory that contains no ${name} executable: ${candidate}\n`
      + `${guidance} For example ${nested}.`,
    );
  }
  throw new Error(`${variable} does not point at an executable file: ${candidate}\n${guidance}`);
}

const notedGenericOverrides = new Set<string>();

/** One line per process: FFMPEG_PATH still works, but the app-specific variable is clearer. */
function noteGenericOverride(variable: string, appVariable: string, resolved: string): void {
  if (notedGenericOverrides.has(variable)) return;
  notedGenericOverrides.add(variable);
  console.warn(`[media-binaries] honoring ${variable}=${resolved}; set ${appVariable} to override OpenChatCut only.`);
}

/**
 * Prefer explicit overrides for developers who need a custom FFmpeg build.
 * Packaged desktop builds fall back to the platform binaries shipped through
 * production dependencies, so media import does not depend on the user's PATH.
 * OPENCHATCUT_FFMPEG is the app-specific override; FFMPEG_PATH is still honored
 * for compatibility, after the same validation (see resolveBinaryOverride).
 */
export function ffmpegBin(options: BinaryResolutionOptions = {}): string {
  const appOverride = resolveBinaryOverride(
    process.env.OPENCHATCUT_FFMPEG, 'OPENCHATCUT_FFMPEG', 'OPENCHATCUT_FFMPEG', 'ffmpeg', options,
  );
  if (appOverride) return appOverride;
  const genericOverride = resolveBinaryOverride(
    process.env.FFMPEG_PATH, 'FFMPEG_PATH', 'OPENCHATCUT_FFMPEG', 'ffmpeg', options,
  );
  if (genericOverride) {
    noteGenericOverride('FFMPEG_PATH', 'OPENCHATCUT_FFMPEG', genericOverride);
    return genericOverride;
  }
  return (ffmpegStatic ? unpackedPath(ffmpegStatic) : null) ?? 'ffmpeg';
}

export function ffprobeBin(options: BinaryResolutionOptions = {}): string {
  const appOverride = resolveBinaryOverride(
    process.env.OPENCHATCUT_FFPROBE, 'OPENCHATCUT_FFPROBE', 'OPENCHATCUT_FFPROBE', 'ffprobe', options,
  );
  if (appOverride) return appOverride;
  const genericOverride = resolveBinaryOverride(
    process.env.FFPROBE_PATH, 'FFPROBE_PATH', 'OPENCHATCUT_FFPROBE', 'ffprobe', options,
  );
  if (genericOverride) {
    noteGenericOverride('FFPROBE_PATH', 'OPENCHATCUT_FFPROBE', genericOverride);
    return genericOverride;
  }
  return (ffprobeInstaller.path ? unpackedPath(ffprobeInstaller.path) : null) ?? 'ffprobe';
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
