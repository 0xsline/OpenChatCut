import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../context';
import type { Watermark, WatermarkPosition } from '../../editor/types';

// ═══════════════════════════════════════════════════════════════════════════
// 文字水印工具（updateWatermark）
// ---------------------------------------------------------------------------
// updateWatermark 是应用内行为，不是 MCP 工具。水印是通用叠加（品牌/免费档皆可用），
// 默认关，不写死任何假计费逻辑。
//
// 标准三件套。接线（集成方在 tools.ts 做）：
//   import { WATERMARK_TOOL_SCHEMAS, WATERMARK_TOOL_NAMES, execWatermarkTool } from './watermark-tools';
//   ...WATERMARK_TOOL_SCHEMAS
//   if (WATERMARK_TOOL_NAMES.has(name)) return execWatermarkTool(name, args, ctx);
// ═══════════════════════════════════════════════════════════════════════════

type Args = Record<string, unknown>;

const POSITIONS: readonly WatermarkPosition[] = ['tl', 'tr', 'bl', 'br'];

export const WATERMARK_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'update_watermark',
    description:
      'Toggle and configure a text watermark overlay on the active timeline. The watermark is a single label pinned to one corner, rendered in the preview and burned into every export. Pass only the fields you want to change (they merge over the current watermark). Set enabled:false to hide it without losing the text. To make it visible, enable it AND give it non-empty text.',
    input_schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Show (true) or hide (false) the watermark.' },
        text: { type: 'string', description: 'Watermark label text.' },
        position: { type: 'string', enum: ['tl', 'tr', 'bl', 'br'], description: 'Corner: tl=top-left, tr=top-right, bl=bottom-left, br=bottom-right.' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Overlay opacity 0..1 (default 0.7).' },
      },
    },
  },
];

export const WATERMARK_TOOL_NAMES = new Set(WATERMARK_TOOL_SCHEMAS.map((t) => t.name));

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
