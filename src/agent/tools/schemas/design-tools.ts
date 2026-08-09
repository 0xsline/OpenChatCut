import type { AgentToolSchema } from '../../tool-schema';

const COLOR_ROLES = ['primary', 'secondary', 'accent', 'background', 'text'];
const FONT_ROLES = ['heading', 'body'];

export const DESIGN_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_design_style',
  description: [
    'Manage the project design style (brand). The applied style is the project brand and drives the colors and fonts used for motion graphics and captions.',
    'action: list | get | apply | update | clear | save | delete.',
    'list and get are read-only and never need approval; apply/clear and update without presetId change only the reversible ProjectDoc.',
    'apply applies a presetId (built-in or user-saved) or custom designSpec to the project; applyToProject defaults to true.',
    'save, delete, and update with presetId mutate the persistent global “My Style” library and always require a durable confirmation before execution.',
    'save stores designSpec, or the current project style when omitted, in the user library; name is required and scenarios/thumbnailUrl are optional; built-in presets cannot be updated or deleted.',
    'designSpec/patch shape: {colors:[{role,value}], fonts:[{family,role}], styleGuide}.',
    `role is free-form, for example "accent copper", "text secondary", or "Chinese heading". Common color roles: ${COLOR_ROLES.join('/')}; font roles: ${FONT_ROLES.join('/')}; other roles are allowed.`,
    'styleGuide may contain detailed motion, spring, and stagger specifications.',
    'colors/fonts also accept the legacy object form, for example {colors:{primary:"#..."}, fonts:{heading:"Inter"}}; it is normalized to arrays.',
  ].join(' '),
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'apply', 'update', 'clear', 'save', 'delete'] },
      presetId: { type: 'string', description: 'apply/delete: style id from a built-in or user-saved style; call list first.' },
      designSpec: { type: 'string', description: 'apply/save: custom style JSON containing colors/fonts/styleGuide.' },
      patch: { type: 'string', description: 'update: partial JSON containing only fields to change.' },
      applyToProject: { type: 'boolean', description: 'apply: apply to the current project immediately; default true.' },
      name: { type: 'string', description: 'save: required saved-style name; replaces an existing style with the same name.' },
      rename: { type: 'string', description: 'update + presetId: new saved-style name; duplicate names get a numeric suffix.' },
      scenarios: { type: 'array', items: { type: 'string' }, description: 'save/update: scenario tags; an empty array clears them.' },
      scenario: { type: 'string', description: 'list: return only styles containing this scenario tag.' },
      thumbnailUrl: { type: 'string', description: 'save/update: cover URL for the style picker; not used for generation.' },
      clearThumbnail: { type: 'boolean', description: 'update + presetId: clear the cover without deleting the style.' },
    },
    required: ['action'],
  },
}];

export const DESIGN_TOOL_NAMES = new Set(DESIGN_TOOL_SCHEMAS.map((t) => t.name));
