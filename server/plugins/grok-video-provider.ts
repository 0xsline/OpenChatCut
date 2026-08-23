import { proxyDispatcher } from '../outbound-proxy.ts';
import { xaiOauthAccessToken } from '../xai-oauth-session.ts';
import type { RegisterGenerationProviderTask } from './generation-jobs.ts';
import type { ValidVideoRequest } from './video-validation.ts';

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);
const FAILURES = new Set(['failed', 'expired', 'cancelled']);
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

interface GrokVideoOptions {
  xaiBaseUrl: string;
  xaiApiKey: string;
  xaiVideoModel: string;
}

async function providerError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { message?: string; error?: { message?: string } };
    return data.error?.message ?? data.message ?? `video provider failed (${response.status})`;
  } catch {
    return text.slice(0, 300) || `video provider failed (${response.status})`;
  }
}

/** xAI Grok Imagine Video: asynchronous request id plus polling. */
export async function generateGrokVideo(
  input: ValidVideoRequest,
  options: GrokVideoOptions,
  registerProviderTask: RegisterGenerationProviderTask,
  existingTaskId?: string,
): Promise<string> {
  const baseUrl = options.xaiBaseUrl.replace(/\/$/, '');
  const token = xaiOauthAccessToken() || options.xaiApiKey;
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let taskId = existingTaskId;
  if (!taskId) {
    const startedResponse = await fetchWithProxy(`${baseUrl}/videos/generations`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: options.xaiVideoModel, prompt: input.prompt,
        duration: input.durationSeconds, aspect_ratio: input.ratio,
        resolution: input.resolution ?? '480p',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!startedResponse.ok) throw new Error(await providerError(startedResponse));
    const started = await startedResponse.json() as { request_id?: unknown };
    taskId = String(started.request_id ?? '');
    if (!taskId) throw new Error('grok-imagine-video did not return a request id');
    await registerProviderTask('grok-imagine-video', taskId);
  }
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const poll = await fetchWithProxy(`${baseUrl}/videos/${encodeURIComponent(taskId)}`, {
      headers, signal: AbortSignal.timeout(20_000),
    });
    if (!poll.ok) throw new Error(await providerError(poll));
    const current = await poll.json() as { status?: unknown; video?: { url?: unknown } };
    const status = String(current.status ?? '');
    if (status === 'done') {
      const url = current.video?.url;
      if (typeof url !== 'string' || !url) throw new Error('grok-imagine-video succeeded without a video URL');
      return url;
    }
    if (FAILURES.has(status)) throw new Error(`grok-imagine-video generation ${status}`);
    await wait(3_000);
  }
  throw new Error('grok-imagine-video generation timed out');
}
