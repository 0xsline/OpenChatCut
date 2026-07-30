import type { AgentToolSchema } from '../../tool-schema';

export const MEDIA_POOL_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_media_pool',
  description: 'Organize the project media pool without changing timeline clips or source files: list, create/rename/delete empty folders, move assets, or rename an asset display name.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create_folder', 'rename_folder', 'delete_empty_folder', 'move_assets', 'rename_asset'] },
      assetIds: { type: 'string', description: 'Comma-separated asset ids/prefixes for move_assets; one asset id/prefix for rename_asset.' },
      folderPath: { type: 'string', description: 'Folder path such as Master/B-roll, or folder id prefix.' },
      name: { type: 'string', description: 'New folder name for create_folder; cannot contain /.' },
      newName: { type: 'string', description: 'New folder or asset display name for rename actions.' },
      parentPath: { type: 'string', description: 'Parent folder path for create_folder; defaults to Master.' },
      targetPath: { type: 'string', description: 'Destination folder path for move_assets; defaults to Master.' },
    },
    required: ['action'],
  },
}];

export const MEDIA_POOL_TOOL_NAMES = new Set(MEDIA_POOL_TOOL_SCHEMAS.map((tool) => tool.name));
