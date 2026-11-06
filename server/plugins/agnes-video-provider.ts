// Agnes Video (OpenAI Videos-compatible, async): create a task, then poll it.
// Split out of video.ts, which keeps routing, validation and result saving.
import { proxyDispatcher } from '../outbound-proxy.ts';
import type { RegisterGenerationProviderTask } from './generation-jobs.ts';
import { mediaDataUrl } from './video-media.ts';
import type { ValidVideoRequest } from './video-validation.ts';

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);
const FAILURES = new Set(['failed', 'expired', 'cancelled']);
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface AgnesVideoOptions {
  agnesBaseUrl: string;
  agnesApiKey: string;
  agnesVideoModel: string;
}

async function providerError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { message?: string; detail?: unknown; error?: { message?: string }; code?: number };
    const detail = data.detail == null ? undefined
      : typeof data.detail === 'string' ? data.detail
        : JSON.stringify(data.detail).slice(0, 300);
    return data.error?.message ?? data.message ?? detail ?? `video provider failed (${data.code ?? response.status})`;
  } catch {
    return text.slice(0, 300) || `video provider failed (${response.status})`;
  }
}

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchWithProxy(url, init);
  if (!response.ok) throw new Error(await providerError(response));
  const data = await response.json() as Record<string, unknown>;
  if (typeof data.code === 'number' && data.code !== 0) throw new Error(String(data.message ?? `video provider failed (${data.code})`));
  return data;
}

/** Agnes retrieves tasks at the host root, not under /v1/videos/{id}. */
export function agnesVideoRetrieveUrl(baseUrl: string, videoId: string, model: string): string {
  const params = new URLSearchParams({ video_id: videoId, model_name: model });
  return `${new URL(baseUrl).origin}/agnesapi?${params.toString()}`;
}

export async function generateAgnesVideo(
  input: ValidVideoRequest,
  options: AgnesVideoOptions,
  registerProviderTask: RegisterGenerationProviderTask,
  existingTaskId?: string,
): Promise<string> {
  if (!options.agnesApiKey) throw new Error('Agnes is not configured. Set AGNES_VIDEO_API_KEY in .env.local or 设置面板.');
  const baseUrl = options.agnesBaseUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${options.agnesApiKey}`, 'Content-Type': 'application/json' };
  const model = options.agnesVideoModel;
  let taskId = existingTaskId;
  if (!taskId) {
    const body: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      seconds: String(input.durationSeconds),
      size: '720P',
      aspect_ratio: input.ratio,
      n: 1,
    };
    if (input.seed !== undefined) body.seed = input.seed;
    if (input.firstFramePath || input.lastFramePath) {
      body.mode = 'keyframe';
      if (input.firstFramePath) body.first_frame = await mediaDataUrl(input.firstFramePath);
      if (input.lastFramePath) body.last_frame = await mediaDataUrl(input.lastFramePath);
    } else if (input.refImagePaths.length || input.refAudioPaths.length) {
      body.mode = 'reference';
      if (input.refImagePaths.length) {
        body.images = await Promise.all(input.refImagePaths.map((p) => mediaDataUrl(p)));
      }
      if (input.refAudioPaths.length) {
        body.audios = await Promise.all(input.refAudioPaths.map((p) => mediaDataUrl(p)));
      }
    } else {
      body.mode = 'text';
    }
    const current = await requestJson(`${baseUrl}/videos`, { method: 'POST', headers, body: JSON.stringify(body) });
    taskId = String(current.video_id ?? '');
    if (!taskId) throw new Error('agnes-video did not return a video_id');
    await registerProviderTask('agnes-video', taskId);
  }
  if (!taskId) throw new Error('agnes-video provider task id is unavailable');
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const current = await requestJson(agnesVideoRetrieveUrl(baseUrl, taskId, model), { headers });
    const status = String(current.status ?? '');
    if (status === 'completed') {
      const url = String(current.url ?? '');
      if (!url) throw new Error('agnes-video completed without a video URL');
      return url;
    }
    if (FAILURES.has(status)) throw new Error(String(current.error ?? `agnes-video generation ${status}`));
    await wait(2_000);
  }
  throw new Error('agnes-video generation timed out');
}
