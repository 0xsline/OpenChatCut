export { PROBE_TOOL_SCHEMAS, PROBE_TOOL_NAMES } from './schemas/probe-tools';
// probe_media runs the app's own ffprobe through POST /api/probe-media (server/plugins/
// probe-media.ts) — no sandbox, no API key. It reads stream and format metadata to
// determine audio, fps, duration, dimensions, and codec information. The agent probes
// before finalize_uploaded_asset so it can pass measured hasAudioTrack/fps/duration
// metadata; transcription remains a separate explicit transcribe_track call.
import type { AgentContext } from '../context';
import type { MediaAsset } from '../../editor/types';

type Args = Record<string, unknown>;

export { parseProbe, type ProbeResult } from '../../../shared/media-probe';
import { parseProbe } from '../../../shared/media-probe';

type ResolvedSource = { url: string } | { error: string };

// Resolve the tool `source` to what the server route accepts: a public http(s) URL or a
// local /media path (the route reads uploads and product assets in place and pulls a URL
// through the SSRF-safe fetch itself).
function resolveSource(ctx: AgentContext, raw: string): ResolvedSource {
  const s = raw.trim();
  if (!s) return { error: 'source is required' };
  if (/^https?:\/\//.test(s) || s.startsWith('/media/')) return { url: s };
  const assets: MediaAsset[] = ctx.getDoc().assets ?? ctx.getState().assets ?? [];
  const exact = assets.find((a) => a.id === s);
  const hits = exact ? [exact] : assets.filter((a) => a.id.startsWith(s));
  if (hits.length !== 1) return { error: `no unique asset / path / url for "${s}"` };
  const src = hits[0]!.src;
  if (!src) return { error: `asset ${hits[0]!.id} has no media file (e.g. motion-graphic without baked video)` };
  return { url: src };
}

export async function execProbeTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'probe_media') return { error: `unknown tool ${name}` };
  const resolved = resolveSource(ctx, String(args.source ?? ''));
  if ('error' in resolved) return resolved;

  let data: Record<string, unknown>;
  try {
    const res = await fetch('/api/probe-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: resolved.url }),
    });
    data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return {
        error: typeof data.error === 'string' ? data.error : `probe failed (${res.status})`,
        hint: 'finalize_uploaded_asset can still commit the upload with ingest defaults; it just will not start transcription.',
      };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const probeJson = data.probe;
  if (!probeJson || typeof probeJson !== 'object') return { error: 'ffprobe produced no JSON' };
  const probe = parseProbe(probeJson);
  return {
    ok: true,
    source: resolved.url,
    ...probe,
    next: probe.hasAudioTrack
      ? `Has audio → finalize_uploaded_asset with the upload response assetType, durationInSeconds, and hasAudioTrack=true${probe.fps ? `, fps=${probe.fps}` : ''}; then invoke transcribe_track if transcription is desired.`
      : 'No audio track → finalize_uploaded_asset with the upload response assetType, durationInSeconds, and hasAudioTrack=false; no transcription will be started.',
  };
}
