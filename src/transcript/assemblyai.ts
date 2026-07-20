// AssemblyAI transcription client. All calls go through the Vite proxy
// (/assemblyai → api.assemblyai.com) which injects the API key server-side, so
// the key never reaches the browser. Word-level timestamps are on by default.
//
// Large video masters: before uploading to AssemblyAI we ask the dev server to
// extract a 64kbps mono ASR track (POST /api/extract-audio) so a 1GB clip does
// not get re-fetched + re-uploaded whole. Falls back to the original path.
import type { TranscriptResult } from './types';

const BASE = '/assemblyai/v2';

/** Prefer extract for these (video always; large pure-audio too). */
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v|avi|mpeg|mpg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;
/** Pure audio above this still gets re-encoded smaller for ASR. */
const LARGE_AUDIO_BYTES = 40 * 1024 * 1024;

async function uploadBlob(blob: Blob): Promise<string> {
  const r = await fetch(`${BASE}/upload`, { method: 'POST', body: blob });
  if (!r.ok) throw new Error(`upload failed: HTTP ${r.status}`);
  const { upload_url } = await r.json();
  if (!upload_url) throw new Error('upload: no upload_url returned');
  return upload_url;
}

export interface TranscribeOptions {
  /**
   * ISO-639-1. Default `zh` for this product (中文口播).
   * Pass `auto` to use AssemblyAI language_detection instead.
   */
  languageCode?: string | 'auto';
  /**
   * Pre-extracted small ASR track path (from race-ahead extract-audio).
   * When set, skip another extract-audio call.
   */
  asrPath?: string | null;
}

async function createTranscript(audioUrl: string, opts: TranscribeOptions = {}): Promise<string> {
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    speaker_labels: true,
    // Word-level timestamps (default true for universal model; be explicit)
    punctuate: true,
    format_text: true,
  };
  const lang = opts.languageCode ?? 'zh';
  if (lang === 'auto') {
    body.language_detection = true;
  } else {
    // Explicit zh is far more reliable for 中文纪录片口播 than pure auto-detect.
    body.language_code = lang;
  }
  const r = await fetch(`${BASE}/transcript`, {
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

async function poll(id: string, onWait?: () => void): Promise<TranscriptResult> {
  for (;;) {
    const r = await fetch(`${BASE}/transcript/${id}`);
    if (!r.ok) throw new Error(`poll failed: HTTP ${r.status}`);
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
      return { text: d.text ?? words.map((w: { text: string }) => w.text).join(''), words, utterances };
    }
    if (d.status === 'error') throw new Error(d.error ?? 'transcription error');
    onWait?.();
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
  onWait?: () => void,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  let source = path;
  if (opts.asrPath && opts.asrPath.startsWith('/media/')) {
    source = opts.asrPath;
  } else if (await shouldExtractForAsr(path)) {
    const extracted = await extractAudioForAsr(path);
    if (extracted) source = extracted;
  }
  const res = await fetch(source);
  if (!res.ok) throw new Error(`fetch ${source}: HTTP ${res.status}`);
  return transcribeBlob(await res.blob(), onWait, { languageCode: opts.languageCode });
}
