import type { AgentToolSchema } from '../../tool-schema';

export const EDIT_ITEM_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'edit_item',
    description:
      'Unified item-level operations across video, image, audio, gif, svg, motion-graphic, effect, and transition types. '
      + 'adds place library items (effect/transition/zoom/MG/SFX) OR a POOL asset as a clip (type=video|image|gif|svg|audio, assetId=<pool id/prefix>, trackId|track?, fromFrame|startFrame?, durationInFrames?). '
      + 'updates move/trim/retime by itemId|id — NEVER pass assetId on update (rejected). To replace media: one batch deletes:[{id}] + adds:[{type,assetId,fromFrame,durationInFrames,trackId,…copied layout}]. '
      + 'fromFrame is the canonical timing field (startFrame is accepted as an alias). Unknown fields fail the whole atomic batch with "unknown field" + Did you mean. '
      + 'validateOnly dry-runs. Mutating ops go through propose→apply. split_item cuts clips.',
    input_schema: {
      type: 'object',
      properties: {
        adds: {
          type: 'array',
          description:
            'effect: {type,targetItemId,assetId,propertyOverrides?}. transition: {type,assetId,incomingItemId,outgoingItemId?,durationInFrames?}. motion-graphic: {type,assetId:library:motion-graphic:*,track?,startFrame?}. audio SFX: {type:"audio",assetId:library:sound:*,fromFrame?}. POOL media B-roll (video/image/gif/svg/audio): {type,assetId,track|trackId?,fromFrame|startFrame?,durationInFrames?} — no name/props fields on adds (place first, then set props via update_item_props); fromFrame omitted appends.',
          items: { type: 'object' },
        },
        updates: {
          type: 'array',
          description:
            'Generic clip: {type,itemId|id,track|trackId?,fromFrame|startFrame?,durationInFrames?,srcInFrame?,props?,volume?,fadeInSeconds?,fadeOutSeconds?,keyframes?}. '
            + 'Do NOT set assetId (use deletes+adds to replace media). keyframes: {x|y|scale|rotation|opacity|volume:[{frame,value,easing?}]} item-local frames; x/y are % of canvas in -400..400 (NOT px); volume 0..2 (audio/video only, overrides static volume). '
            + 'No CSS layout fields (left/right/top/bottom/width/height) — position clips via keyframes x/y or transform props; layout INSIDE an MG belongs in its code/props. '
            + 'effect/transition/zoom updates as before (effect assetId swap is for FX stack, not clip media).',
          items: { type: 'object' },
        },
        deletes: {
          type: 'array',
          description:
            'Generic clip: {type,itemId|id,ripple?} (ripple closes the gap). effect: {type:"effect",id|effectId,targetItemId?} or clear with targetItemId only. transition: {type:"transition",id}. zoom: {type:"effect",targetItemId,assetId:"builtin:zoom"}.',
          items: { type: 'object' },
        },
        ripple: {
          type: 'boolean',
          description:
            'When true, MG/audio adds push later same-track items (insert). Do not combine with validateOnly.',
        },
        validateOnly: {
          type: 'boolean',
          description: 'If true, validate only — never mutate. Same validation runs before every real commit.',
        },
        projectId: { type: 'string', description: 'Ignored; the active project is used.' },
      },
    },
  },
];

export const EDIT_ITEM_TOOL_NAMES = new Set(EDIT_ITEM_TOOL_SCHEMAS.map((t) => t.name));
