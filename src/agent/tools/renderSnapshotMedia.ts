import type { ProjectDoc, TimelineState } from '../../editor/types';
import { collectExportMediaPlan } from '../../export/exportMediaPlan';
import { materializeBlobMedia } from '../../export/materializeBlobMedia';
import { ensureMediaSrcs } from '../../persist/mediaBlobStore';

export interface BrowserRenderSnapshotInput {
  state: TimelineState;
  project?: ProjectDoc;
  timelineId?: string;
}

export interface BrowserRenderSnapshotOutput {
  state: TimelineState;
  project?: ProjectDoc;
  /** Remove temporary preview uploads after the render request completes. */
  cleanup(): Promise<void>;
}

export interface BrowserRenderSnapshotOptions {
  /** Injectable for the verification seam; defaults to the browser fetch. */
  fetcher?: typeof fetch;
  /** Restore cached /media/uploads sources before asking the server to render. */
  ensureLocalMedia?: (sources: readonly string[]) => Promise<unknown>;
}

async function cleanupUploadedSources(
  sources: readonly string[],
  fetcher: typeof fetch,
): Promise<void> {
  await Promise.all(sources.map(async (source) => {
    const name = source.slice('/media/uploads/'.length).split(/[?#]/, 1)[0] ?? '';
    if (!name || name.includes('/') || name.includes('\\')) return;
    await fetcher(`/upload?name=${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined);
  }));
}

function defaultFetcher(): typeof fetch {
  if (typeof globalThis.fetch !== 'function') throw new Error('当前环境不支持素材预览上传');
  return globalThis.fetch.bind(globalThis);
}

/**
 * Make a browser-owned render snapshot consumable by the server renderer.
 * Import placeholders intentionally use blob: URLs so the editor can play
 * before upload completes; the headless renderer cannot dereference those
 * URLs. Publish them through the normal upload route and rewrite only cloned
 * request snapshots, leaving the live editor state untouched.
 */
export async function prepareBrowserRenderSnapshots(
  input: BrowserRenderSnapshotInput,
  options: BrowserRenderSnapshotOptions = {},
): Promise<BrowserRenderSnapshotOutput> {
  const state = structuredClone(input.state);
  const project = input.project ? structuredClone(input.project) : undefined;
  const snapshot = project && input.timelineId
    ? { ...project, activeTimelineId: input.timelineId }
    : project ?? state;
  const plan = collectExportMediaPlan(snapshot);

  const localSources = [...new Set(
    plan.references
      .map((reference) => reference.source)
      .filter((source) => source.startsWith('/media/uploads/')),
  )];
  await (options.ensureLocalMedia ?? ((sources: readonly string[]) => ensureMediaSrcs([...sources])))(localSources)
    .catch(() => undefined);

  const blobReferences = plan.references.filter((reference) => reference.source.startsWith('blob:'));
  if (!blobReferences.length) return {
    state,
    ...(project ? { project } : {}),
    cleanup: async () => undefined,
  };

  const fetcher = options.fetcher ?? defaultFetcher();
  const uploadedSources: string[] = [];
  const requestSnapshot: { state: TimelineState; project?: ProjectDoc } = {
    state,
    ...(project ? { project } : {}),
  };
  try {
    const materialized = await materializeBlobMedia(requestSnapshot, {
      mediaPlanSnapshot: snapshot,
      fetcher,
      onPublished: (path) => {
        if (!uploadedSources.includes(path)) uploadedSources.push(path);
      },
    });
    let cleanupPromise: Promise<void> | undefined;
    return {
      state: materialized.state,
      ...(materialized.project ? { project: materialized.project } : {}),
      cleanup: () => cleanupPromise ??= cleanupUploadedSources(uploadedSources, fetcher),
    };
  } catch (error) {
    await cleanupUploadedSources(uploadedSources, fetcher);
    throw error;
  }
}
