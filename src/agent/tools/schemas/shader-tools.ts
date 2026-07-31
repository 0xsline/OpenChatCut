import type { AgentToolSchema } from '../../tool-schema';

export const SHADER_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'submit_shader',
    description:
      'Generate a custom WebGL fragment shader from a natural-language prompt. type=effect: a per-clip effect (single input u_input) → returns effectId; apply with edit_item adds:[{type:"effect",targetItemId,assetId:<effectId>}]. type=transition: a clip-to-clip transition (two inputs u_outgoing/u_incoming + u_progress) → returns a transitionId (custom:tr-*); apply with edit_item adds:[{type:"transition",assetId:<transitionId>,incomingItemId:<later clip at the cut>}]. Either way the GLSL is statically validated + compile-checked, then registered; this call only submits/registers — applying is a separate call the agent makes after the user explicitly asks. referenceAssetIds lets the generator learn from project assets: image assets are looked at as visual inspiration; ONE effect/transition asset (kind matching type) contributes its shader code as a style reference. Use for one-off custom looks/transitions not in browse_library.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['effect', 'transition'], description: 'Whether the shader is a per-clip effect (color, blur, mask, LUT-style grade, distortion) or a between-clip transition (crossfade, wipe, slide, 3D cube).' },
        prompt: { type: 'string', minLength: 1, description: 'Natural-language description of the shader. Restate the user\'s intent in one concrete sentence — e.g. "Chromatic aberration with RGB split", "Cinematic teal-orange color grade", "Smooth crossfade with soft edge".' },
        name: { type: 'string', description: 'Asset name shown in the library. Defaults to a name derived from the prompt.' },
        referenceAssetIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Project asset ids the generator should learn from. Image asset id → model LOOKS AT it as visual inspiration (e.g. a still to match for a LUT, a screenshot to mimic for a glitch effect). Effect or transition asset id → its shader code is reused as a style reference. At most one effect/transition reference per submit, and its kind must match `type`. Pass full ids or short id prefixes.',
        },
        properties: {
          type: 'array',
          description: 'Optional adjustable numeric uniforms exposed as sliders; each becomes a u_<key> float uniform in the shader. Omit for a fixed effect.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'GLSL identifier; becomes u_<key>.' },
              label: { type: 'string', description: 'zh UI label.' },
              default: { type: 'number' },
              min: { type: 'number' },
              max: { type: 'number' },
              step: { type: 'number' },
            },
            required: ['key'],
          },
        },
      },
      required: ['type', 'prompt'], // `description` remains a legacy runtime alias for prompt.
    },
  },
];

export const SHADER_TOOL_NAMES = new Set(SHADER_TOOL_SCHEMAS.map((t) => t.name));
