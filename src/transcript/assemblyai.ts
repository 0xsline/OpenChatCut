// AssemblyAI transcription client. All calls go through the Vite proxy
// (/assemblyai → api.assemblyai.com) which injects the API key server-side, so
// the key never reaches the browser. Word-level timestamps are on by default.
import type { TranscriptResult } from './types';

const BASE = '/assemblyai/v2';

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
        words = utterances.flatMap((u: { words: ReturnType<typeof mapW>[]; speaker: string }) =>
          (u.words?.length
            ? u.words.map((w) => ({ ...w, speaker: w.speaker ?? u.speaker }))
            : [{ text: u.text, start: (u as { start: number }).start, end: (u as { end: number }).end, speaker: u.speaker }]),
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

/** Transcribe a same-origin audio/video file path (fetched, then uploaded). */
export async function transcribePath(
  path: string,
  onWait?: () => void,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path}: HTTP ${res.status}`);
  return transcribeBlob(await res.blob(), onWait, opts);
}
