// Disk locations of a timeline's /media/uploads sources for one FCPXML export.
// The server resolves in-place references (desktop folder, watched-folder and
// agent-path imports) that never carry a path in the project, plus the managed
// copies. The answer is used for this export only and is never stored.
import {
  EXPORT_MEDIA_SOURCES_ROUTE,
  isExportMediaSourceMap,
  MAX_EXPORT_MEDIA_SOURCES,
  type ExportMediaSourceMap,
} from '../../shared/export-media-sources';
import type { TimelineState } from '../editor/types';
import { exportMediaDir } from './mediaDir';

const UPLOAD_PREFIX = '/media/uploads/';
const REQUEST_TIMEOUT_MS = 15_000;

/** Server-resolved locations for the upload-backed sources; {} when the server cannot say. */
export async function exportMediaSources(
  sources: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<ExportMediaSourceMap> {
  const uploads = [...new Set(sources.filter((source) => source.startsWith(UPLOAD_PREFIX)))]
    .slice(0, MAX_EXPORT_MEDIA_SOURCES);
  if (uploads.length === 0) return {};
  try {
    const response = await fetcher(EXPORT_MEDIA_SOURCES_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources: uploads }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return {};
    const body = (await response.json()) as { sources?: unknown } | null;
    return isExportMediaSourceMap(body?.sources) ? body.sources : {};
  } catch {
    // Preview builds and older servers have no route: the export still goes
    // out, addressed through mediaDir as before.
    return {};
  }
}

/** The mediaDir fallback and the per-source locations timelineToFcpxml addresses media with. */
export async function fcpxmlMediaLocations(
  state: Pick<TimelineState, 'items'>,
  fetcher: typeof fetch = fetch,
): Promise<{ mediaDir?: string; mediaSources: ExportMediaSourceMap }> {
  const sources = state.items.flatMap((item) => (item.src ? [item.src] : []));
  const [mediaDir, mediaSources] = await Promise.all([exportMediaDir(), exportMediaSources(sources, fetcher)]);
  return { mediaDir, mediaSources };
}
