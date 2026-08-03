import type { AgentToolSchema } from '../../tool-schema';

const CAPTION_ACTIONS = ['enable', 'disable', 'display_text', 'template', 'style', 'layout', 'layout_policy', 'positions', 'preset_apply', 'preset_delete', 'preset_list', 'preset_rename', 'preset_save', 'bilingual', 'language_mode', 'source_add', 'source_list', 'source_remove', 'source_set', 'source_update', 'track'];

export const CAPTIONS_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'read_captions',
    description: "Read one caption track's state and resolved pages. Pass captionTrackId as C1/C2 or a stable id; omit it for C1. Use list=true to discover every caption track.",
    input_schema: { type: 'object', properties: {
      captionTrackId: { type: 'string', description: 'Caption track alias (C1/C2) or stable id. Defaults to C1.' },
      list: { type: 'boolean', description: 'List caption tracks instead of reading resolved pages.' },
    } },
  },
  {
    name: 'edit_captions',
    description:
      "Manage the captions/subtitles overlay via a single `action`. Read text first only for display_text (use read_captions); every other action is one direct call.\n" +
      "- enable / disable: toggle captions (enable optionally takes a built-in `preset` name).\n" +
      "- template: no arg → list the 21 built-in presets; `templatePreset:\"netflix\"` → apply one (size/position preserved).\n" +
      "- style: custom look via `json` — {font|fontFamily,sizePx|fontSizeRatio|fontSize,color,weight|fontWeight,fontStyle,textAlign|align,underline,strike,letterSpacing,lineHeight,strokeColor,strokeWidth,highlightColor,highlightBackground,shadow|shadowStrength,background|backgroundColor,backgroundOpacity,borderRadius,textTransform,displayMode,wordsPerPage,pacing}. Layered over the current template; unmapped fields are reported in `ignored`. sizePx is relative to CANVAS height — on 9:16 vertical (1080×1920) social captions want sizePx ≥ 86 (≈4.5% of height); leave size unset to keep the template default. pacing: 'phrase' (default, readable pages + karaoke highlight) — only use 'word' when the user explicitly wants single-word pop.\n" +
      "- layout: place the whole block via `json` {preset:\"bottom-center|top-center|center|…3×3\", offsetXRatio, offsetYRatio, scale, rotation, opacity}; transforms may also be nested as `{transforms:{scale,rotation,opacity}}`.\n" +
      "- display_text: per-word DISPLAY overrides via `json` {overrides:[{wordIndex, text, hidden, forcePageBreak}], clearOverrides} — get wordIndex from read_captions; doesn't touch the transcript.\n" +
      "- source_set / source_add / source_remove / source_list: choose which transcribed track(s)/item(s) the captions read (json {mode:\"timeline\"} for all audible, or {sources:[{trackId|itemId}]}).\n" +
      "  Multi-source entries accept a 0-based trackOrder. source_update can move an existing source with {sourceId|index, trackOrder}; source_list returns the normalized visual order.\n" +
      "- language_mode / bilingual: switch caption language — json {mode:\"original|translation|bilingual\", languageCode} (create the translation first with manage_transcript translate).\n" +
      "- track: legacy single-source trackId or internal 0-based trackOrder (prefer source_set for visible text sources).\n" +
      "- layout_policy / positions / source_update: arrange, style, hide, and reorder individual source lanes. preset_* manages user-saved caption styles.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: CAPTION_ACTIONS, description: 'The caption operation to perform.' },
        json: { type: 'string', description: 'JSON payload for the action (style fields, layout, display_text overrides, source scope, language). A JSON string or object.' },
        templatePreset: { type: 'string', description: 'For action=template: built-in preset id/name to apply (omit to list).' },
        preset: { type: 'string', description: 'For action=enable: optional built-in preset name ("auto"/omit = Plain default). For action=template: legacy alias for templatePreset.' },
        trackId: { type: 'string', description: 'For action=track only: source track alias (V1/A1) or id. To choose visible caption text prefer source_set.' },
        trackOrder: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Internal 0-based timeline track order for action=track only. Call action=track with list=true to inspect the exact order.' },
        list: { type: 'boolean', description: 'For action=track: list available source tracks instead of changing the source.' },
        captionTrackId: { type: 'string', description: 'Target caption track alias (C1/C2) or stable id. Defaults to C1.' },
        captionsItemId: { type: 'string', description: 'Legacy alias for captionTrackId.' },
      },
      required: ['action'],
    },
  },
];

export const CAPTIONS_TOOL_NAMES = new Set(CAPTIONS_TOOL_SCHEMAS.map((t) => t.name));
