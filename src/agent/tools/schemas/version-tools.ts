import type { AgentToolSchema } from '../../tool-schema';

export const VERSION_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_versions',
  description:
    'Named project version history (Version History panel): list checkpoints, save the current project as a named snapshot, '
    + 'restore a snapshot as a whole-project replacement (propose→confirm, same path as undo), or delete a saved version. '
    + 'Versions are milestones across sessions — not the fine-grained undo stack. restore replaces the entire open project.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'save', 'restore', 'delete'],
        description: 'list snapshots; save current doc; restore by versionId; delete a snapshot row.',
      },
      name: {
        type: 'string',
        description: 'save: display name for the checkpoint (e.g. "粗剪完成").',
      },
      versionId: {
        type: 'string',
        description: 'restore/delete: version id or unique prefix from list.',
      },
      confirm: {
        type: 'boolean',
        description:
          'restore: first call without confirm returns needsConfirm summary; resend with confirm:true to applyDoc the snapshot.',
      },
    },
    required: ['action'],
  },
}];

export const VERSION_TOOL_NAMES = new Set(VERSION_TOOL_SCHEMAS.map((tool) => tool.name));
