import type { AgentToolSchema } from '../../tool-schema';

export const ISOLATE_VOICE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'isolate_voice',
    description:
      'AI Voice Isolation: reduce background noise on a video/audio clip so speech is clearer. ' +
      'action=apply (default) runs an open-box ffmpeg spectral denoise on the clip source and attaches the result as denoisedSrc (master src stays intact; playback uses the isolated track). ' +
      'action=attach points the clip at an existing audio asset after validating denoisedAssetId and sourceAssetId. ' +
      'action=clear removes isolation and restores original audio. ' +
      'strength 0..100 (default 70). Requires /media/uploads source (upload/finalize first).',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Target video/audio clip id (prefix ok).' },
        action: {
          type: 'string',
          enum: ['apply', 'attach', 'clear'],
          description: 'apply = run isolation; attach = use an existing isolated audio asset; clear = detach it.',
        },
        sourceAssetId: {
          type: 'string',
          description: 'attach: source audio/video asset id or unique prefix. It must match the target clip source.',
        },
        denoisedAssetId: {
          type: 'string',
          description: 'attach: existing audio asset id or unique prefix containing the isolated full-source audio.',
        },
        strength: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: 'Denoise strength 0..100 (default 70). Higher = more aggressive NR.',
        },
      },
      required: ['itemId'],
    },
  },
];

export const ISOLATE_VOICE_TOOL_NAMES = new Set(ISOLATE_VOICE_TOOL_SCHEMAS.map((t) => t.name));
