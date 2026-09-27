// Where an FCPXML asset's media lives and which clock it runs on: the
// `media-rep` URLs an NLE links, and the start timecode it conforms against.
import type { ExportMediaSource, ExportMediaStart } from '../../shared/export-media-sources';
import { sameMediaStart } from './fcpxmlTime';

/** Asset URL prefix: it is in mediaDir on the disk and has the same name. */
const UPLOAD_PREFIX = '/media/uploads/';

/**
 * Absolute disk path → `media-rep` `src` URL, UTF-8 percent-encoded per path
 * segment (drive-letter colons stay intact). FCPXML defines `src` as an
 * RFC 2396 URL and `media-rep` may only contain `bookmark`, so this attribute
 * is the one place an NLE reads the location. Final Cut Pro writes the same
 * form itself (NSURL: `%E4%B8%AD…`, `%20`), DaVinci Resolve's own FCPXML
 * export percent-encodes `src` too, and Resolve imports Final Cut's files.
 * Raw non-ASCII is not a URL; a raw `#` or `%` truncates or corrupts the path.
 */
function toFileUrl(absPath: string): string {
  const slashed = absPath.replace(/\\/g, '/');
  if (slashed.startsWith('//')) {
    const encoded = slashed.slice(2).split('/').map(encodeURIComponent).join('/');
    return `file://${encoded}`;
  }
  const rooted = /^[A-Za-z]:/.test(slashed) ? `/${slashed}` : slashed;
  const encoded = rooted
    .split('/')
    .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  return `file://${encoded}`;
}

/**
 * Fragment src → absolute disk path when the fragment names a local file.
 * /media/uploads/<name> resolves against mediaDir (MEDIA_DIR can change);
 * Windows/POSIX absolute sources pass through; remote/inline sources return
 * null so callers never fabricate a local address for them.
 */
export function resolveAssetAbsPath(src: string, mediaDir?: string): string | null {
  if (/^(?:https?|file|data|blob):/i.test(src)) return null;
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(src)) return src;
  if (mediaDir && src.startsWith(UPLOAD_PREFIX)) {
    const name = decodeURIComponent(src.slice(UPLOAD_PREFIX.length));
    return `${mediaDir.replace(/[/\\]+$/, '')}/${name}`;
  }
  return src.startsWith('/') ? src : null;
}

/**
 * Fragment src → NLE address that can be relinked. `/media/uploads/<name>` is the same origin URL, the physical location is
 * mediaDir is determined (MEDIA_DIR can be changed) and must be converted into an absolute path, otherwise every asset in NLE is
 * Offline. Remote/inline addresses are passed through as is (NLE can't turn them off, but lying about local paths is worse).
 */
export function resolveAssetSrc(src: string, mediaDir?: string): string {
  if (/^(?:https?|file|data|blob):/i.test(src)) return src;
  const abs = resolveAssetAbsPath(src, mediaDir);
  if (abs) return toFileUrl(abs);
  return `file://${src}`;
}

export interface AssetMedia {
  /** `original-media`: the camera file the NLE links and conforms against. */
  readonly originalHref: string;
  /** `proxy-media`: the working copy the editor plays, when it is another file on the same clock. */
  readonly proxyHref?: string;
  /** Embedded start of the original-media file: the asset's `start`, and the origin of every clip `start`. */
  readonly start?: ExportMediaStart;
}

/**
 * original-media is the camera file; proxy-media the working copy the editor
 * plays, when it is a different file. The server's export-time lookup wins:
 * an in-place reference (desktop folder/watched/agent import) has no file at
 * `<mediaDir>/<name>` and no originalFilePath in the project.
 *
 * An asset has one `start` for all of its representations, and it must be
 * the original's timecode: that is the file Resolve and Final Cut link, and
 * Resolve refuses to link a clip whose asset start disagrees with the file's
 * embedded timecode. A working copy on a different clock is left out rather
 * than exported with times that point at the wrong frames.
 */
export function planAssetMedia(
  src: string,
  originalFilePath: string | undefined,
  mediaDir: string | undefined,
  located: ExportMediaSource | undefined,
): AssetMedia {
  const internalHref = located?.path ? toFileUrl(located.path) : resolveAssetSrc(src, mediaDir);
  const serverOriginal = located?.originalPath;
  // Persisted projects are not type-checked; only a non-empty string is a path.
  const rendererOriginal = typeof originalFilePath === 'string' && originalFilePath ? originalFilePath : undefined;
  const originalAbs = serverOriginal || rendererOriginal;
  if (!originalAbs) return withStart({ originalHref: internalHref }, located?.pathStart);
  const originalHref = toFileUrl(originalAbs);
  // A drag/drop original named by the renderer is not probed; its managed copy
  // (byte copy or timecode-preserving transcode) carries the same start.
  const start = serverOriginal ? located?.originalStart : located?.pathStart;
  const proxied = originalHref !== internalHref && sameMediaStart(located?.pathStart, start);
  return withStart({ originalHref, ...(proxied ? { proxyHref: internalHref } : {}) }, start);
}

function withStart(media: AssetMedia, start: ExportMediaStart | undefined): AssetMedia {
  return start ? { ...media, start } : media;
}
