export { PUBLISH_TOOL_SCHEMAS, PUBLISH_TOOL_NAMES } from './schemas/publish-tools';

// Social publishing through the local server's /api/upload-post routes
// (server/plugins/upload-post.ts). The server holds the API key; the browser
// only sends the render path and the publish fields.
//
// publish_to_social is two-step by contract: without confirm the server only
// previews; with confirm:true it uploads. track_social_publish polls the
// per-platform results for the returned requestId.

type Args = Record<string, unknown>;

const DEFAULT_WAIT_SECONDS = 20; // stays below the browser Agent's 30-second tool deadline
const MAX_WAIT_SECONDS = 25;
const POLL_INTERVAL_MS = 3_000;
const TERMINAL = new Set(['completed', 'failed']);

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

async function publishToSocial(args: Args): Promise<unknown> {
  const body: Record<string, unknown> = {
    source: args.source,
    platforms: args.platforms,
    title: args.title,
    description: args.description,
    youtubePrivacy: args.youtubePrivacy,
    tiktokPrivacy: args.tiktokPrivacy,
    aiGenerated: args.aiGenerated === true,
    confirm: args.confirm === true,
  };
  let response: Response;
  try {
    response = await fetch('/api/upload-post/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { error: `publish_to_social request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const data = await readJson(response);
  if (!response.ok) return { error: String(data.error ?? `publish_to_social failed (${response.status})`), code: data.code };
  if (data.phase === 'preview') {
    return {
      ok: true,
      ...data,
      next: 'Show this preview to the user. Publishing is public and cannot be undone; call again with confirm:true only after they approve.',
    };
  }
  if (data.phase === 'unconfirmed_delivery') {
    return {
      ok: true,
      ...data,
      next: 'The connection dropped during the upload. Do NOT publish again: poll track_social_publish with this requestId to see whether it arrived.',
    };
  }
  return { ok: true, ...data, next: 'Poll track_social_publish with requestId, then report each platform result.' };
}

async function statusOnce(requestId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/upload-post/publish/${encodeURIComponent(requestId)}`, { method: 'GET' });
  const data = await readJson(response);
  if (!response.ok) return { error: String(data.error ?? `track_social_publish failed (${response.status})`), code: data.code };
  return { ok: true, ...data };
}

async function trackSocialPublish(args: Args): Promise<unknown> {
  const requestId = typeof args.requestId === 'string' ? args.requestId.trim() : '';
  if (!requestId) return { error: 'requestId is required' };
  if (args.action !== 'wait') return statusOnce(requestId);
  const requested = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds)
    ? args.timeoutSeconds : DEFAULT_WAIT_SECONDS;
  const deadline = Date.now() + Math.min(Math.max(requested, 0), MAX_WAIT_SECONDS) * 1000;
  for (;;) {
    const result = await statusOnce(requestId);
    if (result.error || TERMINAL.has(String(result.status))) return result;
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      return {
        ...result,
        waitExpired: true,
        ...(result.status === 'not_found'
          ? { note: 'Not visible yet — a just-submitted publish can take a few seconds to register. Check again shortly.' }
          : {}),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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
