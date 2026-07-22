const READ_ONLY_TOOL_NAMES = new Set([
  'read_timeline', 'list_templates', 'search_templates', 'list_audio',
  'read_script', 'view_timeline_frames', 'view_asset_frames', 'browse_library',
  'read_captions', 'read_project', 'read_transcript', 'find_transcript',
  'search_fonts',
]);

const DRAFT_EDIT_TOOL_NAMES = new Set([
  'add_motion_graphic', 'update_item_props', 'move_item', 'set_item_timing',
  'duplicate_item', 'remove_item', 'split_item', 'add_audio', 'clear_timeline',
  'set_aspect_ratio', 'manage_timelines', 'edit_track', 'apply_script',
  'edit_item', 'manage_effects', 'edit_captions', 'update_watermark',
  'manage_markers',
]);

export function isExternalReadTool(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(name);
}

export function isExternalDraftTool(name: string): boolean {
  return isExternalReadTool(name) || DRAFT_EDIT_TOOL_NAMES.has(name);
}
