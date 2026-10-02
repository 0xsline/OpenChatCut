export { PUBLISH_TOOL_SCHEMAS, PUBLISH_TOOL_NAMES } from './schemas/publish-tools';

// Social publishing through the local server's /api/upload-post routes
// (server/plugins/upload-post.ts). The server holds the API key; the browser
// only sends the render path and the publish fields.
//
// publish_to_social is two-step by contract: without confirm the server only
// previews; confirm:true must carry the preview's requestId as previewId. A
// confirm is admitted at once and the upload runs in the background, so both
// calls finish well inside the agent's 30-second tool deadline.
// track_social_publish polls the state for the returned requestId.

type Args = Record<string, unknown>;

const DEFAULT_WAIT_SECONDS = 20; // stays below the browser Agent's 30-second tool deadline
const MAX_WAIT_SECONDS = 25;
const POLL_INTERVAL_MS = 3_000;
/** Bound for one publish_to_social request (a preview makes up to three provider reads, two of them in parallel). */
const PUBLISH_REQUEST_TIMEOUT_MS = 25_000;
/** States that will not change by polling again within one wait. */
const SETTLED = new Set(['completed', 'failed', 'unknown', 'not_found']);

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

async function publishToSocial(args: Args): Promise<unknown> {
  const confirm = args.confirm === true;
  const body: Record<string, unknown> = {
    source: args.source,
    platforms: args.platforms,
    title: args.title,
    description: args.description,
    youtubePrivacy: args.youtubePrivacy,
    tiktokPrivacy: args.tiktokPrivacy,
    pinterestBoardId: args.pinterestBoardId,
    aiGenerated: args.aiGenerated === true,
    confirm,
    ...(typeof args.previewId === 'string' ? { previewId: args.previewId } : {}),
  };
  let response: Response;
  try {
    response = await fetch('/api/upload-post/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PUBLISH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (confirm && typeof args.previewId === 'string') {
      return {
        error: `publish_to_social did not answer in time: ${error instanceof Error ? error.message : String(error)}`,
        requestId: args.previewId,
        next: 'The publish may have been admitted. Do not confirm again: check it with track_social_publish using this requestId.',
      };
    }
    return { error: `publish_to_social request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const data = await readJson(response);
  if (!response.ok) {
    return {
      error: String(data.error ?? `publish_to_social failed (${response.status})`),
      code: data.code,
      ...(data.code === 'preview_mismatch' || data.code === 'preview_required'
        ? { next: 'Call publish_to_social without confirm to get a fresh preview, show it, and confirm only after the user approves it.' }
        : {}),
    };
  }
  if (data.phase === 'preview') {
    return {
      ok: true,
      ...data,
      next: data.previouslySubmitted
        ? 'This exact publish was already sent. Do not ask to confirm it again: check it with track_social_publish.'
        : 'Show this preview to the user. Publishing is public and cannot be undone; after they approve, call again with '
          + 'confirm:true and previewId set to this requestId.',
    };
  }
  if (data.phase === 'unconfirmed_delivery') {
    return {
      ok: true,
      ...data,
      next: 'Upload-Post did not confirm whether the upload was accepted. It will NOT be re-sent, and confirming again only re-checks it. '
        + 'Poll track_social_publish with this requestId and tell the user the outcome is unknown until it shows up.',
    };
  }
  return {
    ok: true,
    ...data,
    next: data.phase === 'admitted'
      ? 'The upload is running in the background. Poll track_social_publish with requestId (action=wait), then report each platform result.'
      : 'Poll track_social_publish with requestId, then report each platform result.',
  };
}

export interface TrackDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** An AbortSignal that fires after `ms`; injectable so tests can run on a virtual clock. */
  readonly timeoutSignal: (ms: number) => AbortSignal;
  readonly fetch: typeof fetch;
}

const REAL_DEPS: TrackDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
  fetch: (...args) => fetch(...args),
};

async function statusOnce(requestId: string, signal: AbortSignal, deps: TrackDeps): Promise<Record<string, unknown>> {
  const response = await deps.fetch(`/api/upload-post/publish/${encodeURIComponent(requestId)}`, { method: 'GET', signal });
  const data = await readJson(response);
  if (!response.ok) return { error: String(data.error ?? `track_social_publish failed (${response.status})`), code: data.code };
  return { ok: true, ...data };
}

/** Every status request is bounded by the time left, so a wait never outlives timeoutSeconds. */
export async function trackSocialPublish(args: Args, deps: TrackDeps = REAL_DEPS): Promise<unknown> {
  const requestId = typeof args.requestId === 'string' ? args.requestId.trim() : '';
  if (!requestId) return { error: 'requestId is required' };
  const waiting = args.action === 'wait';
  const requested = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds)
    ? args.timeoutSeconds : DEFAULT_WAIT_SECONDS;
  const budgetMs = (waiting ? Math.min(Math.max(requested, 0), MAX_WAIT_SECONDS) : MAX_WAIT_SECONDS) * 1000;
  const deadline = deps.now() + budgetMs;
  let last: Record<string, unknown> | undefined;
  const expired = () => ({ ...(last ?? { ok: true, requestId, status: 'unknown', results: [] }), waitExpired: true });
  for (;;) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) return expired();
    let result: Record<string, unknown>;
    try {
      result = await statusOnce(requestId, deps.timeoutSignal(remaining), deps);
    } catch (error) {
      if (isAbort(error)) return expired();
      return { error: `track_social_publish request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (result.error) return last ? { ...last, waitExpired: true, lastError: result.error } : result;
    last = result;
    if (!waiting || SETTLED.has(String(result.status))) return result;
    const pause = Math.min(POLL_INTERVAL_MS, deadline - deps.now());
    if (pause <= 0) return expired();
    await deps.sleep(pause);
  }
}

export async function execPublishTool(name: string, args: Args): Promise<unknown> {
  switch (name) {
    case 'publish_to_social':
      return publishToSocial(args);
    case 'track_social_publish':
      return trackSocialPublish(args);
    default:
      return { error: `publish tool not implemented: ${name}` };
  }
}
