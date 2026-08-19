import { proxyDispatcher } from '../outbound-proxy.ts';
import { createWriteStream, openAsBlob } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
// Proxy-aware fetch: attaches the configured outbound proxy (keystore
// PROXY_URL or HTTPS_PROXY/HTTP_PROXY env) via undici dispatcher.
type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

// Sonilo scores the finished cut: /v1/video-to-music (≤6-minute video) and
// /v1/video-to-sfx (≤3-minute video). Both are async: multipart submit →
// poll GET /v1/tasks/{task_id} → presigned audio URL + per-track license_id.
// /v1 routes to the latest model server-side; no model id is sent.
export const SONILO_MUSIC_MAX_VIDEO_SECONDS = 360;
export const SONILO_SFX_MAX_VIDEO_SECONDS = 180;
export const SONILO_MUSIC_ENDPOINT = '/v1/video-to-music';
export const SONILO_SFX_ENDPOINT = '/v1/video-to-sfx';
// Partner-origin attribution header; the backend has no other way to tell
// which integration a request came from.
const SONILO_USER_AGENT = 'OpenChatCut';

const TERMINAL_FAILURES = new Set(['failed', 'timeouted', 'cancelled']);
const wait = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function soniloTaskError(message: string, code: string, retryable: boolean): Error {
  return Object.assign(new Error(message), { code, retryable });
}

export interface SoniloTrack {
  name?: string;
  url?: string;
  audio_url?: string;
  license_id?: string;
}

export interface SoniloTask {
  task_id?: string;
  id?: string;
  status?: string;
  error?: string;
  failed_reason?: string;
  audio?: SoniloTrack;
  result?: Record<string, unknown>;
  tracks?: SoniloTrack[];
}

export interface SoniloAudioTrack {
  name: string;
  url: string;
  licenseId?: string;
}

export async function soniloProviderError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { message?: string; detail?: string; error?: { message?: string } | string };
    const error = typeof data.error === 'string' ? data.error : data.error?.message;
    return error ?? data.message ?? data.detail ?? `Sonilo request failed (${response.status})`;
  } catch {
    return text.slice(0, 300) || `Sonilo request failed (${response.status})`;
  }
}

export function soniloTaskId(task: SoniloTask): string | undefined {
  const id = task.task_id ?? task.id;
  return id ? String(id) : undefined;
}

/** Flatten every audio-carrying object in the task result, primary track first.
 * Tolerates both a `tracks` array and single/keyed objects under `result`;
 * `license_id` is attached when the provider returns one. */
export function pickSoniloTracks(task: SoniloTask): SoniloAudioTrack[] {
  const tracks: SoniloAudioTrack[] = [];
  const urls = new Set<string>();
  const push = (name: string, candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return;
    const entry = candidate as SoniloTrack;
    const url = entry.url ?? entry.audio_url;
    if (!url || urls.has(url)) return;
    urls.add(url);
    tracks.push({ name: entry.name ?? name, url, licenseId: entry.license_id });
  };
  push('audio', task.audio);
  for (const [index, entry] of (task.tracks ?? []).entries()) push(`track_${index + 1}`, entry);
  const result = task.result ?? {};
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) for (const [index, entry] of value.entries()) push(`${key}_${index + 1}`, entry);
    else push(key, value);
  }
  return tracks;
}

function localVideoUpload(uploadPath: string): { file: string; name: string } {
  const clean = uploadPath.split(/[?#]/, 1)[0];
  if (!clean.startsWith('/media/uploads/')) throw new Error('Sonilo source must be a project upload');
  const name = clean.slice('/media/uploads/'.length);
  if (!isSafeUploadName(name)) throw new Error('invalid Sonilo source path');
  const file = resolveUploadFile(name);
  if (!file) throw new Error(`Sonilo source not found: ${uploadPath}`);
  return { file, name };
}

export function probeMediaDurationSeconds(file: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      const duration = Number(output.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolvePromise(duration);
      else reject(new Error('unable to probe Sonilo source video'));
    });
  });
}

/** Fail fast locally before uploading a cut the provider would reject. */
export async function assertSoniloVideoDuration(uploadPath: string, maxSeconds: number, label: string): Promise<void> {
  const { file } = localVideoUpload(uploadPath);
  const duration = await probeMediaDurationSeconds(file);
  if (duration > maxSeconds) {
    throw new Error(`Sonilo ${label} supports videos up to ${Math.round(maxSeconds / 60)} minutes; the source is ${Math.ceil(duration)}s`);
  }
}

function mimeFor(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  return ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';
}

/** Multipart submit of a project video upload; resolves to the accepted task id. */
export async function submitSoniloVideoTask(
  baseUrl: string,
  apiKey: string,
  endpoint: string,
  uploadPath: string,
  prompt?: string,
): Promise<string> {
  const { file, name } = localVideoUpload(uploadPath);
  if (!(await stat(file)).size) throw new Error('Sonilo source video is empty');
  const form = new FormData();
  form.append('file', await openAsBlob(file, { type: mimeFor(file) }), name);
  form.append('mode', 'async');
  if (prompt) form.append('prompt', prompt);
  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, '')}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': SONILO_USER_AGENT },
    body: form,
  });
  if (!response.ok) throw new Error(await soniloProviderError(response));
  const task = await response.json() as SoniloTask;
  const id = soniloTaskId(task);
  if (!id) throw new Error('Sonilo did not return a task id');
  return id;
}

async function fetchSoniloTask(baseUrl: string, apiKey: string, taskId: string): Promise<SoniloTask> {
  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, '')}/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': SONILO_USER_AGENT },
  });
  // 404 on the poll is the documented fail-fast signal (task not found/expired),
  // not a transient error worth retrying.
  if (response.status === 404) {
    throw soniloTaskError(`Sonilo task not found or expired: ${taskId}`, 'sonilo_task_not_found', false);
  }
  if (!response.ok) throw new Error(await soniloProviderError(response));
  return response.json() as Promise<SoniloTask>;
}

/** Poll the task to a terminal state and return its audio tracks (primary first). */
export async function awaitSoniloTracks(baseUrl: string, apiKey: string, taskId: string): Promise<SoniloAudioTrack[]> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const task = await fetchSoniloTask(baseUrl, apiKey, taskId);
    if (task.status === 'succeeded') {
      const tracks = pickSoniloTracks(task);
      if (!tracks.length) {
        throw soniloTaskError('Sonilo succeeded without an audio track', 'sonilo_result_missing', false);
      }
      return tracks;
    }
    if (task.status && TERMINAL_FAILURES.has(task.status)) {
      throw soniloTaskError(
        task.failed_reason || task.error || `Sonilo generation ${task.status}`,
        'sonilo_provider_terminal',
        false,
      );
    }
    await wait(2_000);
  }
  throw soniloTaskError('Sonilo generation timed out', 'sonilo_poll_timeout', true);
}

function audioExtFor(url: string, contentType: string | null): string {
  const clean = url.split(/[?#]/, 1)[0];
  const ext = extname(clean).replace('.', '').toLowerCase();
  if (['m4a', 'mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return ext;
  if (contentType?.includes('mpeg')) return 'mp3';
  if (contentType?.includes('wav')) return 'wav';
  return 'm4a';
}

/** Stream a (presigned — never send auth headers to it) result URL into the
 * uploads dir. Sonilo outputs .m4a; the extension follows the URL/content type. */
export async function saveSoniloAudioResponse(
  response: Response,
  sourceUrl: string,
): Promise<{ path: string; durationSeconds: number }> {
  if (!response.ok) throw new Error(await soniloProviderError(response));
  if (!response.body) throw new Error('Sonilo returned empty audio');
  const ext = audioExtFor(sourceUrl, response.headers.get('content-type'));
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  const file = join(dir, filename);
  const partial = join(dir, `.${filename}.part`);
  try {
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream),
      createWriteStream(partial, { flags: 'wx' }),
    );
    if (!(await stat(partial)).size) throw new Error('Sonilo returned empty audio');
    const durationSeconds = await probeMediaDurationSeconds(partial);
    await rename(partial, file);
    return { path: `/media/uploads/${filename}`, durationSeconds };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Durable per-track license record beside the audio file — an auditable
 * artifact users can keep for commercial-use review. Best-effort: a sidecar
 * failure never fails the generation itself. */
export async function writeSoniloLicenseSidecar(audioPath: string, licenseId: string): Promise<void> {
  const name = audioPath.split('/').pop();
  if (!name || !isSafeUploadName(name)) return;
  const sidecar = join(uploadDir(), `${name}.license.json`);
  const record = { provider: 'sonilo', licenseId, audioPath, savedAt: new Date().toISOString() };
  await writeFile(sidecar, `${JSON.stringify(record, null, 2)}\n`).catch(() => undefined);
}
