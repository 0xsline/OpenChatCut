import type { AgentContext } from './context';
import { isFailedToolResult } from './toolFailure';

const FRAME_TOOLS = new Set(['view_timeline_frames', 'view_asset_frames']);
const SANDBOX_TOOLS = new Set(['run_code', 'run_skill_script', 'probe_media']);
const FLEX_CROP_KEYS = ['crop', 'flexCrop', 'flexcrop', 'flex_crop'];
/** Safety net only — caption/MG verification still needs a few looks. */
const MAX_FRAME_LOOKS = 6;
const MAX_SUCCESSFUL_CROPS = 1;

interface FlexCropLoopState {
  frameLooks: number;
  attemptedCrops: number;
  successfulCrops: number;
}

const states = new WeakMap<AgentContext, FlexCropLoopState>();

const FLEX_CROP_DONE =
  'Flex crop is finished. Stop and summarize. Do not recheck frames, nibble more pixels, or call run_code/e2b. '
  + 'The user does not need to say "one pass" or "do not recheck" — that is the default. '
  + 'Prior successful edit_item crops still stand.';

const TOO_MANY_LOOKS =
  'Stop inspecting. If this is flex crop / keep-only-region, apply one edit_item transform.crop on the selected clip now, then stop. Do not call run_code.';

function stateOf(ctx: AgentContext): FlexCropLoopState {
  let state = states.get(ctx);
  if (!state) {
    state = { frameLooks: 0, attemptedCrops: 0, successfulCrops: 0 };
    states.set(ctx, state);
  }
  return state;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function transformHasFlexCrop(value: unknown): boolean {
  const transform = asRecord(value);
  if (!transform) return false;
  return FLEX_CROP_KEYS.some((key) => key in transform && transform[key] !== undefined);
}

function entryHasFlexCrop(value: unknown): boolean {
  const entry = asRecord(value);
  if (!entry) return false;
  if (FLEX_CROP_KEYS.some((key) => key in entry && entry[key] !== undefined)) return true;
  return transformHasFlexCrop(entry.transform);
}

function transactionBody(args: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!args) return null;
  if (typeof args.json === 'string') {
    try {
      return asRecord(JSON.parse(args.json));
    } catch {
      return args;
    }
  }
  return asRecord(args.json) ?? args;
}

/** True when this edit_item call sets transform.crop / flexCrop. */
export function editItemHasFlexCrop(args: Record<string, unknown> | undefined): boolean {
  const body = transactionBody(args);
  if (!body) return false;
  if (entryHasFlexCrop(body)) return true;
  for (const bucket of ['updates', 'adds'] as const) {
    const rows = body[bucket];
    if (!Array.isArray(rows)) continue;
    if (rows.some(entryHasFlexCrop)) return true;
  }
  return false;
}

export function flexCropLoopSkipped(note: string): { ok: true; skipped: true; note: string } {
  return { ok: true, skipped: true, note };
}

function inFlexCropJob(state: FlexCropLoopState): boolean {
  return state.successfulCrops > 0 || state.attemptedCrops > 0;
}

/** Skip extra inspect/sandbox/crop so a plain "flex crop the selected clip…" request is one-and-done. */
export function guardFlexCropToolLoop(
  ctx: AgentContext,
  name: string,
  args?: Record<string, unknown>,
): { ok: true; skipped: true; note: string } | null {
  const state = stateOf(ctx);
  if (SANDBOX_TOOLS.has(name) && inFlexCropJob(state)) {
    return flexCropLoopSkipped(FLEX_CROP_DONE);
  }
  if (name === 'edit_item' && editItemHasFlexCrop(args)) {
    if (state.successfulCrops >= MAX_SUCCESSFUL_CROPS) {
      return flexCropLoopSkipped(FLEX_CROP_DONE);
    }
    state.attemptedCrops += 1;
    return null;
  }
  if (!FRAME_TOOLS.has(name)) return null;
  if (state.successfulCrops > 0) {
    return flexCropLoopSkipped(FLEX_CROP_DONE);
  }
  if (state.frameLooks >= MAX_FRAME_LOOKS) {
    return flexCropLoopSkipped(TOO_MANY_LOOKS);
  }
  state.frameLooks += 1;
  return null;
}

export function noteFlexCropToolResult(
  ctx: AgentContext,
  name: string,
  args: Record<string, unknown> | undefined,
  result: unknown,
): void {
  if (name !== 'edit_item' || !editItemHasFlexCrop(args) || isFailedToolResult(result)) return;
  stateOf(ctx).successfulCrops += 1;
}
