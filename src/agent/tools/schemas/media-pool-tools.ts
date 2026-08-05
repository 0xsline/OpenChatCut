import type { AgentToolSchema } from '../../tool-schema';

export const MEDIA_POOL_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_media_pool',
  description:
    'Organize the project media pool: list, create/rename/delete empty folders, move assets, rename display names, favorite/unfavorite, delete assets from the pool, or relink an offline/missing master to a new same-origin media path. Folder and metadata actions do not change timeline clips; relink_asset updates the pool asset and every clip that uses that master.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'list',
          'create_folder',
          'rename_folder',
          'delete_empty_folder',
          'move_assets',
          'rename_asset',
          'favorite_assets',
          'unfavorite_assets',
          'delete_assets',
          'relink_asset',
        ],
      },
      assetIds: {
        type: 'string',
        description:
          'Comma-separated asset ids/prefixes/names for move_assets, rename_asset (one id), favorite_assets, unfavorite_assets, delete_assets; relink_asset accepts exactly one id.',
      },
      folderPath: { type: 'string', description: 'Folder path such as Master/B-roll, or folder id prefix.' },
      name: { type: 'string', description: 'New folder name for create_folder; cannot contain /. relink_asset: optional display name for the replacement source.' },
      newName: { type: 'string', description: 'New folder or asset display name for rename actions.' },
      parentPath: { type: 'string', description: 'Parent folder path for create_folder; defaults to Master.' },
      targetPath: { type: 'string', description: 'Destination folder path for move_assets; defaults to Master.' },
      src: {
        type: 'string',
        description:
          'relink_asset: replacement media path (same-origin /media/uploads/… after re-upload, or another reachable project media URL). Prefer re-upload + finalize_uploaded_asset with the same assetId when replacing local files.',
      },
      durationInFrames: { type: 'number', description: 'relink_asset: optional new duration in frames when known.' },
      width: { type: 'number', description: 'relink_asset: optional pixel width.' },
      height: { type: 'number', description: 'relink_asset: optional pixel height.' },
      sourceFilename: { type: 'string', description: 'relink_asset: optional original filename for NLE identity.' },
      confirm: {
        type: 'boolean',
        description:
          'delete_assets: when any selected asset is still referenced by timeline clips, first call returns needsConfirm; resend with confirm:true to delete pool entries only (clips keep their copied media).',
      },
    },
    required: ['action'],
  },
}];

export const MEDIA_POOL_TOOL_NAMES = new Set(MEDIA_POOL_TOOL_SCHEMAS.map((tool) => tool.name));
