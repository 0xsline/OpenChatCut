import type { TimelineItem, TimelineState } from '../editor/types.js';
import type {
  PremiereBakeJob,
  PremiereBakedMedia,
  PremiereExportIssue,
  PremiereExportPlan,
} from './premiereTypes.js';
import { premiereBakeState } from './premiereBakePlan.js';

const RENDER_CLIP_ROUTE = '/render-clip';
const MANAGED_UPLOAD_SRC = /^\/media\/uploads\/[^/\\?#]+$/;

export interface PremiereBakeOptions {
  signal?: AbortSignal;
  /** Called immediately before each render; index is one-based. */
  onProgress?: (job: PremiereBakeJob, index: number, total: number) => void;
}

interface RenderClipBakeResponse {
  path?: unknown;
  error?: unknown;
}

interface MutableBakedMedia {
  visualSrc?: string;
  audioSrc?: string;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === 'AbortError');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function responseError(response: Response, signal?: AbortSignal): Promise<Error> {
  signal?.throwIfAborted();
  const body = await response.json().catch(() => null) as RenderClipBakeResponse | null;
  signal?.throwIfAborted();
  const message = typeof body?.error === 'string' && body.error.trim()
    ? body.error
    : `Premiere clip render failed (HTTP ${response.status}).`;
  return new Error(message);
}

async function renderBakeJob(
  state: TimelineState,
  item: TimelineItem,
  job: PremiereBakeJob,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const isolatedState = premiereBakeState(state, item, job.kind);
  const response = await fetch(RENDER_CLIP_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: isolatedState,
      codec: 'prores',
      transparent: true,
      mode: 'bake',
      filename: job.filename,
    }),
    signal,
  });
  signal?.throwIfAborted();
  if (!response.ok) throw await responseError(response, signal);

  const body = await response.json() as RenderClipBakeResponse;
  signal?.throwIfAborted();
  if (typeof body.path !== 'string' || !MANAGED_UPLOAD_SRC.test(body.path)) {
    throw new Error('Clip renderer did not return a managed media source path.');
  }
  return body.path;
}

function renderIssue(job: PremiereBakeJob, error: unknown): PremiereExportIssue {
  return {
    severity: 'error',
    code: 'premiere-clip-bake-failed',
    message: `${job.filename}: ${messageOf(error)}`,
    itemIds: [job.itemId],
  };
}

/**
 * Render planned isolated layers as managed ProRes 4444 files. The server
 * returns real /media/uploads paths, which the XML export resolves to disk
 * locations through its normal export-media-sources lookup.
 */
export async function renderPremiereBakeJobs(
  state: TimelineState,
  plan: PremiereExportPlan,
  options: PremiereBakeOptions = {},
): Promise<{ media: ReadonlyMap<string, PremiereBakedMedia>; issues: PremiereExportIssue[] }> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  if (plan.issues.some((issue) => issue.severity === 'error')) {
    return { media: new Map(), issues: [] };
  }

  const itemById = new Map(state.items.map((item) => [item.id, item] as const));
  const rendered = new Map<string, MutableBakedMedia>();
  const failedItemIds = new Set<string>();
  const issues: PremiereExportIssue[] = [];
  for (let index = 0; index < plan.bakeJobs.length; index++) {
    signal?.throwIfAborted();
    const job = plan.bakeJobs[index]!;
    const item = itemById.get(job.itemId);
    onProgress?.(job, index + 1, plan.bakeJobs.length);
    if (!item) {
      failedItemIds.add(job.itemId);
      issues.push(renderIssue(job, new Error('The timeline item no longer exists.')));
      continue;
    }

    try {
      const src = await renderBakeJob(state, item, job, signal);
      signal?.throwIfAborted();
      const value = rendered.get(job.itemId) ?? {};
      if (job.kind === 'visual') value.visualSrc = src;
      else value.audioSrc = src;
      rendered.set(job.itemId, value);
    } catch (error) {
      if (isAbort(error, signal)) {
        signal?.throwIfAborted();
        throw error;
      }
      failedItemIds.add(job.itemId);
      issues.push(renderIssue(job, error));
    }
  }
  signal?.throwIfAborted();

  const media = new Map<string, PremiereBakedMedia>();
  for (const [itemId, value] of rendered) {
    if (failedItemIds.has(itemId)) continue;
    media.set(itemId, value);
  }

  signal?.throwIfAborted();
  return { media, issues };
}
