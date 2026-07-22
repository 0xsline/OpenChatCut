import { musicProviderError, uploadMurekaFile } from './music-media.ts';
import type { MurekaChoice, MurekaTask, MusicAudioFormat, MusicOptions, ValidMusicRequest } from './music-types.ts';

const TERMINAL_FAILURES = new Set(['failed', 'timeouted', 'cancelled']);
const wait = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function choiceUrl(choice: MurekaChoice | undefined, format: MusicAudioFormat): string | undefined {
  if (format === 'flac') return choice?.flac_url ?? choice?.wav_url ?? choice?.url ?? choice?.audio_url;
  if (format === 'wav') return choice?.wav_url ?? choice?.flac_url ?? choice?.url ?? choice?.audio_url;
  return choice?.audio_url ?? choice?.url ?? choice?.wav_url ?? choice?.flac_url;
}

export function pickMurekaAudioUrl(task: MurekaTask, format: MusicAudioFormat = 'mp3'): string | undefined {
  return choiceUrl(task.choices?.[0], format);
}

export function pickMurekaAudioUrls(task: MurekaTask, format: MusicAudioFormat): string[] {
  return (task.choices ?? []).map((choice) => choiceUrl(choice, format)).filter((url): url is string => Boolean(url));
}

async function fetchTask(url: string, apiKey: string): Promise<MurekaTask> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(await musicProviderError(response));
  return response.json() as Promise<MurekaTask>;
}

async function awaitChoices(baseUrl: string, apiKey: string, initial: MurekaTask, queryKind: 'instrumental' | 'song'): Promise<MurekaTask> {
  if (!initial.id) throw new Error('Mureka did not return a task id');
  const deadline = Date.now() + 10 * 60_000;
  let task = initial;
  while (Date.now() < deadline) {
    if (task.status === 'succeeded') {
      if (!task.choices?.length) throw new Error('Mureka succeeded without audio choices');
      return task;
    }
    if (task.status && TERMINAL_FAILURES.has(task.status)) throw new Error(task.failed_reason || `Mureka generation ${task.status}`);
    await wait(2_000);
    task = await fetchTask(`${baseUrl}/v1/${queryKind}/query/${encodeURIComponent(initial.id)}`, apiKey);
  }
  throw new Error('Mureka generation timed out');
}

async function sourceId(baseUrl: string, apiKey: string, input: ValidMusicRequest): Promise<string | undefined> {
  if (!input.sourceAssetPath) return undefined;
  return uploadMurekaFile(baseUrl, apiKey, input.sourceAssetPath, input.mode === 'soundtrack' ? 'soundtrack' : 'audio');
}

export function murekaRequestShape(
  input: ValidMusicRequest,
  model: string,
  uploadedId?: string,
): { endpoint: string; query: 'instrumental' | 'song'; body: Record<string, unknown> } {
  if (input.mode === 'instrumental') return {
    endpoint: '/v1/instrumental/generate', query: 'instrumental',
    body: { model, n: input.count, prompt: input.prompt || undefined, instrumental_id: input.instrumentalId, stream: input.stream },
  };
  if (input.mode === 'song') return {
    endpoint: '/v1/song/generate', query: 'song',
    body: { model, n: input.count, lyrics: input.lyrics, prompt: input.prompt || undefined, gender: input.gender,
      reference_id: input.referenceId, vocal_id: input.vocalId, melody_id: input.melodyId, stream: input.stream },
  };
  if (input.mode === 'prompt-song') return {
    endpoint: '/v1/song/easy-generate', query: 'song',
    body: { model, n: input.count, styles: input.styles, prompt: input.prompt || undefined,
      reference_id: input.referenceId, vocal_id: input.vocalId, stream: input.stream },
  };
  if (input.mode === 'soundtrack') return {
    endpoint: '/v1/soundtrack/generate', query: 'song',
    body: { model, n: input.count, prompt: input.prompt || undefined,
      ...(input.sourceAssetKind === 'image' ? { image_id: uploadedId } : { video_id: uploadedId }),
      audio_start: input.audioStartMs, audio_end: input.audioEndMs },
  };
  return {
    endpoint: '/v1/track/generate', query: 'song',
    body: { song_id: input.songId, upload_audio_id: uploadedId, generate_type: input.trackType,
      generate_start: input.generateStartMs, generate_end: input.generateEndMs,
      lyrics: input.lyrics, prompt: input.prompt, vocal_gender: input.vocalGender },
  };
}

async function requestFor(input: ValidMusicRequest, options: MusicOptions) {
  const uploadedId = await sourceId(options.baseUrl.replace(/\/$/, ''), options.apiKey, input);
  return murekaRequestShape(input, options.model, uploadedId);
}

function checkModelCompatibility(model: string, input: ValidMusicRequest): void {
  if (!/mureka-o2/i.test(model)) return;
  if (input.mode === 'instrumental' || input.mode === 'soundtrack') throw new Error(`Mureka ${input.mode} does not support mureka-o2`);
  if (input.vocalId || input.melodyId) throw new Error('mureka-o2 does not support vocalId or melodyId');
}

export async function generateMureka(options: MusicOptions, input: ValidMusicRequest): Promise<string[]> {
  checkModelCompatibility(options.model, input);
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const request = await requestFor(input, options);
  const response = await fetch(`${baseUrl}${request.endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request.body),
  });
  if (!response.ok) throw new Error(await musicProviderError(response));
  const task = await awaitChoices(baseUrl, options.apiKey, await response.json() as MurekaTask, request.query);
  const urls = pickMurekaAudioUrls(task, input.audioFormat);
  if (!urls.length) throw new Error(`Mureka returned no ${input.audioFormat} audio URL`);
  return urls;
}
