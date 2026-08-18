import { proxyDispatcher } from '../outbound-proxy.ts';
import type { MusicOptions, ValidMusicRequest } from './music-types.ts';

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

interface AtlasPrediction {
  id?: string;
  status?: string;
  outputs?: unknown;
  error?: string;
}

interface AtlasEnvelope {
  code?: number;
  message?: string;
  data?: AtlasPrediction;
}

const TERMINAL_FAILURES = new Set(['failed', 'canceled', 'cancelled']);
const wait = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export function atlasRequestBody(input: ValidMusicRequest, model: string): Record<string, unknown> {
  return {
    model,
    prompt: input.prompt,
    ...(input.lyrics ? { lyrics: input.lyrics } : {}),
    is_instrumental: input.isInstrumental,
    format: input.audioFormat,
    sample_rate: input.sampleRate,
    bitrate: input.bitrate,
  };
}

export function parseAtlasPrediction(payload: unknown): AtlasPrediction {
  if (!payload || typeof payload !== 'object') throw new Error('Atlas returned an invalid response');
  const envelope = payload as AtlasEnvelope;
  if (envelope.code !== undefined && envelope.code !== 0 && envelope.code !== 200) {
    throw new Error(envelope.message || `Atlas request failed (${envelope.code})`);
  }
  const prediction = envelope.data ?? payload as AtlasPrediction;
  if (!prediction || typeof prediction !== 'object') throw new Error('Atlas returned an invalid prediction');
  return prediction;
}

async function atlasJson(response: Response): Promise<AtlasPrediction> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    if (!response.ok) throw new Error(text.slice(0, 300) || `Atlas request failed (${response.status})`);
    throw new Error('Atlas returned invalid JSON');
  }
  if (!response.ok) {
    const envelope = payload as AtlasEnvelope;
    throw new Error(envelope.message || (envelope.data as { error?: string } | undefined)?.error || `Atlas request failed (${response.status})`);
  }
  return parseAtlasPrediction(payload);
}

function completedOutputs(prediction: AtlasPrediction): string[] {
  const outputs = Array.isArray(prediction.outputs)
    ? prediction.outputs.filter((output): output is string => typeof output === 'string' && output.length > 0)
    : [];
  if (!outputs.length) throw new Error('Atlas completed without an audio URL');
  return outputs;
}

async function awaitAtlasPrediction(baseUrl: string, apiKey: string, predictionId: string): Promise<string[]> {
  const deadline = Date.now() + 10 * 60_000;
  let delayMs = 2_000;
  while (Date.now() < deadline) {
    let response: Response;
    try {
      response = await fetchWithProxy(`${baseUrl}/model/prediction/${encodeURIComponent(predictionId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch {
      await wait(delayMs);
      delayMs = Math.min(Math.round(delayMs * 1.5), 10_000);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      await wait(delayMs);
      delayMs = Math.min(Math.round(delayMs * 1.5), 10_000);
      continue;
    }
    const prediction = await atlasJson(response);
    const status = String(prediction.status ?? '').toLowerCase();
    if (status === 'completed' || status === 'succeeded') return completedOutputs(prediction);
    if (TERMINAL_FAILURES.has(status)) throw new Error(prediction.error || `Atlas music generation ${status}`);
    await wait(delayMs);
    delayMs = Math.min(Math.round(delayMs * 1.5), 10_000);
  }
  throw new Error('Atlas music generation timed out');
}

export async function generateAtlasMusic(
  options: MusicOptions,
  input: ValidMusicRequest,
  onTaskAccepted: (taskId: string) => Promise<void>,
  existingTaskId?: string,
): Promise<string[]> {
  const baseUrl = options.atlasBaseUrl.replace(/\/$/, '');
  let predictionId = existingTaskId;
  if (!predictionId) {
    const response = await fetchWithProxy(`${baseUrl}/model/generateAudio`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.atlasApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(atlasRequestBody(input, options.atlasModel)),
    });
    const prediction = await atlasJson(response);
    predictionId = String(prediction.id ?? '').trim();
    if (!predictionId) throw new Error('Atlas did not return a prediction id');
    await onTaskAccepted(predictionId);
    const status = String(prediction.status ?? '').toLowerCase();
    if (status === 'completed' || status === 'succeeded') return completedOutputs(prediction);
    if (TERMINAL_FAILURES.has(status)) throw new Error(prediction.error || `Atlas music generation ${status}`);
  }
  return awaitAtlasPrediction(baseUrl, options.atlasApiKey, predictionId);
}
