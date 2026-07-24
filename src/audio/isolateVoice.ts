// Shared open-box voice isolation client (POST /api/isolate-voice).
// Used by Inspector, Library audio-fx tab, timeline drag-drop, and agent tool.

export const AUDIO_FX_ISOLATE_DEFAULT = 'library:audio-fx:isolate-voice';
export const AUDIO_FX_ISOLATE_LIGHT = 'library:audio-fx:isolate-voice-light';
export const AUDIO_FX_ISOLATE_STRONG = 'library:audio-fx:isolate-voice-strong';

/** Map library audio-fx id → denoise strength 0..100. */
export function strengthFromAudioFxId(id: string): number {
  if (id === AUDIO_FX_ISOLATE_LIGHT || id.endsWith('-light')) return 35;
  if (id === AUDIO_FX_ISOLATE_STRONG || id.endsWith('-strong')) return 90;
  return 70;
}

export function isIsolateAudioFxId(id: string): boolean {
  return id.startsWith('library:audio-fx:isolate-voice') || id === 'isolate-voice';
}

export interface IsolateVoiceResult {
  path: string;
  bytes?: number;
  engine?: string;
  strength: number;
}

/** Run server denoise; throws Error with message on failure. */
export async function isolateVoiceOnSrc(
  src: string,
  strength = 70,
  opts?: { force?: boolean },
): Promise<IsolateVoiceResult> {
  if (!src.startsWith('/media/uploads/')) {
    throw new Error('Need to be uploaded to the media pool first (/media/uploads）');
  }
  const s = Math.max(0, Math.min(100, strength));
  const res = await fetch('/api/isolate-voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src, strength: s, force: opts?.force === true }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    path?: string;
    error?: string;
    bytes?: number;
    engine?: string;
  };
  if (!res.ok || !data.path) {
    throw new Error(data.error ?? `isolate-voice HTTP ${res.status}`);
  }
  return {
    path: data.path,
    bytes: data.bytes,
    engine: data.engine,
    strength: s,
  };
}
