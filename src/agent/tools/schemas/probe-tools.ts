import type { AgentToolSchema } from '../../tool-schema';

export const PROBE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'probe_media',
    description:
      'Probe a media file with ffprobe in an isolated sandbox. Returns measured duration, dimensions, average fps, stream presence/codecs, plus explicit qualityRisks (low resolution, mono, very short, variable/low frame rate). Accepts a media-pool assetId/prefix, local /media/… path, or public https URL. Use before finalize_uploaded_asset to pass hasAudioTrack and measured fps/duration. The call can fail when the source is unreachable or the e2b sandbox is unavailable; finalize may proceed without it, using ingest defaults.',
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
