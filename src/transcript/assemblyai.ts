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

async function createTranscript(audioUrl: string): Promise<string> {
  const r = await fetch(`${BASE}/transcript`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl }),
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
      const words = (d.words ?? []).map((w: { text: string; start: number; end: number }) => ({ text: w.text, start: w.start, end: w.end }));
      return { text: d.text ?? '', words };
    }
    if (d.status === 'error') throw new Error(d.error ?? 'transcription error');
    onWait?.();
    await new Promise((res) => setTimeout(res, 2500));
  }
}

/** Transcribe an audio Blob: upload → create → poll to completion. */
export async function transcribeBlob(blob: Blob, onWait?: () => void): Promise<TranscriptResult> {
  const url = await uploadBlob(blob);
  const id = await createTranscript(url);
  return poll(id, onWait);
}

/** Transcribe a same-origin audio file path (fetched, then uploaded). */
export async function transcribePath(path: string, onWait?: () => void): Promise<TranscriptResult> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path}: HTTP ${res.status}`);
  return transcribeBlob(await res.blob(), onWait);
}
