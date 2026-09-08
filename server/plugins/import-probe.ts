// Probe a file the import route just wrote, with the ffprobe that ships with the app.
//
// download_media used to register whatever bytes came back — an HTML error page saved
// as .mp4, a truncated file — and the agent only found out later ("服务器拦截，拿到的是
// 坏文件"). Probing at import time turns that into an immediate not_media failure, and
// a readable file comes back with the measurements the agent would otherwise spend a
// second tool call (probe_media) and, for a URL, a second download to obtain.
import { extname } from 'node:path';
import { parseProbe, type ProbeResult } from '../../shared/media-probe.ts';
import { probeMediaFile } from './probe-media.ts';

/** Extensions ffprobe is expected to read; a failure on one of these means the bytes are not that media. */
const FFPROBE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.3gp', '.ts', '.mts', '.m2ts', '.mpg', '.mpeg',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.aif', '.aiff', '.wma',
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff',
]);

export type ImportProbe =
  | { readonly probe: ProbeResult | null }
  | { readonly error: string };

/** Whether an ffprobe failure on this file name is proof that the bytes are not media. */
export function ffprobeExpected(fileName: string): boolean {
  return FFPROBE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

/**
 * Null probe for a file ffprobe is not the judge of (an SVG, a LUT, an unknown .bin —
 * ffprobe "reads" an SVG as a 0×0 video, which would only mislead); an error when the
 * extension promised media and the bytes are not.
 */
export async function probeImportedFile(path: string, fileName: string = path): Promise<ImportProbe> {
  if (!ffprobeExpected(fileName)) return { probe: null };
  try {
    return { probe: parseProbe(await probeMediaFile(path)) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `downloaded file is not readable ${extname(fileName).slice(1)}: ${detail}` };
  }
}
