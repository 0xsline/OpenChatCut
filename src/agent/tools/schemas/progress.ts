import type { AgentToolSchema } from '../../tool-schema';

/** Immutably extend track_progress without importing any progress executors. */
export function withProgressTargets(schemas: AgentToolSchema[]): AgentToolSchema[] {
  return schemas.map((tool) => {
    if (tool.name !== 'track_progress') return tool;
    const properties = (tool.input_schema.properties ?? {}) as Record<string, unknown>;
    return {
      ...tool,
      description: `${tool.description} For target=transcription, poll automatic ingest-time ASR readiness by assetIds instead of jobIds; a succeeded asset then carries a word-level transcript that clips inherit. target=upload checks whether each asset's media file is reachable (blob placeholders report running until relinked to /media/uploads); target=visual-analysis polls contact-sheet warm / frame-readiness jobs (enqueue on ingest; use view_asset_frames / view_timeline_frames for actual vision).`,
      input_schema: {
        ...tool.input_schema,
        properties: {
          ...properties,
          target: { type: 'string', enum: ['generation', 'transcription', 'upload', 'visual-analysis'], description: 'Which async task kind to inspect: generation (default), transcription, upload, or visual-analysis.' },
          assetIds: { type: 'string', description: 'Comma-separated asset IDs/prefixes, for target=transcription / upload / visual-analysis.' },
        },
        required: ['action'],
      },
    };
  });
}
