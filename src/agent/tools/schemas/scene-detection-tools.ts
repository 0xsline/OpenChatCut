import type { AgentToolSchema } from '../../tool-schema';

export const SCENE_DETECTION_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'detect_scenes',
  description: [
    'Detect visual scene changes in one source video using local FFmpeg acceleration.',
    'Pass itemId to inspect a timeline clip (trim and speed are mapped correctly), or assetId for a media-pool-only report.',
    'apply=markers creates item-scoped timeline markers; apply=split cuts the clip at every accepted scene boundary as one undoable edit.',
    'Default apply=report. Use threshold 0.2 for sensitive detection, 0.3 balanced, 0.45 conservative.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Timeline video/gif item id (prefix accepted). Required for markers/split.' },
      assetId: { type: 'string', description: 'Media-pool video/gif asset id (prefix accepted). Report only unless itemId is also supplied.' },
      threshold: { type: 'number', description: 'Scene sensitivity threshold 0.05–0.95; lower finds more changes. Default 0.3.' },
      minSceneSeconds: { type: 'number', description: 'Minimum distance between cuts. Default 0.75s.' },
      maxScenes: { type: 'number', description: 'Maximum returned/applied boundaries. Default 200, max 500.' },
      apply: { type: 'string', enum: ['report', 'markers', 'split'], description: 'report (default), markers, or split.' },
    },
  },
}];

export const SCENE_DETECTION_TOOL_NAMES = new Set(SCENE_DETECTION_TOOL_SCHEMAS.map((tool) => tool.name));
