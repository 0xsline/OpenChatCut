import type { AgentToolSchema } from '../../tool-schema';

export const TEMPLATE_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_template',
  description: [
    'A project template packages motion graphics and a design style for reuse across projects.',
    'action: get | list_assets | apply | copy_assets | save.',
    'get without templateId lists saved templates with id/name/asset count; get with templateId returns motion graphics, design-style summary, and asset count.',
    'list_assets with templateId lists bundled media assets by id/name/kind so you can choose reuse versus regeneration; call it before apply.',
    'apply with templateId applies the template to the current project. placement accepts append/replace or exact startFrame, durationInFrames, and targetTrackId. omitAssetIds skips bundled assets and clips that directly reference them.',
    'copy_assets with templateId copies only bundled assets into the current project and returns new project-local asset ids without placing the template timeline.',
    'save with name packages the current project as a template and replaces a template with the same name.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'list_assets', 'apply', 'copy_assets', 'save'] },
      templateId: { type: 'string', description: 'Target template id for get details/list_assets/apply/copy_assets; call get without arguments to list templates first.' },
      placement: {
        description: 'apply: append/replace, or an object specifying start frame, target total duration, and target primary track.',
        oneOf: [
          { type: 'string', enum: ['append', 'replace'] },
          {
            type: 'object',
            properties: {
              startFrame: { type: 'integer', minimum: 0 },
              durationInFrames: { type: 'integer', exclusiveMinimum: 0 },
              targetTrackId: { type: 'string' },
            },
            additionalProperties: false,
          },
        ],
      },
      omitAssetIds: { type: 'array', items: { type: 'string' }, description: 'apply: skip these bundled assets and clips that directly reference them.' },
      name: { type: 'string', description: 'save: required template name; replaces a template with the same name.' },
    },
    required: ['action'],
  },
}];

export const TEMPLATE_TOOL_NAMES = new Set(TEMPLATE_TOOL_SCHEMAS.map((t) => t.name));
