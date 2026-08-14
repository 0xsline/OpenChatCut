// AssemblyAI transcription client. All calls go through the Vite proxy
// (/assemblyai → api.assemblyai.com) which injects the API key server-side, so
// the key never reaches the browser. Word-level timestamps are on by default.
//
// Large video masters: before uploading to AssemblyAI we ask the dev server to
// extract a 64kbps mono ASR track (POST /api/extract-audio) so a 1GB clip does
// not get re-fetched + re-uploaded whole. Falls back to the original path.
import type { TranscriptResult } from './types';
import { getMediaBlob } from '../persist/mediaBlobStore';

const ASSEMBLYAI_POLL_DEADLINE_MS = 30 * 60 * 1000;
const BASE = '/assemblyai/v2';

/** Prefer extract for these (video always; large pure-audio too). */
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v|avi|mpeg|mpg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;
/** Pure audio above this still gets re-encoded smaller for ASR. */
const LARGE_AUDIO_BYTES = 40 * 1024 * 1024;

export class TranscriptionError extends Error {
  readonly code: 'source-unavailable' | 'service-unavailable' | 'no-audio';
  readonly detail?: string;

  constructor(
    code: 'source-unavailable' | 'service-unavailable' | 'no-audio',
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

async function uploadBlob(blob: Blob): Promise<string> {
  const r = await serviceFetch(`${BASE}/upload`, { method: 'POST', body: blob });
  if (!r.ok) throw new Error(`upload failed: HTTP ${r.status}`);
  const { upload_url } = await r.json();
  if (!upload_url) throw new Error('upload: no upload_url returned');
  return upload_url;
}

async function uploadLocalPath(path: string): Promise<string> {
  const response = await serviceFetch('/api/assemblyai-upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: path }),
  });
  const responseText = await response.text();
  if (response.status === 404) {
    throw new TranscriptionError('source-unavailable', responseText.slice(0, 300));
  }
  if (!response.ok) {
    throw new Error(`AssemblyAI server upload failed: HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 300)}` : ''}`);
  }
  let body: { uploadUrl?: unknown };
  try {
    body = JSON.parse(responseText) as { uploadUrl?: unknown };
  } catch {
    throw new Error('AssemblyAI server upload returned invalid JSON');
  }
  if (typeof body.uploadUrl !== 'string' || !body.uploadUrl) {
    throw new Error('AssemblyAI server upload returned no upload URL');
  }
  return body.uploadUrl;
}

export interface TranscribeOptions {
  /**
   * ISO-639-1. Default `zh` for this product (Chinese oral broadcast).
   * Pass `auto` to use AssemblyAI language_detection instead.
   */
  languageCode?: string | 'auto';
  /** Enable provider speaker diarization. Defaults to the existing enabled behavior. */
  diarize?: boolean;
  /**
   * Pre-extracted small ASR track path (from race-ahead extract-audio).
   * When set, skip another extract-audio call.
   */
  asrPath?: string | null;
}

export type AssemblyAiProviderStatus =
  | 'uploaded'
  | 'submitted'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'error';

export interface AssemblyAiResumeCheckpoint {
  uploadUrl?: string;
  providerJobId?: string;
  providerStatus?: AssemblyAiProviderStatus;
}

export type AssemblyAiCheckpointWriter = (
  checkpoint: AssemblyAiResumeCheckpoint,
) => void | Promise<void>;

async function createTranscript(audioUrl: string, opts: TranscribeOptions = {}): Promise<string> {
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    speaker_labels: opts.diarize ?? true,
    // Word-level timestamps (default true for universal model; be explicit)
    punctuate: true,
    format_text: true,
  };
  const lang = opts.languageCode ?? 'zh';
  if (lang === 'auto') {
    body.language_detection = true;
  } else {
    // Explicit zh is far more reliable for Chinese documentary oral broadcast than pure auto-detect.
    body.language_code = lang;
  }
  const r = await serviceFetch(`${BASE}/transcript`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`create failed: HTTP ${r.status}`);
  const { id, error } = await r.json();
  if (error) throw new Error(error);
  if (!id) throw new Error('transcript: no id returned');
  return id;
}

async function poll(
  id: string,
  onWait?: (note?: string) => void,
  onCheckpoint?: AssemblyAiCheckpointWriter,
  resume: AssemblyAiResumeCheckpoint = {},
): Promise<TranscriptResult> {
  // A provider job stuck in queued/processing must not poll forever (and
  // re-enter the same loop on every reload via the resume checkpoint).
  const deadline = Date.now() + ASSEMBLYAI_POLL_DEADLINE_MS;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('transcription timed out while waiting for the provider; please retry');
    }
    const r = await serviceFetch(`${BASE}/transcript/${id}`);
    if (!r.ok) throw new Error(`poll failed: HTTP ${r.status}`);
    const d = await r.json();
    const providerStatus = String(d.status ?? 'processing') as AssemblyAiProviderStatus;
    await onCheckpoint?.({ ...resume, providerJobId: id, providerStatus });
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
      return { text: d.text ?? words.map((w: { text: string }) => w.text).join(''), words, utterances };
    }
    if (d.status === 'error') throw new Error(d.error ?? 'transcription error');
    const waited = Math.max(0, Math.round((ASSEMBLYAI_POLL_DEADLINE_MS - (deadline - Date.now())) / 1000));
    onWait?.(`云端转写中（${String(d.status)}，已等待 ${waited}s）`);
    await new Promise((res) => setTimeout(res, 2500));
  }
}

/** Transcribe an audio Blob: upload → create → poll to completion. */
export async function transcribeBlob(
  blob: Blob,
  onWait?: () => void,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  const url = await uploadBlob(blob);
  const id = await createTranscript(url, opts);
  return poll(id, onWait);
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
    if (res.status === 422) {
      const data = (await res.json().catch(() => null)) as { noAudio?: boolean } | null;
      if (data?.noAudio) throw new TranscriptionError('no-audio', `该片段没有音轨，无法转写：${src}`);
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { path?: string; ok?: boolean };
    return data.path && data.path.startsWith('/media/uploads/') ? data.path : null;
  } catch (error) {
    if (error instanceof TranscriptionError) throw error;
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
 * Shared with the local ASR provider — do not break its callers.
 */
export async function transcriptionSourceForPath(path: string, opts: TranscribeOptions): Promise<string> {
  if (opts.asrPath && opts.asrPath.startsWith('/media/')) return opts.asrPath;
  if (await shouldExtractForAsr(path)) {
    const extracted = await extractAudioForAsr(path);
    if (extracted) return extracted;
  }
  return path;
}

async function uploadTranscriptionSource(path: string): Promise<string> {
  if (path.startsWith('/media/uploads/')) {
    try {
      return await uploadLocalPath(path);
    } catch (error) {
      if (!(error instanceof TranscriptionError) || error.code !== 'source-unavailable') throw error;
    }
  }
  return uploadBlob(await loadTranscriptionSource(path));
}

async function uploadTranscriptionPath(path: string, opts: TranscribeOptions): Promise<string> {
  const source = await transcriptionSourceForPath(path, opts);
  try {
    return await uploadTranscriptionSource(source);
  } catch (error) {
    // A raced-ahead ASR extract can disappear independently of the original.
    // Fall back to the original media (or its IndexedDB copy) before failing.
    if (
      source === path
      || !(error instanceof TranscriptionError)
      || error.code !== 'source-unavailable'
    ) throw error;
    return uploadTranscriptionSource(path);
  }
}

/**
 * Resume from the latest durable provider checkpoint. A known upload URL skips
 * re-upload; a known provider job id skips both upload and duplicate submission.
 */
export async function transcribePathResumable(
  path: string,
  resume: AssemblyAiResumeCheckpoint,
  onCheckpoint: AssemblyAiCheckpointWriter,
  onWait?: (note?: string) => void,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  let checkpoint = { ...resume };
  let providerJobId = checkpoint.providerJobId;
  if (!providerJobId) {
    let uploadUrl = checkpoint.uploadUrl;
    if (!uploadUrl) {
      uploadUrl = await uploadTranscriptionPath(path, opts);
      checkpoint = { ...checkpoint, uploadUrl, providerStatus: 'uploaded' };
      await onCheckpoint(checkpoint);
    }
    providerJobId = await createTranscript(uploadUrl, opts);
    checkpoint = {
      ...checkpoint,
      uploadUrl,
      providerJobId,
      providerStatus: 'submitted',
    };
    // This write is awaited before the first poll, closing the refresh/re-upload window.
    await onCheckpoint(checkpoint);
  }
  return poll(providerJobId, onWait, async (next) => {
    checkpoint = next;
    await onCheckpoint(next);
  }, checkpoint);
}

export async function transcribePath(
  path: string,
  onWait?: (note?: string) => void,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  return transcribePathResumable(path, {}, () => {}, onWait, opts);
}
