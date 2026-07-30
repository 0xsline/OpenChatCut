import type { AgentToolSchema } from '../../tool-schema';

export const EDIT_ASSET_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'edit_asset',
    description: [
      'Update or delete media-pool assets, not timeline clips; use move_item/remove_item for clips.',
      'action=update changes name or props; code assets such as generated motion graphics may receive new code, which must pass sandbox compilation before any change is saved.',
      'action=delete removes the asset from the media pool. If clips reference it, confirm:true is required; existing clips remain intact because they retain their own code/src.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'delete'] },
        assetId: { type: 'string', description: 'Target asset id or unique prefix.' },
        name: { type: 'string', description: 'update: new display name.' },
        code: { type: 'string', description: 'update: new source for a code asset such as motion graphics; sandbox-validated.' },
        props: { type: 'object', description: 'update: merge into asset props to change defaults.' },
        favorite: { type: 'boolean', description: 'update: favorite flag.' },
        confirm: { type: 'boolean', description: 'delete: confirm deletion when clips still reference the asset (confirmImpact).' },
      },
      required: ['action', 'assetId'],
    },
  },
];

export const EDIT_ASSET_TOOL_NAMES = new Set(EDIT_ASSET_TOOL_SCHEMAS.map((t) => t.name));
