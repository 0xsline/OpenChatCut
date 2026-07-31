// The absolute disk path of the asset directory (for FCPXML export heavy link). The physical location is determined by the server's MEDIA_DIR
// Decision, the browser can only ask the server; it will not change within a session, it will be cached once.
// Return undefined if it cannot be obtained - the export can still be done, but the asset in NLE is offline.
// Better than failing the entire export.

let cached: string | undefined;
let inflight: Promise<string | undefined> | undefined;

async function fetchMediaDir(): Promise<string | undefined> {
  try {
    const res = await fetch('/api/keys');
    if (!res.ok) return undefined;
    const body = (await res.json()) as { mediaDir?: unknown };
    return typeof body.mediaDir === 'string' && body.mediaDir ? body.mediaDir : undefined;
  } catch {
    return undefined; // Preview build and other scenarios without this endpoint
  }
}

/** The absolute path of the current asset directory; undefined when not available. */
export async function exportMediaDir(): Promise<string | undefined> {
  if (cached !== undefined) return cached;
  inflight ??= fetchMediaDir().then((dir) => {
    if (dir) cached = dir;
    inflight = undefined;
    return dir;
  });
  return inflight;
}

/** For testing: clear the in-process cache. */
export function resetExportMediaDirCache(): void {
  cached = undefined;
  inflight = undefined;
}
