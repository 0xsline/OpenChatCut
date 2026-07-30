import type { AgentToolSchema } from '../../tool-schema';

export const PROBE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'probe_media',
    description:
      'Accurately probe a media file with ffprobe in an isolated sandbox. Returns durationSeconds, width, height, fps, hasAudioTrack, hasVideoTrack, and codecs. Accepts a media-pool assetId/prefix, a local /media/… path, or a public https URL. Call this before finalize_uploaded_asset to pass an accurate hasAudioTrack so silent media skips automatic ingest-time ASR, plus exact fps/duration. Requires the e2b sandbox; if unavailable you can finalize without it (video defaults to transcribe).',
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
