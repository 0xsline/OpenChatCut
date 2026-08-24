import type { AgentToolSchema } from '../../tool-schema';

export const EDIT_ITEM_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'edit_item',
    description:
      'Unified item-level operations across video, image, audio, gif, svg, motion-graphic, text, solid, effect, and transition types. '
      + 'adds place library items (effect/transition/zoom/MG/SFX), a POOL asset as a clip (type=video|image|gif|svg|audio, assetId=…), OR authored clips without assetId: type=text (text/fontSize/color/fontWeight/align?) or type=solid (color?). '
      + 'updates move/trim/retime by itemId|id. Passing assetId on a file-backed clip atomically replaces it from the media pool while preserving item id, track, timeline start, duration, and visual/audio edit state. '
      + 'fromFrame is the canonical timing field (startFrame is accepted as an alias). Unknown fields reject the entire call with "unknown field" + Did you mean. '
      + 'Entries run in adds→updates→deletes order against one private draft; only a fully valid/applied draft is published once. Any validator or draft-apply failure discards it with no partial timeline state. '
      + 'validateOnly runs that same sequential draft without publishing. Mutating calls then go through propose→apply. split_item cuts clips.',
    input_schema: {
      type: 'object',
      properties: {
        adds: {
          type: 'array',
          description:
            'effect: {type,targetItemId,assetId,propertyOverrides?}. transition: {type,assetId,incomingItemId,outgoingItemId?,durationInFrames?}. motion-graphic: {type,assetId:library:motion-graphic:*,track?,fromFrame|startFrame?}. audio SFX: {type:"audio",assetId:library:sound:*,fromFrame?}. POOL media B-roll (video/image/gif/svg/audio): {type,assetId,track|trackId?,fromFrame|startFrame?,durationInFrames?} — no name/props on pool adds (then update_item_props). Source-window add accepts exact frames {sourceStartFrame?,sourceDurationInFrames?} or time bounds {sourceStartMs?,sourceEndMs?,sourceStartSeconds?,sourceEndSeconds?}; use one representation and do not combine it with durationInFrames/srcInFrame. Authored text: {type:"text",text,name?,track?,fromFrame?,durationInFrames?,fontSize?,color?,fontWeight?,align?}. Authored solid: {type:"solid",color?,name?,track?,fromFrame?,durationInFrames?}.',
          items: { type: 'object' },
        },
        updates: {
          type: 'array',
          description:
            'Generic clip update — type MUST be the item\'s actual kind, one of: video, audio, image, gif, svg, text, solid, motion-graphic. NEVER write the literal "generic" or "clip" as type — they are rejected ("update type not supported"). Shape: {type,itemId|id,track|trackId?,fromFrame|startFrame?,durationInFrames?,srcInFrame|sourceStartFrame?,sourceDurationInFrames?,props?,volume?,fadeInSeconds?,fadeOutSeconds?,keyframes?,clearKeyframes?,filters?,transform?,backgroundFill?,backgroundFillStrength?,speed|playbackRate?}. Exact pool replacement: {type,itemId|id,assetId,sourceStartFrame?,sourceDurationInFrames?}; default replacement keeps the original timeline duration and resets the new source in-point to zero. Explicit slip: {operation:"slip",itemId|id,deltaInFrames}; positive moves the source window later, negative earlier, while timeline placement/duration stay fixed. The result reports appliedDeltaInFrames, srcInFrame, sourceWindow, clamped/status, or a structured code for unknown/invalid inputs. '
            + 'Media source ops: {operation:"replace_media",itemId,src} bakes/swaps the clip to a video shell at the same slot; {operation:"relink_media",itemId,src,name?,durationInFrames?,width?,height?} clip-only relink (detaches pool master — use manage_media_pool relink_asset to update pool + all clips). '
            + 'keyframes: {x|y|scale|rotation|opacity|volume:[{frame,value,easing?}]} item-local frames; easing is stored on the left keyframe and controls the following interval. It accepts linear/easeIn/easeOut/easeInOut and CSS aliases ease-in/ease-out/ease-in-out. clearKeyframes:true clears all, or clearKeyframes:"opacity" for one prop. '
            + 'filters: {brightness?,contrast?,saturate? 0..2 (1=normal), blur? 0..30 px} on visual clips. transform: {scale? 0.05..16, x?/y? % of canvas, rotation? deg, opacity? 0..1, borderRadius?}. backgroundFill:true fills unused canvas with a blurred copy; backgroundFillStrength sets an exact integer percentage from 0 to 100 and enables the fill when used alone. Only video/image clips on the bottom video track (V1). speed/playbackRate: 0.1..8 on video/audio/gif (retimes duration). '
            + 'No CSS layout fields (left/right/top/bottom/width/height) — position clips via transform or keyframes x/y; layout INSIDE an MG belongs in its code/props. '
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
          description: 'If true, use the same sequential private draft to validate the entire request, then discard it without publishing.',
        },
        projectId: { type: 'string', description: 'Ignored. The project currently targeted by this agent session is used.' },
      },
      additionalProperties: false,
    },
  },
];

export const EDIT_ITEM_TOOL_NAMES = new Set(EDIT_ITEM_TOOL_SCHEMAS.map((t) => t.name));
