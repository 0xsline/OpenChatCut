const GLOBAL_READ_TOOL_NAMES: Record<string, true> = {
  load_skill: true,
};

const READ_ONLY_TOOL_NAMES = new Set([
  'read_timeline', 'list_templates', 'search_templates', 'list_audio',
  'read_script', 'view_timeline_frames', 'view_asset_frames', 'browse_library',
  'read_captions', 'read_project', 'read_transcript', 'find_transcript',
  'search_media', 'search_fonts',
]);

const DRAFT_EDIT_TOOL_NAMES = new Set([
  'add_motion_graphic', 'update_item_props', 'move_item', 'set_item_timing',
  'duplicate_item', 'remove_item', 'split_item', 'add_audio', 'clear_timeline',
  'set_aspect_ratio', 'manage_timelines', 'edit_track', 'apply_script',
  'edit_item', 'manage_effects', 'edit_captions', 'update_watermark',
  'manage_markers', 'apply_caption_avoidance', 'place_graphics_in_safe_zone', 'auto_reframe',
]);
export function isExternalGlobalReadTool(name: string): boolean {
  return GLOBAL_READ_TOOL_NAMES[name] === true;
}


export function isExternalReadTool(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(name);
}

export function isExternalDraftTool(name: string): boolean {
  return isExternalReadTool(name) || DRAFT_EDIT_TOOL_NAMES.has(name);
}

/** Real-project operations (generation, export, import, transcription, analysis
 * writes) — not available in isolated draft sessions; they act on the live
 * project and require the user to confirm the first call per session. Every
 * tool outside the draft/global-read whitelist is real: internal and external
 * agents see the same tool surface, only the confirmation gate differs. */
export function isExternalRealTool(name: string): boolean {
  return !isExternalDraftTool(name) && !isExternalGlobalReadTool(name);
}
