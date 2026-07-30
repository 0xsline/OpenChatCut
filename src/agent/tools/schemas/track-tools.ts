import type { AgentToolSchema } from '../../tool-schema';

export const TRACK_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'edit_track',
  description: 'Manage tracks. Actions: list | create | update | delete | tighten. Tracks have stable ids plus C1/C2/V1/A1 aliases that may renumber after insertion. create accepts json with trackType video/audio/caption, optional count/order/name/role/audioRouting. Each caption track owns independent caption data. update changes order/hidden/muted/locked/name/role/audioRouting — locked freezes the lane: clips on a locked track cannot be moved/trimmed/split/deleted/edited and nothing new lands on it. delete removes empty tracks only. tighten closes gaps between media clips.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'tighten'] },
      json: { type: 'string', description: 'JSON payload for create/update, e.g. {"trackType":"audio","role":"follower"} or {"hidden":true}.' },
      trackId: { type: 'string', description: 'Current Cn/Vn/An alias or stable track id (update/delete/tighten).' },
      trackIds: { type: 'array', items: { type: 'string' }, description: 'delete: remove several empty tracks atomically.' },
    },
    required: ['action'],
  },
}];

export const TRACK_TOOL_NAMES = new Set(TRACK_TOOL_SCHEMAS.map((tool) => tool.name));
