import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { AgentToolSchema } from './tool-schema';
import { isExternalGlobalReadTool, isExternalReadTool } from './external-tool-policy';
import { effectiveTranscriptionProvider } from './settings/agentSettings';

export type ToolEffect =
  | 'read'
  | 'reversible_edit'
  | 'persistent_local'
  | 'irreversible_external';
export type ToolRecoveryPolicy = 'pure' | 'idempotent' | 'resume' | 'outcome_unknown';
/** Execution classification for recovery and offline authorization; no approval gate. */
export interface ToolExecutionPolicy {
  readonly effect: ToolEffect;
  readonly recovery: ToolRecoveryPolicy;
}
export type ToolInvocationValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly issues: readonly string[] };

const READ_TOOLS = new Set([
  'read_agent_artifact', 'ToolSearch', 'track_progress', 'track_export',
  'inspect_color', 'inspect_music', 'music_edit_plan', 'probe_media',
  'analyze_scene_quality', 'report_user_friction', 'get_editor_url',
]);
const PERSISTENT_LOCAL_TOOLS = new Set([
  'download_media', 'push_asset', 'import_url_asset', 'import_media',
  'finalize_uploaded_asset', 'install_skill', 'run_skill_script',
  'manage_skill', 'manage_template', 'manage_versions', 'manage_project',
  'create_project', 'duplicate_project', 'delete_project', 'restore_project',
]);
const IRREVERSIBLE_EXTERNAL_TOOLS = new Set([
  // paid / long-running / non-idempotent retry surface: generation, export,
  // reruns, paid web scraping, and the paid sandbox. Failed invocations must
  // not be replayed automatically.
  'run_code', 'web_crawl', 'web_browser', 'web_search', 'web_map', 'web_batch_scrape',
  'submit_render_job', 'submit_export', 'export_timeline', 'export_motion_graphic_prores',
  'convert_motion_graphic_to_video',
  'transcribe_track',
  'submit_image', 'submit_video', 'submit_music', 'submit_sound', 'submit_voice',
  'submit_motion_graphic', 'create_motion_graphic', 'create_motion_graphic_from_code',
  'submit_shader', 'rerun_generation',
  'submit_image_generation', 'submit_video_generation', 'submit_music_generation',
  'submit_sound_generation', 'submit_voice_generation',
  'generate_image', 'generate_video', 'generate_music', 'generate_voice', 'generate_sound',
]);
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);
const validatorCache = new WeakMap<object, ValidateFunction>();

function designStylePolicy(args?: Readonly<Record<string, unknown>>): ToolExecutionPolicy {
  const action = typeof args?.action === 'string' ? args.action : '';
  const ownedStyleId = typeof args?.presetId === 'string' ? args.presetId.trim() : '';
  if (action === 'list' || action === 'get' || (action === 'apply' && args?.applyToProject === false)) {
    return { effect: 'read', recovery: 'pure' };
  }
  if (action === 'save' || action === 'delete' || (action === 'update' && !!ownedStyleId)) {
    return { effect: 'persistent_local', recovery: 'idempotent' };
  }
  if (action === 'apply' || action === 'clear' || action === 'update') {
    return { effect: 'reversible_edit', recovery: 'idempotent' };
  }
  return { effect: 'persistent_local', recovery: 'idempotent' };
}
/**
 * Materialize setting-backed defaults after schema validation so persistence
 * and execution bind to the same effective invocation.
 */
export function effectiveToolInvocationArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name !== 'transcribe_track' || args.provider !== undefined) return args;
  return { ...args, provider: effectiveTranscriptionProvider(args) };
}


/** Every callable name receives a conservative execution policy; unknown names still fail active-set validation. */
export function policyForTool(
  name: string,
  args?: Readonly<Record<string, unknown>>,
): ToolExecutionPolicy {
  if (name === 'manage_design_style') return designStylePolicy(args);
  if (READ_TOOLS.has(name) || isExternalReadTool(name) || isExternalGlobalReadTool(name)) {
    return { effect: 'read', recovery: 'pure' };
  }
  if (IRREVERSIBLE_EXTERNAL_TOOLS.has(name)) {
    return { effect: 'irreversible_external', recovery: 'outcome_unknown' };
  }
  if (PERSISTENT_LOCAL_TOOLS.has(name)) {
    return { effect: 'persistent_local', recovery: 'idempotent' };
  }
  return { effect: 'reversible_edit', recovery: 'idempotent' };
}

function schemaValidator(schema: AgentToolSchema): ValidateFunction {
  const key = schema.input_schema as object;
  const cached = validatorCache.get(key);
  if (cached) return cached;
  try {
    const compiled = ajv.compile(schema.input_schema);
    validatorCache.set(key, compiled);
    return compiled;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed JSON schema for tool ${schema.name}: ${detail}`);
  }
}
export function assertValidAgentToolSchemas(catalog: readonly AgentToolSchema[]): void {
  const names = new Set<string>();
  for (const schema of catalog) {
    if (names.has(schema.name)) throw new Error(`Duplicate Agent tool schema: ${schema.name}`);
    names.add(schema.name);
    schemaValidator(schema);
  }
}


function issueText(issue: ErrorObject): string {
  const path = issue.instancePath || '/';
  return `${path} ${issue.message ?? issue.keyword}`.trim();
}

/** Runtime authority check shared by built-in, Codex/API, and connected external adapters. */
export function validateAgentToolInvocation(
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  activeCatalog: readonly AgentToolSchema[],
): ToolInvocationValidation {
  const active = activeCatalog.find((candidate) => candidate.name === schema.name);
  if (!active) {
    return { ok: false, error: `Tool is not active for this request: ${schema.name}`, issues: ['tool is not in the active catalog'] };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: `Invalid arguments for tool ${schema.name}`, issues: ['arguments must be an object'] };
  }
  const validate = schemaValidator(active);
  if (validate(args)) return { ok: true };
  const issues = (validate.errors ?? []).slice(0, 20).map(issueText);
  return {
    ok: false,
    error: `Invalid arguments for tool ${schema.name}: ${issues.join('; ')}`,
    issues,
  };
}
