import type { AgentToolSchema } from '../../tool-schema';

export const PROJECT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'list_projects',
    description: [
      'List OpenChatCut projects this browser owns (id, name, updatedAt, editorUrl), newest first.',
      'Discovery only — does not retarget the editor. Call target_project before editing another project.',
      'Pass includeDeleted=true to also list soft-deleted projects for restore_project.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        editorBaseUrl: { type: 'string', description: 'Origin for returned URLs; defaults to location.origin.' },
        includeDeleted: { type: 'boolean', description: 'Include soft-deleted projects (default false).' },
      },
    },
  },
  {
    name: 'create_project',
    description: [
      'Create a new empty project (one timeline, one video track) and return projectId + editorUrl.',
      'Does not auto-open unless you call target_project with the returned id.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name (default: a localized new-project name).' },
        description: { type: 'string' },
        compositionWidth: { type: 'number', description: 'Default 1920.' },
        compositionHeight: { type: 'number', description: 'Default 1080.' },
        fps: { type: 'number', description: 'Default 30.' },
        editorBaseUrl: { type: 'string' },
      },
    },
  },
  {
    name: 'delete_project',
    description: [
      'Soft-delete a project (same as dashboard delete). Hidden from list_projects; restore with restore_project.',
      'Requires explicit projectId — never defaults to the current project.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Full project id from list_projects or editor URL.' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'restore_project',
    description: 'Restore a soft-deleted project so it reappears in list_projects / dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        editorBaseUrl: { type: 'string' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'duplicate_project',
    description: [
      'Full-copy a project (timelines, assets, captions). Chat history is not copied.',
      'activate=true (default) navigates the editor to the new copy when openProject is available.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Source project id; defaults to current project.' },
        name: { type: 'string', description: 'Copy display name; default "[Copy] <source>".' },
        activate: { type: 'boolean', description: 'Open the copy in the editor (default true).' },
        editorBaseUrl: { type: 'string' },
      },
    },
  },
  {
    name: 'edit_project',
    description: [
      'Update project-level settings or speakers. action=update: change name/description via json {"name"?, "description"?}.',
      'action=speaker-update: project-wide rename/merge a speaker — {from:"A", to:"New name"} relabels every word of that speaker across all transcribed clips in the open project.',
      'speaker-create/speaker-delete are unsupported here (no speaker roster — speakers are per-word diarization labels); use speaker-update to relabel, or manage_transcript fix per clip.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['update', 'speaker-create', 'speaker-update', 'speaker-delete'],
        },
        id: { type: 'string', description: 'Speaker ID (for speaker ops) — the existing diarization label to target (alias of from / json.id).' },
        from: { type: 'string', description: 'speaker-update: existing speaker label to rename (e.g. "A").' },
        to: { type: 'string', description: 'speaker-update: new speaker name.' },
        json: { type: 'string', description: 'update: {name?, description?}. speaker-update also accepts {from,to} here.' },
        projectId: { type: 'string', description: 'Defaults to current project (speaker-update needs the open project).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'target_project',
    description: [
      'Bind the session to an existing project and open it in the editor (hash navigate).',
      'Use after list_projects. Subsequent tools run against the newly opened project after reload.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id or unique prefix from list_projects.' },
        editorBaseUrl: { type: 'string' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_editor_url',
    description: [
      'Return the editor URL for the targeted or given projectId (origin + #/editor/<id>).',
      'Never invent hostnames — uses location.origin or editorBaseUrl.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        editorBaseUrl: { type: 'string' },
        openPricing: { type: 'boolean' },
        pricingSource: { type: 'string' },
      },
    },
  },
];

export const PROJECT_TOOL_NAMES = new Set(PROJECT_TOOL_SCHEMAS.map((t) => t.name));
