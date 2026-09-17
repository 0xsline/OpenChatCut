const GLOBAL_READ_TOOL_NAMES: Record<string, true> = {
  load_skill: true,
  ToolSearch: true,
};

const READ_ONLY_TOOL_NAMES = new Set([
  'read_timeline', 'list_templates', 'search_templates', 'list_audio',
  'read_script', 'view_timeline_frames', 'view_asset_frames', 'browse_library',
  'read_captions', 'read_project', 'read_transcript', 'find_transcript',
  'search_media', 'search_stock_media', 'search_fonts', 'analyze_music', 'inspect_music', 'music_edit_plan', 'music_image_plan',
  'read_agent_artifact', 'browse_local_media',
]);

const DRAFT_EDIT_TOOL_NAMES = new Set([
  'add_motion_graphic', 'update_item_props', 'move_item', 'set_item_timing',
  'duplicate_item', 'remove_item', 'split_item', 'add_audio', 'clear_timeline',
  'set_aspect_ratio', 'manage_timelines', 'edit_track', 'apply_script',
  'edit_item', 'manage_effects', 'edit_captions', 'update_watermark',
  'manage_markers', 'apply_caption_avoidance', 'place_graphics_in_safe_zone', 'auto_reframe',
  'manage_design_style',
  'import_timeline',
  'export_jianying_draft',
  // Local-path media import lands assets in the session's pool; the file copy
  // itself is a library write, reviewed in offline-tool-authorization.ts.
  'import_asset', 'import_assets', 'import_folder',
]);

const SERVER_DIRECT_READ_TOOL_NAMES: Record<string, true> = {
  read_timeline: true,
  read_agent_artifact: true,
  read_script: true,
  read_captions: true,
  read_project: true,
  read_transcript: true,
  find_transcript: true,
  // Catalog reads: bundled templates, the built-in audio library (plus the
  // project's own audio assets) and the built-in library index. They need the
  // offline editor context to carry those catalogs — server/external-agent/
  // offline-catalogs.ts does, from the same modules the renderer uses.
  list_templates: true,
  search_templates: true,
  list_audio: true,
  browse_library: true,
  // Local media discovery: the same core the desktop app browses with, gated by
  // AGENT_IMPORT_ROOTS like the import tools below.
  browse_local_media: true,
};

const SERVER_DIRECT_EDIT_TOOL_NAMES: Record<string, true> = {
  update_item_props: true,
  move_item: true,
  set_item_timing: true,
  duplicate_item: true,
  remove_item: true,
  split_item: true,
  clear_timeline: true,
  set_aspect_ratio: true,
  manage_timelines: true,
  edit_track: true,
  apply_script: true,
  edit_captions: true,
  update_watermark: true,
  manage_markers: true,
  import_timeline: true,
  // Reviewed for server-side execution: both run against the draft's EditorCore
  // commands with state/doc only. Their GL catalogs import shaders with Vite's
  // `?raw` suffix, which the CLI host now resolves (cli/raw-hooks.mjs) and the
  // desktop bundle resolves through scripts/esbuild-raw-plugin.mjs; the review
  // for these two lives in the commit that added them.
  edit_item: true,
  manage_effects: true,
  // Catalog-driven adds: a bundled template or a built-in audio asset placed on a
  // track through the draft's commands. Plugin-pack templates are not part of the
  // headless catalog, so those adds fail explicitly.
  add_motion_graphic: true,
  add_audio: true,
  // Local-path media import (desktop agent tools until now). Reviewed for
  // headless execution: the importer is the same core the desktop main process
  // runs, it copies into the media library and lands pool assets in the session
  // draft, and reachable paths are gated by the AGENT_IMPORT_ROOTS keystore key.
  import_asset: true,
  import_assets: true,
  import_folder: true,
  // Draft export writes into the CapCut/JianYing store through capcut-cli; it
  // touches no project state, so no draft commit is involved.
  export_jianying_draft: true,
};

const SERVER_DIRECT_BROWSER_ACTIONS: Record<string, true> = {
  preset_apply: true,
  preset_delete: true,
  preset_list: true,
  preset_rename: true,
  preset_save: true,
  bilingual: true,
};

export function isExternalGlobalReadTool(name: string): boolean {
  return GLOBAL_READ_TOOL_NAMES[name] === true;
}

export function isExternalReadTool(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(name);
}

export function isExternalDraftTool(name: string): boolean {
  return isExternalReadTool(name) || DRAFT_EDIT_TOOL_NAMES.has(name);
}

function isOwnedDesignStyleMutation(
  name: string,
  args?: Readonly<Record<string, unknown>>,
): boolean {
  if (name !== 'manage_design_style') return false;
  const action = typeof args?.action === 'string' ? args.action : '';
  return action === 'save'
    || action === 'delete'
    || (action === 'update' && typeof args?.presetId === 'string' && !!args.presetId.trim());
}

/** Data-only tools that can execute against a server-side EditorCore draft.
 * This is intentionally explicit: every newly added tool remains browser-only
 * until its runtime dependencies and side effects are reviewed. */
export function isExternalServerDirectTool(name: string): boolean {
  return SERVER_DIRECT_READ_TOOL_NAMES[name] === true
    || SERVER_DIRECT_EDIT_TOOL_NAMES[name] === true;
}

/** Some otherwise data-only tools multiplex browser-backed actions. */
export function isExternalServerDirectCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  if (!isExternalServerDirectTool(name)) return false;
  if (name !== 'edit_captions') return true;
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  if (SERVER_DIRECT_BROWSER_ACTIONS[action] === true || action === 'bilingual') return false;
  const mode = typeof args.mode === 'string' ? args.mode.trim() : '';
  return action !== 'language_mode' || mode !== 'bilingual';
}

/** Real-project operations (generation, export, import, transcription, analysis
 * writes) — not available in isolated draft sessions; they act on the live
 * project and require a one-shot approval bound to the exact tool args and operation. Every
 * tool outside the draft/global-read whitelist is real: internal and external
 * agents see the same tool surface, only the confirmation gate differs. */
export function isExternalRealTool(
  name: string,
  args?: Readonly<Record<string, unknown>>,
): boolean {
  if (isOwnedDesignStyleMutation(name, args)) return true;
  return !isExternalDraftTool(name) && !isExternalGlobalReadTool(name);
}
