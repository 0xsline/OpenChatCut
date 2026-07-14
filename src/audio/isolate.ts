// Client for POST /api/isolate (vite-plugin-isolate) — source isolate_voice apply path.

export interface IsolateResult {
  path: string;
  bytes: number;
  strength: number;
  engine: 'deepfilternet3' | 'ffmpeg-speech-fallback';
  note?: string;
}

export async function isolateVoice(
  mediaPath: string,
  strength = 100,
): Promise<IsolateResult> {
  const r = await fetch('/api/isolate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: mediaPath, strength }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `isolate failed HTTP ${r.status}`);
  return data as IsolateResult;
}
