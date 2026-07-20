// Browser-side ASR track race: extract a speech-sized mono clip from a local File
// *before or while* the multi-GB master uploads
// (64k audio first, then master bytes).
//
// Paths:
//   1) Audio files (or short enough): WebAudio decode → 16 kHz mono WAV → /upload
//   2) Video: captureStream + MediaRecorder (64k opus/webm) while playing at high rate
//   3) Fail → null (caller falls back to server /api/extract-audio after master lands)
//
// Caps keep 1GB files from freezing the tab: skip decode for huge blobs, and
// MediaRecorder path aborts after a wall-clock budget.

const MAX_WEBAUDIO_BYTES = 80 * 1024 * 1024; // decodeAudioData loads whole buffer
const MAX_CAPTURE_WALL_MS = 90_000;
const CAPTURE_PLAYBACK_RATE = 4;
const TARGET_SR = 16_000;

function safeAsrName(file: File, ext: string): string {
  const stem = (file.name || 'media').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]+/g, '_').slice(0, 60) || 'media';
  return `${stem}.asr${ext}`;
}

async function uploadAsrBlob(blob: Blob, name: string): Promise<string | null> {
  try {
    const res = await fetch(`/upload?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { path?: string };
    return data.path?.startsWith('/media/uploads/') ? data.path : null;
  } catch {
    return null;
  }
}

/** Encode Float32 mono PCM as 16-bit WAV. */
function encodeWavMono(samples: Float32Array, sampleRate: number): Blob {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, 'data');
  view.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function downsampleMono(buffer: AudioBuffer, targetSr: number): Float32Array {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const mix = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) mix[i] += data[i] / ch;
  }
  if (buffer.sampleRate === targetSr) return mix;
  const ratio = buffer.sampleRate / targetSr;
  const outLen = Math.max(1, Math.floor(len / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(len - 1, i0 + 1);
    const t = src - i0;
    out[i] = mix[i0] * (1 - t) + mix[i1] * t;
  }
  return out;
}

/** WebAudio path — best for audio/* and small containers the browser can decode. */
async function extractViaWebAudio(file: File): Promise<string | null> {
  if (file.size > MAX_WEBAUDIO_BYTES) return null;
  if (typeof AudioContext === 'undefined' && typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext === 'undefined') {
    return null;
  }
  const AC = AudioContext || (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
  const ctx = new AC();
  try {
    const ab = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(ab.slice(0));
    const mono = downsampleMono(decoded, TARGET_SR);
    // Cap ~30 min of 16k mono to keep upload small (~58MB max)
    const maxSamples = TARGET_SR * 30 * 60;
    const clipped = mono.length > maxSamples ? mono.subarray(0, maxSamples) : mono;
    const wav = encodeWavMono(clipped, TARGET_SR);
    return uploadAsrBlob(wav, safeAsrName(file, '.wav'));
  } catch {
    return null;
  } finally {
    void ctx.close().catch(() => {});
  }
}

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

/**
 * Video path: play (muted, accelerated) + MediaRecorder on audio track only.
 * Does not require full ArrayBuffer of the master — browser demuxes from blob URL.
 */
async function extractViaCapture(file: File): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const mime = pickRecorderMime();
  if (!mime) return null;

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = false;
  video.volume = 0.001; // some engines mute captureStream when volume=0
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('meta timeout')), 12_000);
      video.onloadedmetadata = () => { clearTimeout(t); resolve(); };
      video.onerror = () => { clearTimeout(t); reject(new Error('load failed')); };
    });

    const capture = (
      video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }
    ).captureStream?.() ?? (video as HTMLVideoElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream?.();
    if (!capture) return null;
    const audioTracks = capture.getAudioTracks();
    if (!audioTracks.length) return null;
    const audioOnly = new MediaStream(audioTracks);

    const chunks: Blob[] = [];
    const rec = new MediaRecorder(audioOnly, { mimeType: mime, audioBitsPerSecond: 64_000 });
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.onerror = () => resolve();
    });

    rec.start(500);
    try {
      video.playbackRate = CAPTURE_PLAYBACK_RATE;
    } catch { /* ignore */ }
    await video.play().catch(() => {});

    await new Promise<void>((resolve) => {
      const deadline = Date.now() + MAX_CAPTURE_WALL_MS;
      const tick = () => {
        if (video.ended || video.paused || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(tick, 200);
      };
      video.onended = () => resolve();
      tick();
    });

    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    video.pause();

    if (!chunks.length) return null;
    const blob = new Blob(chunks, { type: mime.split(';')[0] || 'audio/webm' });
    if (blob.size < 256) return null;
    const ext = mime.includes('mp4') ? '.m4a' : mime.includes('ogg') ? '.ogg' : '.webm';
    return uploadAsrBlob(blob, safeAsrName(file, ext));
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Race-ahead: produce a small ASR upload path from a local File, or null.
 * Safe to call in parallel with master upload; never throws.
 */
export async function extractAsrFromFile(file: File, kind: 'video' | 'audio' | string): Promise<string | null> {
  if (kind !== 'video' && kind !== 'audio') return null;
  // Prefer WebAudio for pure audio (fast, accurate).
  if (kind === 'audio' || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(file.name)) {
    const wav = await extractViaWebAudio(file);
    if (wav) return wav;
  }
  // Video (or audio WebAudio failed): try captureStream; then WebAudio as last resort.
  if (kind === 'video') {
    const cap = await extractViaCapture(file);
    if (cap) return cap;
  }
  if (file.size <= MAX_WEBAUDIO_BYTES) {
    return extractViaWebAudio(file);
  }
  return null;
}
