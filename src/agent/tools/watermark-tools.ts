export { WATERMARK_TOOL_SCHEMAS, WATERMARK_TOOL_NAMES } from './schemas/watermark-tools';
import type { AgentContext } from '../context';
import type { Watermark, WatermarkPosition } from '../../editor/types';

// ═════════════════════════════════════ ══════════════════════════════════════
// Text watermark tool (updateWatermark)
// --------------------------------------------------------------------------------
// updateWatermark is an in-app behavior, not an MCP tool. The watermark is a universal overlay (available for both branded and free files),
// Off by default, no fake billing logic is programmed.
//
// Standard three-piece set. Wiring (the integrator does it in tools.ts):
// import { WATERMARK_TOOL_SCHEMAS, WATERMARK_TOOL_NAMES, execWatermarkTool } from './watermark-tools';
// ...WATERMARK_TOOL_SCHEMAS
// if (WATERMARK_TOOL_NAMES.has(name)) return execWatermarkTool(name, args, ctx);
// ═════════════════════════════════════ ══════════════════════════════════════

type Args = Record<string, unknown>;

const POSITIONS: readonly WatermarkPosition[] = ['tl', 'tr', 'bl', 'br'];

/** Build a validated patch from untrusted LLM args (unknown/invalid fields dropped). */
function toPatch(args: Args): Partial<Watermark> {
  const patch: Partial<Watermark> = {};
  if (typeof args.enabled === 'boolean') patch.enabled = args.enabled;
  if (typeof args.text === 'string') patch.text = args.text;
  if (typeof args.position === 'string' && POSITIONS.includes(args.position as WatermarkPosition)) {
    patch.position = args.position as WatermarkPosition;
  }
  if (typeof args.opacity === 'number' && Number.isFinite(args.opacity)) {
    patch.opacity = Math.max(0, Math.min(1, args.opacity));
  }
  return patch;
}

/** Execute the watermark tool. Returns a JSON-serializable result, never throws. */
export function execWatermarkTool(name: string, args: Args, ctx: AgentContext): unknown {
  if (name !== 'update_watermark') return { error: `watermark tool not implemented: ${name}` };
  const patch = toPatch(args);
  if (Object.keys(patch).length === 0) {
    return { error: 'provide at least one of enabled, text, position, or opacity' };
  }
  ctx.commands.updateWatermark(patch);
  const watermark = ctx.getState().watermark;
  return {
    ok: true,
    watermark,
    ...(watermark?.enabled && !watermark.text
      ? { warning: 'watermark is enabled but has no text; set text so it renders' }
      : {}),
  };
}
