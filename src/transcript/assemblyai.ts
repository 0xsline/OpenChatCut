// AssemblyAI transcription client. All calls go through the Vite proxy
// (/assemblyai → api.assemblyai.com) which injects the API key server-side, so
// the key never reaches the browser. Word-level timestamps are on by default.
//
// Large video masters: before uploading to AssemblyAI we ask the dev server to
// extract a 64kbps mono ASR track (POST /api/extract-audio) so a 1GB clip does
// not get re-fetched + re-uploaded whole. Falls back to the original path.
import type { TranscriptResult } from './types';
import { getMediaBlob } from '../persist/mediaBlobStore';

const BASE = '/assemblyai/v2';

/** Prefer extract for these (video always; large pure-audio too). */
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v|avi|mpeg|mpg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;
/** Pure audio above this still gets re-encoded smaller for ASR. */
const LARGE_AUDIO_BYTES = 40 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export class TranscriptionError extends Error {
  readonly code: 'source-unavailable' | 'service-unavailable';
  readonly detail?: string;

  constructor(
    code: 'source-unavailable' | 'service-unavailable',
    detail?: string,
  ) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'TranscriptionError';
    this.code = code;
    this.detail = detail;
  }
}

async function serviceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TranscriptionError('service-unavailable', detail);
  }
}

async function uploadBlob(blob: Blob, opts: TranscribeOptions): Promise<string> {
  report(opts, 'uploading-audio', `0% of ${Math.ceil(blob.size / 1024 / 1024)} MB`);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${BASE}/upload`);
    request.timeout = UPLOAD_TIMEOUT_MS;
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
      report(opts, 'uploading-audio', `${percent}% (${Math.ceil(event.loaded / 1024 / 1024)} / ${Math.ceil(event.total / 1024 / 1024)} MB)`);
    };
    request.onerror = () => reject(new TranscriptionError('service-unavailable', 'AssemblyAI upload network error'));
    request.ontimeout = () => reject(new TranscriptionError('service-unavailable', `AssemblyAI upload timed out after ${Math.round(UPLOAD_TIMEOUT_MS / 60_000)} minutes`));
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`AssemblyAI upload failed: HTTP ${request.status}${request.responseText ? `: ${request.responseText.slice(0, 300)}` : ''}`));
        return;
      }
      try {
        const body = JSON.parse(request.responseText) as { upload_url?: string };
        if (!body.upload_url) throw new Error('AssemblyAI upload returned no upload URL');
        resolve(body.upload_url);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    request.send(blob);
  });
}

async function uploadLocalPath(path: string, opts: TranscribeOptions): Promise<string> {
  report(opts, 'uploading-audio', 'server-to-AssemblyAI transfer');
  const response = await serviceFetch('/api/assemblyai-upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: path }),
  });
  if (!response.ok) throw new Error(`AssemblyAI server upload failed: ${await response.text()}`);
  const body = await response.json() as { uploadUrl?: string; bytes?: number };
  if (!body.uploadUrl) throw new Error('AssemblyAI server upload returned no upload URL');
  report(opts, 'uploading-audio', `completed ${Math.ceil((body.bytes ?? 0) / 1024 / 1024)} MB`);
  return body.uploadUrl;
}

export type TranscriptionPhase = 'extracting-audio' | 'loading-audio' | 'uploading-audio' | 'creating-job' | 'queued' | 'processing' | 'completed';

export interface TranscriptionProgress {
  phase: TranscriptionPhase;
  detail?: string;
}

export interface TranscribeOptions {
  /**
   * ISO-639-1, or `auto` to use AssemblyAI language detection.
   * Defaults to `auto` so English and multilingual media work without setup.
   */
  languageCode?: string | 'auto';
  /**
   * Pre-extracted small ASR track path (from race-ahead extract-audio).
   * When set, skip another extract-audio call.
   */
  asrPath?: string | null;
  onProgress?: (event: TranscriptionProgress) => void;
}

function report(opts: TranscribeOptions, phase: TranscriptionPhase, detail?: string): void {
  console.info('[transcription]', phase, detail ?? '');
  opts.onProgress?.({ phase, detail });
}

export async function createTranscript(audioUrl: string, opts: TranscribeOptions = {}): Promise<string> {
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    speaker_labels: true,
    // Word-level timestamps (default true for universal model; be explicit)
    punctuate: true,
    format_text: true,
  };
  const lang = opts.languageCode ?? 'auto';
  if (lang === 'auto') {
    body.language_detection = true;
  } else {
    body.language_code = lang;
  }
  report(opts, 'creating-job', opts.languageCode === 'auto' || !opts.languageCode ? 'automatic language detection' : `language ${opts.languageCode}`);
  const r = await serviceFetch(`${BASE}/transcript`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`AssemblyAI job creation failed: HTTP ${r.status}`);
  const { id, error } = await r.json();
  if (error) throw new Error(error);
  if (!id) throw new Error('transcript: no id returned');
  return id;
}

async function poll(id: string, opts: TranscribeOptions): Promise<TranscriptResult> {
  let previousStatus = '';
  for (;;) {
    const r = await serviceFetch(`${BASE}/transcript/${id}`);
    if (!r.ok) throw new Error(`AssemblyAI status check failed: HTTP ${r.status}`);
    const d = await r.json();
    if (d.status === 'completed') {
      const mapW = (w: { text: string; start: number; end: number; speaker?: string | null }) => ({
        text: (w.text ?? '').trim(),
        start: w.start,
        end: w.end,
        speaker: w.speaker ?? null,
      });
      let words = (d.words ?? []).map(mapW).filter((w: { text: string }) => w.text.length > 0);
      const utterances = (d.utterances ?? []).map((u: { speaker: string; text: string; start: number; end: number; words?: unknown[] }) => ({
        speaker: u.speaker, text: u.text, start: u.start, end: u.end,
        words: ((u.words ?? []) as { text: string; start: number; end: number; speaker?: string | null }[]).map(mapW),
      }));
      // Fallback: some locales return empty words[] but filled utterances
      if (!words.length && utterances.length) {
        words = utterances.flatMap((u: { words: ReturnType<typeof mapW>[]; speaker: string; text: string; start: number; end: number }) =>
          (u.words?.length
            ? u.words.map((w) => ({ ...w, speaker: w.speaker ?? u.speaker }))
            : [{ text: u.text, start: u.start, end: u.end, speaker: u.speaker }]),
        );
      }
      report(opts, 'completed', `${words.length} words`);
      return { text: d.text ?? words.map((w: { text: string }) => w.text).join(''), words, utterances };
    }
    if (d.status === 'error') throw new Error(`AssemblyAI transcription failed: ${d.error ?? 'unknown error'}`);
    if (d.status !== previousStatus) {
      previousStatus = d.status;
      report(opts, d.status === 'queued' ? 'queued' : 'processing', `job ${id.slice(0, 8)}`);
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
}

/** Transcribe an audio Blob: upload → create → poll to completion. */
export async function transcribeBlob(
  blob: Blob,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  const url = await uploadBlob(blob, opts);
  const id = await createTranscript(url, opts);
  return poll(id, opts);
}

/** Read a media source, falling back to the local-first IndexedDB copy. */
export async function loadTranscriptionSource(path: string): Promise<Blob> {
  let responseError: Error | null = null;
  try {
    const res = await fetch(path);
    const isHtml = (res.headers.get('content-type') ?? '').includes('text/html');
    if (res.ok && !isHtml) return res.blob();
    responseError = new Error(`HTTP ${res.status}`);
  } catch (error) {
    responseError = error instanceof Error ? error : new Error(String(error));
  }
  const cached = await getMediaBlob(path);
  if (cached?.blob.size) return cached.blob;
  throw new TranscriptionError('source-unavailable', responseError?.message);
}

/**
 * Ask the local server to extract a speech-sized audio file for ASR.
 * Returns the new /media/uploads/… path, or null if extract is unavailable.
 */
export async function extractAudioForAsr(src: string): Promise<string | null> {
  if (!src.startsWith('/media/uploads/')) return null;
  try {
    const res = await fetch('/api/extract-audio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ src }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { path?: string; ok?: boolean };
    return data.path && data.path.startsWith('/media/uploads/') ? data.path : null;
  } catch {
    return null;
  }
}

async function headBytes(path: string): Promise<number | null> {
  try {
    const r = await fetch(path, { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') ?? '');
    return Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

/** Decide whether to run server-side audio extract before ASR upload. */
async function shouldExtractForAsr(path: string): Promise<boolean> {
  if (VIDEO_EXT.test(path)) return true;
  if (!AUDIO_EXT.test(path)) return true; // unknown extension: try extract (no-op-ish for pure audio)
  const bytes = await headBytes(path);
  return bytes != null && bytes > LARGE_AUDIO_BYTES;
}

/**
 * Transcribe a same-origin media path. Videos (and large audio) first extract a
 * small ASR track server-side; then only that small blob is sent to AssemblyAI.
 * Pass opts.asrPath when extract already raced ahead of normalize/finalize.
 */
export async function transcribePath(
  path: string,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  let source = path;
  if (opts.asrPath && opts.asrPath.startsWith('/media/')) {
    source = opts.asrPath;
  } else if (await shouldExtractForAsr(path)) {
    report(opts, 'extracting-audio');
    const extracted = await extractAudioForAsr(path);
    if (extracted) source = extracted;
  }
  if (source.startsWith('/media/uploads/')) {
    const url = await uploadLocalPath(source, opts);
    const id = await createTranscript(url, opts);
    return poll(id, opts);
  }
  report(opts, 'loading-audio', source === path ? 'original media' : 'extracted speech audio');
  let blob: Blob;
  try {
    blob = await loadTranscriptionSource(source);
  } catch (error) {
    // A raced-ahead ASR extract can disappear independently of the original.
    // Fall back to the original media (or its IndexedDB copy) before failing.
    if (source === path) throw error;
    blob = await loadTranscriptionSource(path);
  }
  return transcribeBlob(blob, opts);
}
