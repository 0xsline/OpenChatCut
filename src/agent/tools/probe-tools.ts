// probe_media runs ffprobe in the e2b sandbox through the existing /e2b/run proxy.
// It reads stream and format metadata to determine audio, fps, duration, dimensions,
// and codec information. The agent probes before
// finalize_uploaded_asset so it can pass an accurate hasAudioTrack — silent / no-audio
// media then skips ASR, and fps/duration are exact.
import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { MediaAsset } from '../../editor/types';

type Args = Record<string, unknown>;

export const PROBE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'probe_media',
    description:
      'Accurately probe a media file with ffprobe in an isolated sandbox. Returns durationSeconds, width, height, fps, hasAudioTrack, hasVideoTrack, and codecs. Accepts a media-pool assetId/prefix, a local /media/… path, or a public https URL. Call this before finalize_uploaded_asset to pass an accurate hasAudioTrack (so silent / no-audio media skips Upload and transcribe ASR) and exact fps/duration. Requires the e2b sandbox; if unavailable you can finalize without it (video defaults to transcribe).',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Media-pool assetId/prefix, a local /media/… path, or a public https:// URL.' },
      },
      required: ['source'],
    },
  },
];

export const PROBE_TOOL_NAMES = new Set(PROBE_TOOL_SCHEMAS.map((t) => t.name));

export interface ProbeResult {
  durationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudioTrack: boolean;
  hasVideoTrack: boolean;
  videoCodec?: string;
  audioCodec?: string;
}

/** ffprobe r_frame_rate is a rational string like "30/1" or "30000/1001" → 30 / 29.97. */
function parseFrameRate(...candidates: unknown[]): number | undefined {
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw.includes('/')) continue;
    const [num, den] = raw.split('/').map(Number);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) continue;
    return Math.round((num / den) * 100) / 100;
  }
  return undefined;
}

/** Normalize an `ffprobe -print_format json -show_streams -show_format` object.
 *  Pure + total (never throws on malformed input) so it's unit-testable offline. */
export function parseProbe(json: unknown): ProbeResult {
  const data = (json ?? {}) as { streams?: unknown[]; format?: { duration?: unknown } };
  const streams = Array.isArray(data.streams) ? (data.streams as Record<string, unknown>[]) : [];
  const audio = streams.find((s) => s?.codec_type === 'audio');
  const video = streams.find((s) => s?.codec_type === 'video');
  const durRaw = data.format?.duration ?? video?.duration ?? audio?.duration;
  const duration = Number(durRaw);
  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    width: typeof video?.width === 'number' ? video.width : undefined,
    height: typeof video?.height === 'number' ? video.height : undefined,
    fps: parseFrameRate(video?.r_frame_rate, video?.avg_frame_rate),
    hasAudioTrack: audio !== undefined,
    hasVideoTrack: video !== undefined,
    videoCodec: typeof video?.codec_name === 'string' ? video.codec_name : undefined,
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : undefined,
  };
}

type ResolvedSource = { url: string; direct: boolean } | { error: string };

// Resolve the tool `source` to a URL for ffprobe. Public https can be probed directly by
// ffprobe; a local /media path must be pulled into the sandbox as an input file (the
// /e2b/run proxy reads it server-side — the sandbox can't reach our dev host).
function resolveSource(ctx: AgentContext, raw: string): ResolvedSource {
  const s = raw.trim();
  if (!s) return { error: 'source is required' };
  if (/^https?:\/\//.test(s)) {
    if (/['"\\]/.test(s)) return { error: 'url must not contain quotes or backslashes' };
    return { url: s, direct: true };
  }
  if (s.startsWith('/media/')) return { url: s, direct: false };
  const assets: MediaAsset[] = ctx.getDoc().assets ?? ctx.getState().assets ?? [];
  const exact = assets.find((a) => a.id === s);
  const hits = exact ? [exact] : assets.filter((a) => a.id.startsWith(s));
  if (hits.length !== 1) return { error: `no unique asset / path / url for "${s}"` };
  const src = hits[0]!.src;
  if (!src) return { error: `asset ${hits[0]!.id} has no media file (e.g. motion-graphic without baked video)` };
  return /^https?:\/\//.test(src) ? { url: src, direct: true } : { url: src, direct: false };
}

export async function execProbeTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'probe_media') return { error: `unknown tool ${name}` };
  const resolved = resolveSource(ctx, String(args.source ?? ''));
  if ('error' in resolved) return resolved;

  const target = resolved.direct ? `'${resolved.url}'` : 'input.media';
  const body = {
    command: `ffprobe -v quiet -print_format json -show_streams -show_format ${target}`,
    files: resolved.direct ? undefined : [{ path: 'input.media', url: resolved.url }],
  };

  let data: Record<string, unknown>;
  try {
    const res = await fetch('/e2b/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return { error: (data.error as string) ?? `probe failed (${res.status})`, hint: 'e2b sandbox may be unconfigured — you can finalize_uploaded_asset without probing (video defaults to transcribe).' };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const exitCode = typeof data.exitCode === 'number' ? data.exitCode : -1;
  if (exitCode !== 0) {
    const stderr = typeof data.stderr === 'string' ? data.stderr.slice(0, 400) : '';
    return { error: `ffprobe exited ${exitCode}`, stderr };
  }
  let probeJson: unknown;
  try {
    probeJson = JSON.parse(typeof data.stdout === 'string' ? data.stdout : '');
  } catch {
    return { error: 'ffprobe produced no JSON', stdout: String(data.stdout ?? '').slice(0, 300) };
  }
  const probe = parseProbe(probeJson);
  return {
    ok: true,
    source: resolved.url,
    ...probe,
    next: probe.hasAudioTrack
      ? `Has audio → finalize_uploaded_asset with hasAudioTrack=true${probe.fps ? `, fps=${probe.fps}` : ''}; Upload and transcribe ASR auto-starts, then track_progress target=transcription.`
      : 'No audio track → finalize_uploaded_asset with hasAudioTrack=false to skip transcription.',
  };
}
