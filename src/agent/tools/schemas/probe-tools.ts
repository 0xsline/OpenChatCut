import type { AgentToolSchema } from '../../tool-schema';

export const PROBE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'probe_media',
    description:
      'Probe a media file with the ffprobe bundled in the app (no sandbox or API key needed). Returns measured duration, dimensions, average fps, stream presence/codecs, plus explicit qualityRisks (low resolution, mono, very short, variable/low frame rate). Accepts a media-pool assetId/prefix, local /media/… path, or public https URL. Use before finalize_uploaded_asset to pass hasAudioTrack and measured fps/duration. download_media/push_asset results already include the same measurements as `probe`, so do not re-probe a file you just imported. It fails only when the source cannot be read; finalize may then proceed with ingest defaults.',
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
