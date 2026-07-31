import type { AgentToolSchema } from '../../tool-schema';

export const MG_VIDEO_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'convert_motion_graphic_to_video',
    description:
      'Bake a motion-graphic (or any non-audio clip) on the timeline into a real video asset in the media pool, so it can be reused/exported like footage. Renders the clip full-length via the headless renderer. Transparent MG/text/svg clips bake to a VP9 alpha WebM (transparency preserved, via the sandbox) so they composite over other clips; if the sandbox is unavailable it falls back to opaque h264. Raster clips (video/image/gif) bake to opaque h264. Pass opaque:true to force flatten, replace:true to also swap the source clip in place. Identify the clip by itemId (preferred) or assetId.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Timeline clip id (prefix ok) to convert. Preferred.' },
        assetId: { type: 'string', description: 'Fallback: convert the first placed clip that references this asset/template id.' },
        replace: { type: 'boolean', description: 'Also replace the source clip in place with the baked video (default false = only add to media pool).' },
        opaque: { type: 'boolean', description: 'Force an opaque h264 bake even for MG/text/svg (skip the transparent VP9 webm path).' },
      },
    },
  },
  {
    name: 'register_converted_video',
    description:
      'Import a finished MG→video render as a video asset in the media pool — step 2 of the MG→video convert flow. After track_export reports the render complete, call this with the renderId (preferred) to promote the render output into the media pool as a real video asset; the local backend resolves the output itself, no download URL needed. outputUrl is only a fallback when a renderId is unavailable. Returns the video asset id (re-running dedupes to the same asset). Afterwards place the video with edit_item (add a video item referencing the returned videoAssetId).',
    input_schema: {
      type: 'object',
      properties: {
        mgAssetId: { type: 'string', description: 'Source motion-graphic asset id (the mgAssetId of the converted clip).' },
        renderId: { type: 'string', description: 'The convert render id (preferred; pass it once track_export reports the render complete).' },
        outputUrl: { type: 'string', description: 'Raw render output URL — only as a fallback when a renderId is unavailable.' },
        name: { type: 'string', description: 'Display name for the media-pool asset (defaults to "<MG name> (video)").' },
        durationInFrames: { type: 'number', description: 'Duration in frames (defaults to the source MG length if omitted).' },
      },
      required: ['mgAssetId'],
    },
  },
  {
    name: 'export_motion_graphic_prores',
    description:
      'Export motion-graphic clip(s) as transparent ProRes 4444 .mov file(s) (alpha preserved) — the NLE hand-off format, downloaded in the browser. Use before an XML export so the timeline can reference already-rendered MG media. Identify by itemId(s) (preferred) or assetId(s); batch exports each. Unlike convert_motion_graphic_to_video (opaque h264 into the pool), this keeps alpha and downloads a .mov.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'MG timeline item id (prefix ok). Preferred.' },
        itemIds: { type: 'array', items: { type: 'string' }, description: 'Batch: several MG item ids/prefixes.' },
        assetId: { type: 'string', description: 'MG asset id/prefix — exports its first placed timeline instance.' },
        assetIds: { type: 'array', items: { type: 'string' }, description: 'Batch: several MG asset ids/prefixes.' },
        filenameMode: {
          type: 'string',
          enum: ['asset', 'xml'],
          description: 'asset = user-friendly asset-name .mov; xml = mg-<renderKey>.mov for submit_export XML compatibility. Defaults to asset.',
        },
        name: { type: 'string', description: 'Optional base filename (single export); ".mov" is appended.' },
        preferTimelineInstance: {
          type: 'boolean',
          description: 'When assetId is used, export the first timeline instance and its edited properties when present. Defaults to true. Set false to render the media-pool/template defaults.',
        },
        timelineId: { type: 'string', description: 'Optional timeline id/prefix used to resolve item or asset instances without switching timelines.' },
      },
    },
  },
];

export const MG_VIDEO_TOOL_NAMES = new Set(MG_VIDEO_TOOL_SCHEMAS.map((t) => t.name));
